import { useEffect, useId, useMemo, useRef, type ReactNode } from "react";
import { useQueries } from "@tanstack/react-query";
import { Controller } from "react-hook-form";
import { ArrowUpRightIcon, LaptopIcon, PlusIcon, SlidersHorizontalIcon, XIcon } from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useApi } from "@/lib/api";
import { plural } from "@/lib/format";
import { useQuietQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { quietLink } from "@/lib/links";

import type { AgentRecord } from "../../types/agent";
import { EntityAvatar } from "../AgentAvatar";
import { Chip } from "../Badge";
import { Callout } from "../Callout";
import { Field, onLabelClick } from "../Field";
import { SecretInput } from "../Input";
import { Select, SelectOption } from "../Select";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { EnvironmentPicker, useEnvironmentName } from "./EnvironmentPicker";
import { MCP_REGISTRY } from "../../lib/mcp-registry";
import { serverInfo } from "../sessions/tools";
import { LookupProblem } from "./LookupProblem";
import { blankResource, defaultMountPath, KIND_META, RESOURCE_KINDS, type SessionOptions } from "./session-options";

/**
 * Options for the session being started: where it runs, which vaults it may
 * use, what is mounted into its sandbox, and its title.
 *
 *   <Collapsible open={open} onOpenChange={setOpen}>
 *     <div>… <SessionOptionsTrigger options={options} /> …</div>
 *     <SessionOptionsPanel options={options} agent={agent} onClose={() => setOpen(false)} />
 *   </Collapsible>
 *
 * A pill in the composer's tool row opens the panel in place, directly
 * under the composer: it takes room in the page (what is below moves down,
 * with the same short expand every disclosure uses) and never floats over
 * other content. In the New session dialog the dialog grows with it and
 * scrolls inside when the window is short. Nothing here navigates: the
 * message being written and its attachments stay exactly as they are, and
 * every choice is kept when it closes (the state is `useSessionOptions`,
 * owned by the starter). The pill counts what differs from the agent's own
 * defaults, so a choice made here stays visible.
 *
 * Every lookup the panel makes (environments, the chosen environment's
 * name, vaults, the apps each vault covers, files, memory stores) has four
 * states and shows each one: loading, loaded with items, loaded and empty,
 * and could not be loaded, with "Try again" in place. A failed lookup is
 * never drawn as an empty one, and a warning that depends on a lookup
 * ("this app has no credential") only appears when that lookup succeeded.
 */

interface VaultPick {
  id: string;
  name: string;
  archived_at?: string | null;
}
interface FilePick {
  id: string;
  filename: string;
  size_bytes: number;
}
interface MemoryStorePick {
  id: string;
  name: string;
}
function formatBytes(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** A link that leaves the page opens beside it, so the draft is not lost. */
/**
 * An app the agent uses, by name: the name the agent gives the server
 * ("linear", "slack" read as "Linear", "Slack"), else the registry's name
 * for its address, else its host (`mcp.example.com`) when nothing names it.
 */
function appLabel(app: { url: string; name?: string }, host: string): string {
  const named = app.name?.trim();
  if (named && !/^https?:|[./]/.test(named)) return serverInfo(named).label;
  const known = MCP_REGISTRY.find((r) => {
    try {
      return new URL(r.url).hostname === host;
    } catch {
      return false;
    }
  });
  return known?.name ?? named ?? host;
}

function AsideLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <a
      href={to}
      target="_blank"
      rel="noreferrer"
      className={cn(quietLink, "inline-flex items-center gap-0.5 text-xs")}
    >
      {children}
      <ArrowUpRightIcon className="size-3" aria-hidden="true" />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

/**
 * A heading over one part of the panel. `htmlFor`: the heading is also the
 * label of the one control under it (a click on it reaches that control,
 * and it is that control's name), as a <Field> label would be.
 */
function Group({
  label,
  htmlFor,
  action,
  children,
  className,
}: {
  label: string;
  htmlFor?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section className={className} aria-labelledby={id}>
      <div className="mb-2 flex min-h-6 items-center justify-between gap-3">
        <h3 id={id} className="text-xs font-medium text-fg-subtle">
          {htmlFor ? (
            <label htmlFor={htmlFor} onClick={onLabelClick}>
              {label}
            </label>
          ) : (
            label
          )}
        </h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * A field whose choices are looked up. It shows the lookup as it is: being
 * read (a placeholder the size of the control), failed (what could not be
 * loaded, with "Try again" in place), read and empty (the control, disabled,
 * with `emptyHint` saying how something gets there), or read with choices.
 * `gone`: the value chosen earlier is not among them any more.
 */
function Lookup({
  label,
  query,
  what,
  empty,
  emptyHint,
  gone,
  goneError,
  children,
}: {
  label: string;
  query: { isLoading: boolean; error: unknown; refetch: () => unknown };
  /** Plural noun for the failure line: "Files could not be loaded". */
  what: string;
  empty: boolean;
  emptyHint: ReactNode;
  gone?: boolean;
  goneError?: string;
  children: ReactNode;
}) {
  if (query.isLoading || query.error) {
    return (
      <div>
        <p className="mb-1.5 block text-small leading-5 font-medium text-fg">{label}</p>
        {query.isLoading ? (
          <div role="status">
            <Skeleton className="h-9 w-full" rounded="md" />
            <span className="sr-only">Loading {what.toLowerCase()}</span>
          </div>
        ) : (
          <LookupProblem what={what} error={query.error} retry={() => query.refetch()} />
        )}
      </div>
    );
  }
  return (
    <Field label={label} hint={empty ? emptyHint : undefined} error={!empty && gone ? goneError : undefined}>
      {children}
    </Field>
  );
}

/** The pill in the composer's tool row. Lives inside the starter's <Collapsible>. */
export function SessionOptionsTrigger({ options, disabled }: { options: SessionOptions; disabled?: boolean }) {
  const needsChoice = options.environmentMissing;
  return (
    <Tip label="Environment, vaults, resources and title">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={
            needsChoice
              ? "Session options: choose an environment"
              : options.changes > 0
                ? `Session options, ${plural(options.changes, "change")} from this agent's defaults`
                : "Session options"
          }
          className={cn(
            "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-small font-medium transition-quick disabled:pointer-events-none disabled:opacity-50",
            needsChoice
              ? "border border-dashed border-warning/60 text-warning hover:bg-warning-subtle aria-expanded:bg-warning-subtle"
              : "text-fg-muted hover:bg-bg-hover hover:text-fg aria-expanded:bg-bg-hover aria-expanded:text-fg",
          )}
        >
          <SlidersHorizontalIcon className="size-4 stroke-[1.75]" />
          <span className={cn(!needsChoice && "max-sm:sr-only")}>{needsChoice ? "Choose an environment" : "Options"}</span>
          {!needsChoice && options.changes > 0 && (
            <span
              aria-hidden="true"
              className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-ink px-1 text-micro leading-none font-semibold text-on-ink"
            >
              {options.changes}
            </span>
          )}
        </button>
      </CollapsibleTrigger>
    </Tip>
  );
}

/**
 * The panel itself, in the page under the composer it belongs to. Done and
 * Escape close it and hand the focus to `onClosed` (the message); the pill
 * closes it too and keeps the focus. Escape inside the panel, or on the pill
 * while it is open, closes the panel only, not a dialog it sits in, as it
 * did when the panel was a layer.
 */
export function SessionOptionsPanel({
  options,
  agent,
  onClose,
  onClosed,
  onStartEmpty,
  startEmptyDisabled,
}: {
  options: SessionOptions;
  agent: AgentRecord | undefined;
  onClose: () => void;
  /** The panel was closed with Done or Escape and focus is being handed
   *  back. Take it here to put it somewhere better than the Options button.
   *  Not called when the pill closed it: the pill keeps the focus. */
  onClosed?: () => void;
  /** Start the session with these options and no first message. Offered while the box is empty. */
  onStartEmpty?: () => void;
  startEmptyDisabled?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const close = useRef<() => void>(() => {});
  close.current = () => {
    onClose();
    onClosed?.();
  };

  // Escape while the focus is in the panel (not in a list it opened, which
  // lives outside it and closes first), or on the Options pill that opened
  // it (a click leaves the focus there). Heard before any dialog around it,
  // so a New session dialog stays open and only the panel closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const el = ref.current;
      if (!el || !(e.target instanceof Element)) return;
      const controls = e.target.closest("[aria-controls]")?.getAttribute("aria-controls");
      const onPill = !!controls && !!document.getElementById(controls)?.contains(el);
      if (!el.contains(e.target) && !onPill) return;
      e.preventDefault();
      e.stopPropagation();
      close.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Opened by something that went away (a "Mount this file" button): the
  // focus would be lost on the page, so it moves to the panel.
  useEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body) ref.current?.focus({ preventScroll: true });
  }, []);

  /** Once open, as much of the panel is brought into view as fits without
   *  scrolling the message box above it out of sight (Home at a short
   *  height; the dialog's own scroll). */
  const reveal = () => {
    const el = ref.current;
    if (!el) return;
    let scroller = el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    const panel = el.getBoundingClientRect();
    // The message box is the panel's previous sibling's container: the top of the collapsible's parent.
    const anchor = el.closest("[data-slot=collapsible]")?.getBoundingClientRect() ?? panel;
    const margin = 16;
    const down = Math.min(panel.bottom + margin - box.bottom, anchor.top - margin - box.top);
    if (down <= 0) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    scroller.scrollBy({ top: down, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <CollapsibleContent
      className="collapsible-content -mx-3 overflow-hidden px-3 pb-3"
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.currentTarget.dataset.state === "open") reveal();
      }}
    >
      <section
        ref={ref}
        tabIndex={-1}
        aria-label="Session options"
        className="@container mt-3 rounded-2xl border border-border bg-bg-surface shadow-[var(--shadow-sm)] outline-none"
      >
        <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
          <div className="min-w-0">
            <h2 className="text-h3 text-fg">Session options</h2>
            <p className="mt-0.5 text-xs text-fg-subtle">
              {options.changes > 0
                ? `${plural(options.changes, "change")} from ${agent?.name ?? "this agent"}'s defaults, for this session only.`
                : `${agent?.name ?? "This agent"}'s defaults. Anything you change applies to this session only.`}
            </p>
          </div>
          {options.changes > 0 && (
            <Button variant="ghost" size="xs" onClick={options.reset} className="-mr-1.5 shrink-0">
              Reset
            </Button>
          )}
        </header>
        <div className="px-5 pt-1 pb-5">
          <OptionsBody options={options} agent={agent} />
        </div>
        <footer className="flex items-center justify-between gap-3 rounded-b-2xl border-t border-border bg-bg-inset/60 px-5 py-3">
          {onStartEmpty ? (
            <Tip label="Create the session now and write the first message there">
              <Button variant="ghost" size="sm" className="-ml-2.5" onClick={onStartEmpty} disabled={startEmptyDisabled}>
                Start without a message
              </Button>
            </Tip>
          ) : (
            <span className="text-xs text-fg-subtle">Your message stays in the box above.</span>
          )}
          <Button variant="secondary" size="sm" onClick={() => close.current()}>
            Done
          </Button>
        </footer>
      </section>
    </CollapsibleContent>
  );
}

function OptionsBody({ options, agent }: { options: SessionOptions; agent: AgentRecord | undefined }) {
  const { api } = useApi();
  const uid = useId();
  const { form, resources, values } = options;
  const { control, register, setValue, formState } = form;
  const vaultIds = options.vaultIds;

  // What the pickers offer. Read when the popover first opens, then cached.
  const vaultsQuery = useQuietQuery<{ data: VaultPick[] }>("/v1/vaults?limit=200");
  const filesQuery = useQuietQuery<{ data: FilePick[] }>("/v1/files?limit=200", values.resources.some((r) => r.kind === "file"));
  const storesQuery = useQuietQuery<{ data: MemoryStorePick[] }>(
    "/v1/memory_stores",
    values.resources.some((r) => r.kind === "memory_store"),
  );
  const environmentName = useEnvironmentName(options.localRuntime ? null : options.environmentId);
  const vaults = useMemo(
    () => (vaultsQuery.data?.data ?? []).filter((v) => !v.archived_at || vaultIds.includes(v.id)),
    [vaultsQuery.data, vaultIds],
  );
  const files = filesQuery.data?.data ?? [];
  const memoryStores = storesQuery.data?.data ?? [];

  // Which apps each chosen vault holds a credential for. The outbound proxy
  // matches a credential to an app by hostname, so the comparison below
  // does too. One read per chosen vault; a read that fails stays failed
  // (never "holds nothing") until it is tried again.
  const credentialQueries = useQueries({
    queries: vaultIds.map((id) => ({
      queryKey: ["quiet", `/v1/vaults/${id}/credentials`],
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        api<{ data: Array<{ auth?: { mcp_server_url?: string } }> }>(`/v1/vaults/${id}/credentials`, {
          signal,
          silentErrors: true,
        }),
      retry: false,
      staleTime: 60_000,
    })),
  });
  const coverage = new Map<string, { state: "loading" } | { state: "failed" } | { state: "known"; hosts: Set<string> }>();
  vaultIds.forEach((id, i) => {
    const q = credentialQueries[i];
    if (q?.data) {
      const hosts = new Set<string>();
      for (const cred of q.data.data ?? []) {
        const url = cred.auth?.mcp_server_url;
        if (!url) continue;
        try {
          hosts.add(new URL(url).hostname);
        } catch {
          /* not a URL */
        }
      }
      coverage.set(id, { state: "known", hosts });
    } else coverage.set(id, { state: q?.error ? "failed" : "loading" });
  });
  const unchecked = vaultIds.filter((id) => coverage.get(id)?.state === "failed");
  const retryCoverage = () => {
    vaultIds.forEach((id, i) => {
      if (coverage.get(id)?.state === "failed") void credentialQueries[i]?.refetch();
    });
  };

  // Apps the agent uses that no chosen vault has a credential for: it would
  // call them unauthenticated and fail mid-conversation. Only said when every
  // chosen vault was read: a vault that could not be checked may cover them.
  // Each app is named the way the rest of the console names it (the name
  // the agent gives the server, or the registry's), its address on hover.
  const uncovered: Array<{ url: string; host: string; label: string }> = [];
  const apps = ((agent?.mcp_servers ?? []) as Array<{ url?: string; name?: string }>).filter(
    (s): s is { url: string; name?: string } => typeof s.url === "string" && s.url.length > 0,
  );
  if (apps.length > 0 && vaultIds.every((id) => coverage.get(id)?.state === "known")) {
    const covered = new Set<string>();
    for (const id of vaultIds) {
      const c = coverage.get(id);
      if (c?.state === "known") for (const h of c.hosts) covered.add(h);
    }
    for (const app of apps) {
      try {
        const host = new URL(app.url).hostname;
        if (!covered.has(host)) uncovered.push({ url: app.url, host, label: appLabel(app, host) });
      } catch {
        /* not a URL */
      }
    }
  }

  // The proxy uses the FIRST declared GitHub repository's token for any
  // request that does not carry an owner/repo slug (GraphQL, /user,
  // /search…). Only say so when there are two or more.
  const githubIdxs = resources.fields.map((r, i) => (r.kind === "github" ? i : -1)).filter((i) => i >= 0);
  const firstGithubIdx = githubIdxs[0] ?? -1;
  const showPrimaryHint = githubIdxs.length > 1;

  // The discriminated union narrows `errors.resources[i]` to nothing, so
  // per-kind fields need a runtime-friendly lookup. An error shows once
  // the field was touched.
  const resourceError = (idx: number, key: string): string | undefined => {
    const row = formState.errors.resources?.[idx] as Record<string, { message?: string } | undefined> | undefined;
    const touched = formState.touchedFields.resources?.[idx] as Record<string, boolean | undefined> | undefined;
    return touched?.[key] ? row?.[key]?.message : undefined;
  };

  const environmentError = options.environmentMissing
    ? "Choose where this session runs."
    : environmentName.missing
      ? "This environment no longer exists. Choose another one."
      : undefined;
  const environmentHint: ReactNode = environmentName.failed ? (
    // The name lookup failed: say so, here, instead of leaving a spinner or an id.
    <>
      This environment's name could not be loaded.{" "}
      <button type="button" className={quietLink} onClick={() => void environmentName.refetch()}>
        Try again
      </button>
    </>
  ) : options.pinnedEnvironmentId ? (
    options.environmentId === options.pinnedEnvironmentId ? (
      "The environment you started from. It stays if you change the agent."
    ) : undefined
  ) : options.environmentMissing || options.environmentChanged ? undefined : options.environmentIsFallback ? (
    `The first environment in this workspace. ${agent?.name ?? "This agent"} has no default of its own.`
  ) : (
    `${agent?.name ?? "This agent"}'s default environment.`
  );

  return (
    <div className="grid gap-x-6 gap-y-5 @[34rem]:grid-cols-2">
      <div className="space-y-5">
        {/* The environment is where a cloud sandbox comes from. Agents on a
            local runtime run on the person's machine and never touch one. */}
        <Group
          label="Runs in"
          htmlFor={options.localRuntime ? undefined : `${uid}-environment`}
          action={
            options.environmentChanged && options.defaultEnvironmentId && !options.pinnedEnvironmentId ? (
              <button
                type="button"
                onClick={() => options.setEnvironment(options.defaultEnvironmentId)}
                className={cn(quietLink, "text-xs")}
              >
                Use the agent's default
              </button>
            ) : undefined
          }
        >
          {options.localRuntime ? (
            <Callout icon={LaptopIcon} title="A connected machine">
              This agent uses the files and tools of its local runtime, so it does not need a cloud environment.
            </Callout>
          ) : (
            <Field hint={environmentHint} error={environmentError}>
              <EnvironmentPicker
                id={`${uid}-environment`}
                value={options.environmentId}
                onChange={options.setEnvironment}
                name={environmentName}
              />
            </Field>
          )}
        </Group>

        <Group label="Title" htmlFor={`${uid}-title`}>
          {/* An unrecognised name plus autoComplete=off keeps browsers from
              offering a saved email in a field they take for a login. The
              field is controlled because the form finds a registered input
              by its name, and this one does not wear the form's. */}
          <Controller
            control={control}
            name="title"
            render={({ field }) => (
              <Input
                ref={field.ref}
                value={field.value}
                onChange={(e) => field.onChange(e.target.value)}
                onBlur={field.onBlur}
                id={`${uid}-title`}
                name="oma-session-title"
                autoComplete="off"
                data-1p-ignore
                placeholder="Named after your first line"
              />
            )}
          />
        </Group>
        <Group
          label="Resources"
          action={
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="xs">
                  <PlusIcon data-icon="inline-start" />
                  Add
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                {RESOURCE_KINDS.map((k) => (
                  <DropdownMenuItem key={k.kind} onSelect={() => resources.append(blankResource(k.kind))} className="items-start gap-2.5 py-2">
                    <k.icon className="mt-0.5 size-4 text-fg-muted" />
                    <span className="min-w-0">
                      <span className="block font-medium text-fg">{k.label}</span>
                      <span className="block text-xs text-fg-subtle">{k.hint}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        >
          {resources.fields.length === 0 ? (
            <p className="rounded-lg bg-bg-soft px-3.5 py-2.5 text-small text-fg-muted">
              Nothing mounted. Add a repository, a file, a memory store or an environment variable for the sandbox.
            </p>
          ) : (
            <div className="space-y-2.5">
              {resources.fields.map((field, i) => {
                // register() drives input state; conditional rendering
                // (kind-specific blocks, placeholders) reads the watched copy.
                const live = values.resources[i];
                if (!live) return null;
                const meta = KIND_META[live.kind];
                return (
                  <div key={field.id} className="animate-rise-in rounded-lg border border-border p-3.5">
                    <div className="mb-3 flex items-center gap-2.5">
                      <EntityAvatar icon={meta.icon} size="sm" />
                      <span className="text-small font-medium text-fg">{meta.label}</span>
                      {showPrimaryHint && live.kind === "github" && i === firstGithubIdx && (
                        <Tip label="This repository's token is used for GitHub API calls that do not target one repository (GraphQL, search, /user).">
                          <span>
                            <Chip tone="outline">Primary</Chip>
                          </span>
                        </Tip>
                      )}
                      <Tip label="Remove">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`Remove ${meta.label.toLowerCase()}`}
                          className="-mr-1.5 ml-auto"
                          onClick={() => resources.remove(i)}
                        >
                          <XIcon />
                        </Button>
                      </Tip>
                    </div>

                    {live.kind === "github" && (
                      <div className="space-y-3.5">
                        <Field label="Repository URL" error={resourceError(i, "url")}>
                          <Input {...register(`resources.${i}.url`)} autoComplete="off" placeholder="https://github.com/owner/repo" />
                        </Field>
                        <Field label="Authorization token" hint="A GitHub token that can read the repository." error={resourceError(i, "token")}>
                          <SecretInput {...register(`resources.${i}.token`)} placeholder="ghp_…" />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                          {/* The field sits inside render: a <Controller> would drop what <Field> hands its control. */}
                          <Controller
                            control={control}
                            name={`resources.${i}.checkout_type`}
                            render={({ field: f }) => (
                              <Field label="Check out">
                                <Select
                                  value={f.value}
                                  onValueChange={(v) => {
                                    f.onChange(v);
                                    // Switching the kind clears the companion
                                    // name so the placeholder cannot mislead.
                                    setValue(`resources.${i}.checkout_name`, "");
                                  }}
                                  placeholder="Check out"
                                >
                                  <SelectOption value="none">Default branch</SelectOption>
                                  <SelectOption value="branch">A branch</SelectOption>
                                  <SelectOption value="commit">A commit</SelectOption>
                                </Select>
                              </Field>
                            )}
                          />
                          <Field label={live.checkout_type === "commit" ? "Commit SHA" : "Branch name"}>
                            <Input
                              {...register(`resources.${i}.checkout_name`)}
                              autoComplete="off"
                              disabled={live.checkout_type === "none"}
                              className={live.checkout_type === "none" ? undefined : "font-mono"}
                              placeholder={live.checkout_type === "commit" ? "abc1234" : live.checkout_type === "branch" ? "main" : "Not needed"}
                            />
                          </Field>
                        </div>
                        <Field label="Mount path" hint="Optional. Where the repository appears in the sandbox.">
                          <Input
                            {...register(`resources.${i}.mount_path`)}
                            autoComplete="off"
                            className="font-mono"
                            placeholder={defaultMountPath(live.url)}
                          />
                        </Field>
                      </div>
                    )}

                    {live.kind === "file" && (
                      <div className="space-y-3.5">
                        <Controller
                          control={control}
                          name={`resources.${i}.file_id`}
                          render={({ field: f }) => (
                            <Lookup
                              label="File"
                              query={filesQuery}
                              what="Files"
                              empty={files.length === 0}
                              emptyHint={
                                <>
                                  Nothing to mount yet: <AsideLink to="/files">Files</AsideLink> is empty. A file gets there when an agent
                                  saves its work, when it is attached to a message, or when it is uploaded on the Files page.
                                </>
                              }
                              gone={!!live.file_id && !files.some((f) => f.id === live.file_id)}
                              goneError="The file chosen here is no longer in Files. Choose another one."
                            >
                              <Select value={f.value} onValueChange={f.onChange} placeholder="Choose a file" disabled={files.length === 0}>
                                {files.map((file) => (
                                  <SelectOption key={file.id} value={file.id}>
                                    {file.filename}
                                    <span className="ml-2 text-xs text-fg-subtle">{formatBytes(file.size_bytes)}</span>
                                  </SelectOption>
                                ))}
                              </Select>
                            </Lookup>
                          )}
                        />
                        <Field label="Mount path" hint="Optional. Defaults to a path under /mnt/session/uploads.">
                          <Input
                            {...register(`resources.${i}.mount_path`)}
                            autoComplete="off"
                            className="font-mono"
                            placeholder="/mnt/session/uploads/…"
                          />
                        </Field>
                      </div>
                    )}

                    {live.kind === "memory_store" && (
                      <div className="space-y-3.5">
                        <div className="grid grid-cols-[minmax(0,1fr)_150px] gap-3">
                          <Controller
                            control={control}
                            name={`resources.${i}.memory_store_id`}
                            render={({ field: f }) => (
                              <Lookup
                                label="Memory store"
                                query={storesQuery}
                                what="Memory stores"
                                empty={memoryStores.length === 0}
                                emptyHint={
                                  <>
                                    No memory stores yet. Create one in <AsideLink to="/memory">Memory</AsideLink>.
                                  </>
                                }
                                gone={!!live.memory_store_id && !memoryStores.some((m) => m.id === live.memory_store_id)}
                                goneError="The store chosen here no longer exists. Choose another one."
                              >
                                <Select value={f.value} onValueChange={f.onChange} placeholder="Choose a store" disabled={memoryStores.length === 0}>
                                  {memoryStores.map((m) => (
                                    <SelectOption key={m.id} value={m.id}>
                                      {m.name}
                                    </SelectOption>
                                  ))}
                                </Select>
                              </Lookup>
                            )}
                          />
                          <Controller
                            control={control}
                            name={`resources.${i}.access`}
                            render={({ field: f }) => (
                              <Field label="Access">
                                <Select value={f.value} onValueChange={f.onChange} placeholder="Access">
                                  <SelectOption value="read_write">Read and write</SelectOption>
                                  <SelectOption value="read_only">Read only</SelectOption>
                                </Select>
                              </Field>
                            )}
                          />
                        </div>
                        <Field label="Mount path" hint="Optional. Defaults to a folder under /mnt/memory.">
                          <Input {...register(`resources.${i}.mount_path`)} autoComplete="off" className="font-mono" placeholder="/mnt/memory/…" />
                        </Field>
                      </div>
                    )}

                    {live.kind === "env" && (
                      <div className="grid grid-cols-2 gap-3">
                        <Field label="Name">
                          <Input {...register(`resources.${i}.name`)} autoComplete="off" className="font-mono" placeholder="API_BASE_URL" />
                        </Field>
                        <Field label="Value">
                          <SecretInput {...register(`resources.${i}.value`)} placeholder="Value" />
                        </Field>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </Group>
      </div>

      <Group label="Vaults" action={<AsideLink to="/vaults">Manage vaults</AsideLink>}>
        {vaultsQuery.isLoading ? (
          <div className="space-y-0.5 rounded-lg bg-bg-soft p-1" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex h-10 items-center gap-3 px-2.5">
                <Skeleton className="size-6" rounded="md" />
                <Skeleton className="h-3.5" rounded="sm" style={{ width: `${52 - i * 9}%` }} />
              </div>
            ))}
          </div>
        ) : vaultsQuery.error ? (
          <LookupProblem what="Vaults" error={vaultsQuery.error} retry={() => vaultsQuery.refetch()} />
        ) : vaults.length === 0 ? (
          <p className="rounded-lg bg-bg-soft px-3.5 py-2.5 text-small text-fg-muted">
            No vaults yet. A vault gives agents credentials for other services.
          </p>
        ) : (
          <ul className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg bg-bg-soft p-1">
            {vaults.map((v) => {
              const checked = vaultIds.includes(v.id);
              const covers = coverage.get(v.id);
              return (
                <li key={v.id}>
                  <label
                    className={cn(
                      "flex h-10 cursor-pointer items-center gap-2.5 rounded-md px-2.5 transition-quick hover:bg-bg-hover",
                      checked && "bg-bg-surface shadow-[var(--shadow-xs)] hover:bg-bg-surface dark:bg-bg-pressed dark:hover:bg-bg-pressed",
                    )}
                  >
                    <EntityAvatar icon={VaultIcon} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={v.name}>
                      {v.name}
                    </span>
                    {/* What the vault covers: being read, read, or not readable. Never "No apps" for a read that failed. */}
                    {checked && covers?.state === "loading" && (
                      <span className="shrink-0" role="status">
                        <Skeleton className="h-3 w-10" rounded="sm" />
                        <span className="sr-only">Checking which apps it covers</span>
                      </span>
                    )}
                    {checked && covers?.state === "known" && (
                      <span className="shrink-0 text-xs text-fg-subtle">
                        {covers.hosts.size > 0 ? plural(covers.hosts.size, "app") : "No apps"}
                      </span>
                    )}
                    {checked && covers?.state === "failed" && <span className="shrink-0 text-xs text-fg-subtle">Not checked</span>}
                    <Checkbox checked={checked} onCheckedChange={() => options.toggleVault(v.id)} aria-label={`Use ${v.name}`} />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
        {unchecked.length > 0 && !vaultsQuery.error && (
          // A vault's credentials could not be read, so nothing is claimed about what is covered.
          <Callout
            className="mt-2.5"
            title={
              unchecked.length === 1
                ? "One vault's credentials could not be read"
                : `${unchecked.length} vaults' credentials could not be read`
            }
          >
            So this panel cannot tell whether every app this agent uses has a credential. The session can still be started.
            {/* Under the words, not beside them: the column is narrow, and a button
                at the side would squeeze the sentence into a ribbon. */}
            <span className="mt-2 block">
              <Button variant="outline" size="xs" onClick={retryCoverage}>
                Try again
              </Button>
            </span>
          </Callout>
        )}
        {uncovered.length > 0 && (
          <Callout
            tone="warning"
            className="mt-2.5"
            title={
              uncovered.length === 1
                ? "One of this agent's apps has no credential in these vaults"
                : `${uncovered.length} of this agent's apps have no credential in these vaults`
            }
          >
            <span className="mt-1 flex flex-wrap gap-1.5">
              {uncovered.map((s) => (
                <Chip key={s.url} mono={s.label === s.host} tone="outline" title={s.url}>
                  {s.label}
                </Chip>
              ))}
            </span>
            <span className="mt-2 block">
              {uncovered.length === 1
                ? "The agent would call it without signing in and fail partway through. Choose a vault that holds a credential for it."
                : "The agent would call them without signing in and fail partway through. Choose a vault that holds a credential for each."}
            </span>
          </Callout>
        )}
      </Group>

    </div>
  );
}
