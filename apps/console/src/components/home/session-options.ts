import { useCallback, useMemo, useState, type ComponentType } from "react";
import { useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { BrainIcon, FileTextIcon, VariableIcon } from "lucide-react";

import { pickDefaultEnvironmentId, type EnvironmentChoice } from "../../lib/default-environment";
import { useQuietQuery } from "../../lib/useApiQuery";
import { GitHubIcon } from "../icons";
import type { AgentRecord } from "../../types/agent";
import type { DraftOptions } from "./draft";

/**
 * What a session can be started with besides the agent and the first
 * message: where it runs, which vaults it may use, what is mounted into
 * its sandbox, and its title.
 *
 * The state lives in the session starter, not in the popover that edits
 * it, so opening and closing Options never loses a choice (or the message
 * being written next to it). The starter keeps it with the rest of the
 * draft (see ./draft): `snapshot()` is what it stores, `load()` puts a
 * stored draft's options back.
 *
 * The environment and the vaults follow the agent's defaults until the
 * person chooses otherwise, so they are held as "chosen, or not": moving a
 * draft to another agent puts both back to that agent's defaults, while
 * mounted resources and the title are the person's own and stay.
 *
 * An agent with no default environment starts in the workspace's first
 * ordinary environment (`pickDefaultEnvironmentId`), never in a persistent
 * agent computer nobody chose; only when there is none does the person
 * have to choose.
 */

// ── resources ───────────────────────────────────────────────────────────

/** GitHub repo resource. URL + token are required; the rest are optional
 *  knobs that the request either passes through or computes a sensible
 *  default for (mount_path → /workspace/<repo-name>). */
const GithubResourceSchema = z.object({
  kind: z.literal("github"),
  url: z.string().min(1, "Enter the repository URL"),
  token: z.string().min(1, "Enter an authorization token"),
  checkout_type: z.enum(["none", "branch", "commit"]),
  checkout_name: z.string(),
  mount_path: z.string(),
});

const FileResourceSchema = z.object({
  kind: z.literal("file"),
  file_id: z.string(),
  mount_path: z.string(),
});

const MemoryStoreResourceSchema = z.object({
  kind: z.literal("memory_store"),
  memory_store_id: z.string(),
  mount_path: z.string(),
  access: z.enum(["read_write", "read_only"]),
});

const EnvResourceSchema = z.object({
  kind: z.literal("env"),
  name: z.string(),
  value: z.string(),
});

/** Discriminated union: `kind` selects which fields apply. Mapped to the
 *  wire `{type, ...}` resource object when the session is created. */
const ResourceSchema = z.discriminatedUnion("kind", [
  GithubResourceSchema,
  FileResourceSchema,
  MemoryStoreResourceSchema,
  EnvResourceSchema,
]);

/** The part of the options a form edits: the title and the resource rows. */
const OptionsSchema = z.object({
  title: z.string(),
  resources: z.array(ResourceSchema),
});

export type OptionValues = z.infer<typeof OptionsSchema>;
export type ResourceRow = z.infer<typeof ResourceSchema>;
export type ResourceKind = ResourceRow["kind"];

const EMPTY: OptionValues = { title: "", resources: [] };

export function blankResource(kind: ResourceKind): ResourceRow {
  switch (kind) {
    case "github":
      return { kind, url: "", token: "", checkout_type: "none", checkout_name: "", mount_path: "" };
    case "file":
      return { kind, file_id: "", mount_path: "" };
    case "memory_store":
      return { kind, memory_store_id: "", mount_path: "", access: "read_write" };
    case "env":
      return { kind, name: "", value: "" };
  }
}

export const RESOURCE_KINDS: Array<{
  kind: ResourceKind;
  label: string;
  hint: string;
  icon: ComponentType<{ className?: string }>;
}> = [
  { kind: "github", label: "GitHub repository", hint: "Cloned into the workspace", icon: GitHubIcon },
  { kind: "file", label: "File", hint: "One that is already in Files", icon: FileTextIcon },
  { kind: "memory_store", label: "Memory store", hint: "Mounted as a folder", icon: BrainIcon },
  { kind: "env", label: "Environment variable", hint: "A value the sandbox can read", icon: VariableIcon },
];
export const KIND_META = Object.fromEntries(RESOURCE_KINDS.map((k) => [k.kind, k])) as Record<
  ResourceKind,
  (typeof RESOURCE_KINDS)[number]
>;

/** Best-effort `<repo-name>` extraction from GitHub URL forms. Used to
 *  derive the default mount path /workspace/<repo-name>. Returns null when
 *  the URL does not look like GitHub (caller falls back to /workspace). */
function parseGitHubRepoName(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (!trimmed) return null;
  // Full URL: https://github.com/owner/repo
  try {
    const u = new URL(trimmed);
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return null;
    const parts = u.pathname.replace(/^\/+/, "").split("/").filter(Boolean);
    return parts[1] || null;
  } catch {
    // SSH: git@github.com:owner/repo
    const ssh = trimmed.match(/^git@github\.com:[^/]+\/([^/]+)$/);
    if (ssh) return ssh[1];
    // Bare: owner/repo
    const bare = trimmed.match(/^[^/]+\/([^/]+)$/);
    if (bare) return bare[1];
    return null;
  }
}

export function defaultMountPath(githubUrl: string): string {
  const name = parseGitHubRepoName(githubUrl);
  return name ? `/workspace/${name}` : "/workspace";
}

/** The `resources` array of `POST /v1/sessions`, from the rows the person filled in. */
export function resourcesForRequest(rows: ResourceRow[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const r of rows) {
    if (r.kind === "github") {
      // Token is required: validation gates sending on this, but a stale
      // row must not slip through either.
      if (!r.url || !r.token) continue;
      const res: Record<string, unknown> = {
        type: "github_repository",
        url: r.url,
        authorization_token: r.token,
        // Always send mount_path: derive /workspace/<repo-name> from the
        // URL when left blank. Mirrors the in-form preview.
        mount_path: r.mount_path || defaultMountPath(r.url),
      };
      if (r.checkout_type === "branch" && r.checkout_name) res.checkout = { type: "branch", name: r.checkout_name };
      else if (r.checkout_type === "commit" && r.checkout_name) res.checkout = { type: "commit", sha: r.checkout_name };
      out.push(res);
    } else if (r.kind === "file") {
      if (!r.file_id) continue;
      const res: Record<string, unknown> = { type: "file", file_id: r.file_id };
      if (r.mount_path) res.mount_path = r.mount_path;
      out.push(res);
    } else if (r.kind === "memory_store") {
      if (!r.memory_store_id) continue;
      const res: Record<string, unknown> = { type: "memory_store", memory_store_id: r.memory_store_id, access: r.access };
      if (r.mount_path) res.mount_path = r.mount_path;
      out.push(res);
    } else if (r.kind === "env") {
      if (!r.name || !r.value) continue;
      // type=env (was env_secret pre-rename; the server still accepts
      // the legacy alias).
      out.push({ type: "env", name: r.name, value: r.value });
    }
  }
  return out;
}

/** Has the row everything `resourcesForRequest` needs to mount it? */
export function resourceComplete(r: ResourceRow): boolean {
  switch (r.kind) {
    case "github":
      return !!r.url.trim() && !!r.token.trim();
    case "file":
      return !!r.file_id;
    case "memory_store":
      return !!r.memory_store_id;
    case "env":
      return !!r.name.trim() && !!r.value;
  }
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

// ── the hook ────────────────────────────────────────────────────────────

export function useSessionOptions(
  agent: AgentRecord | undefined,
  /** Start in this environment whatever the agent's default is (an
   *  environment's "Start session here"). It stays when the agent changes. */
  pinnedEnvironmentId?: string,
  /** The options of the draft the starter opens with. */
  initial?: DraftOptions | null,
) {
  // Cast addresses a workspace zod version skew: the resolver's bundled
  // .d.ts resolves `zod/v4/core` to the root install (currently 4.3.x)
  // while console's own zod is 4.4.x. Both are wire-compatible at
  // runtime; only the structural type guard on _zod.version trips.
  const resolver = useMemo(() => zodResolver(OptionsSchema as never) as Resolver<OptionValues>, []);
  const form = useForm<OptionValues>({
    resolver,
    defaultValues: initial ? { title: initial.title, resources: initial.resources } : EMPTY,
    mode: "onChange",
  });
  const resources = useFieldArray({ control: form.control, name: "resources" });
  const { trigger } = form;

  // What the person chose for this session. Null follows the agent.
  const [chosenEnvironment, setChosenEnvironment] = useState<string | null>(initial?.environment_id ?? null);
  const [chosenVaults, setChosenVaults] = useState<string[] | null>(initial?.vault_ids ?? null);

  const defaultEnvironmentId = agent?._oma?.default_environment_id ?? "";
  const defaultVaultIds = useMemo(() => agent?._oma?.default_vault_ids ?? [], [agent]);
  // An agent bound to a connected machine runs there: no sandbox to choose.
  const localRuntime = !!agent?._oma?.runtime_binding;

  // Without a default of the agent's own (and nothing chosen or pinned), the
  // first ordinary environment applies. Read only when it is needed.
  const needsFallback = !!agent && !localRuntime && !defaultEnvironmentId && !pinnedEnvironmentId && !chosenEnvironment;
  const environmentsQuery = useQuietQuery<{ data: EnvironmentChoice[] }>("/v1/environments?limit=100", needsFallback);
  const fallbackEnvironmentId = needsFallback ? pickDefaultEnvironmentId(environmentsQuery.data?.data ?? []) : "";
  const fallbackPending = needsFallback && environmentsQuery.isPending;
  /** What applies when nothing is chosen: the agent's default, else the fallback. */
  const baseEnvironmentId = defaultEnvironmentId || fallbackEnvironmentId;

  const values = form.watch();
  const environmentId = localRuntime ? "" : chosenEnvironment || pinnedEnvironmentId || baseEnvironmentId;
  const vaultIds = chosenVaults ?? defaultVaultIds;
  // Said only once the fallback is known, so the warning does not flash.
  const environmentMissing = !!agent && !localRuntime && !environmentId && !fallbackPending;
  const environmentChanged = !localRuntime && !!environmentId && environmentId !== baseEnvironmentId;
  /** The session will run in the first ordinary environment because the
   *  agent has no default of its own. */
  const environmentIsFallback = !localRuntime && !!environmentId && !defaultEnvironmentId && environmentId === fallbackEnvironmentId;
  const vaultsChanged = !sameSet(vaultIds, defaultVaultIds);
  const title = values.title.trim();
  /** How many things differ from what the agent would do on its own. */
  const changes = (environmentChanged ? 1 : 0) + (vaultsChanged ? 1 : 0) + values.resources.length + (title ? 1 : 0);
  /** A resource row is missing something it needs (a repository without a
   *  token, a file row with no file chosen). It would not be mounted, so the
   *  session is not started until the row is finished or removed. */
  const resourcesInvalid = values.resources.some((r) => !resourceComplete(r));

  const setEnvironment = useCallback((id: string) => setChosenEnvironment(id || null), []);
  const toggleVault = (id: string) =>
    setChosenVaults(vaultIds.includes(id) ? vaultIds.filter((v) => v !== id) : [...vaultIds, id]);

  /** Put a draft's options in place (null: nothing chosen). */
  const load = useCallback(
    (next: DraftOptions | null) => {
      form.reset(next ? { title: next.title, resources: next.resources } : EMPTY);
      setChosenEnvironment(next?.environment_id ?? null);
      setChosenVaults(next?.vault_ids ?? null);
      void trigger();
    },
    [form, trigger],
  );
  /** The agent changed under what is written: its own environment and vaults apply again. */
  const followAgent = useCallback(() => {
    setChosenEnvironment(null);
    setChosenVaults(null);
  }, []);
  const reset = () => load(null);

  /** What the draft keeps: a choice equal to the agent's default is not a choice. */
  const snapshot = (): DraftOptions => {
    const v = form.getValues();
    return {
      environment_id: environmentChanged ? environmentId : null,
      // Until the agent is known its defaults are not, so a choice is kept as made.
      vault_ids: chosenVaults && (!agent || vaultsChanged) ? [...chosenVaults] : null,
      title: v.title,
      resources: v.resources,
    };
  };

  /** The body of `POST /v1/sessions`, without the agent and with the title only when one was typed. */
  const requestBody = (): Record<string, unknown> => {
    const v = form.getValues();
    const body: Record<string, unknown> = {};
    // Only send environment_id when one applies. For local-runtime agents
    // there is none and the server picks its fallback.
    if (environmentId) body.environment_id = environmentId;
    if (vaultIds.length > 0) body.vault_ids = vaultIds;
    const mounted = resourcesForRequest(v.resources);
    if (mounted.length > 0) body.resources = mounted;
    if (v.title.trim()) body.title = v.title.trim();
    return body;
  };

  return {
    form,
    resources,
    values,
    localRuntime,
    defaultEnvironmentId,
    defaultVaultIds,
    pinnedEnvironmentId,
    environmentId,
    vaultIds,
    environmentMissing,
    environmentChanged,
    environmentIsFallback,
    vaultsChanged,
    title,
    changes,
    resourcesInvalid,
    /** Nothing here stops the session from starting. */
    ready: !environmentMissing && !fallbackPending && !resourcesInvalid,
    setEnvironment,
    toggleVault,
    load,
    followAgent,
    reset,
    snapshot,
    requestBody,
  };
}

export type SessionOptions = ReturnType<typeof useSessionOptions>;
