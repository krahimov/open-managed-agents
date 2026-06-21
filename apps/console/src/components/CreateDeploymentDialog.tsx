import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "./Modal";
import { Select, SelectOption } from "./Select";
import { Button } from "@/components/ui/button";
import type { AgentRecord } from "../types/agent";

/**
 * Deployment wire shape — `DeploymentRecord` from the management API minus
 * the key hash (see packages/http-routes/src/deployments). The publishable
 * key itself is only present on the create / rotate_key responses.
 */
export interface Deployment {
  id: string;
  name: string;
  agent_id: string;
  /** null → resolve the agent's latest version at session-create time. */
  agent_version: number | null;
  /** null → fall back to the agent's default environment. */
  environment_id: string | null;
  /** First chars of the publishable key, for display (`oma_pk_AbC4`). */
  key_prefix: string;
  /** CORS allowlist. null → `*`. */
  allowed_origins: string[] | null;
  disabled: boolean;
  created_at: string;
  updated_at: string;
}

interface EnvironmentRecord {
  id: string;
  name: string;
}

// Radix Select items can't carry an empty-string value, so the "no
// explicit pin / no explicit environment" rows use sentinels.
const AGENT_DEFAULT_ENV = "__agent_default__";
const LATEST_VERSION = "latest";

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

/** Ready-to-paste frontend snippet for a freshly minted publishable key.
 *  Uses the console's own origin as baseUrl — the public gateway is
 *  mounted on the same host under /public/v1. */
function deploymentSnippet(key: string): string {
  return `import { AgentClient } from "@openma/agent-sdk";

const client = new AgentClient({
  baseUrl: "${window.location.origin}",
  deploymentKey: "${key}",
});

const session = await client.createSession({ title: "Chat" });
for await (const ev of session.chat("Hello!")) {
  if (ev.type === "agent.message_chunk") console.log(ev.delta);
}`;
}

const copy = (text: string, what: string) => {
  void navigator.clipboard.writeText(text);
  toast.success(`${what} copied to clipboard`);
};

/**
 * Show-once key reveal — shared between "deployment created" and "key
 * rotated". The key is never retrievable again after this dialog closes,
 * so the body leads with the warning and pairs the raw key with a
 * drop-in @openma/agent-sdk snippet.
 */
export function DeploymentKeyReveal({ deploymentKey }: { deploymentKey: string }) {
  return (
    <div className="space-y-3">
      <div className="text-sm text-warning bg-warning-subtle border border-warning/30 rounded-lg px-3 py-2">
        Copy this key now — it won't be shown again. If you lose it, rotate
        the deployment to mint a new one.
      </div>
      <div>
        <div className="text-sm text-fg-muted mb-1">Publishable key</div>
        <div className="bg-bg-surface border border-border rounded-lg p-3">
          <code className="text-sm font-mono text-fg break-all select-all">
            {deploymentKey}
          </code>
        </div>
        <button
          onClick={() => copy(deploymentKey, "Key")}
          className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-brand hover:underline"
        >
          Copy key
        </button>
      </div>
      <div>
        <div className="text-sm text-fg-muted mb-1">Use it from your frontend</div>
        <pre className="bg-bg-surface border border-border rounded-lg p-3 text-xs font-mono text-fg-muted leading-relaxed overflow-x-auto">
          {deploymentSnippet(deploymentKey)}
        </pre>
        <button
          onClick={() => copy(deploymentSnippet(deploymentKey), "Snippet")}
          className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-brand hover:underline"
        >
          Copy snippet
        </button>
      </div>
    </div>
  );
}

/** Standalone wrapper for the reveal — used by the rotate-key flow on the
 *  Deployments list, which has no create form to piggyback on. */
export function DeploymentKeyModal({
  open,
  onClose,
  deploymentKey,
  title,
}: {
  open: boolean;
  onClose: () => void;
  deploymentKey: string;
  title: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      maxWidth="max-w-xl"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <DeploymentKeyReveal deploymentKey={deploymentKey} />
    </Modal>
  );
}

interface CreateDeploymentDialogProps {
  open: boolean;
  onClose: () => void;
  /** Pre-select an agent (e.g. the agent detail page's Deploy action). */
  initialAgentId?: string;
}

/**
 * Two-phase create dialog, mirroring ApiKeysList's New API Key modal:
 * phase 1 is the form (agent / environment / name / origins / version
 * pin), phase 2 swaps the same modal to the show-once key reveal after
 * the POST succeeds. Shared by DeploymentsList and AgentDetail.
 */
export function CreateDeploymentDialog({
  open,
  onClose,
  initialAgentId,
}: CreateDeploymentDialogProps) {
  const { api } = useApi();
  const queryClient = useQueryClient();

  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [name, setName] = useState("");
  const [environmentId, setEnvironmentId] = useState(AGENT_DEFAULT_ENV);
  const [version, setVersion] = useState(LATEST_VERSION);
  const [origins, setOrigins] = useState("");
  const [createdKey, setCreatedKey] = useState("");
  const [error, setError] = useState("");

  // Reset to a fresh form every time the dialog opens (and re-seed the
  // pre-selected agent when launched from an agent detail page).
  useEffect(() => {
    if (!open) return;
    setAgentId(initialAgentId ?? "");
    setName("");
    setEnvironmentId(AGENT_DEFAULT_ENV);
    setVersion(LATEST_VERSION);
    setOrigins("");
    setCreatedKey("");
    setError("");
  }, [open, initialAgentId]);

  const { data: agentsRes } = useApiQuery<{ data: AgentRecord[] }>(
    "/v1/agents",
    { limit: "200" },
    { enabled: open },
  );
  const { data: envsRes } = useApiQuery<{ data: EnvironmentRecord[] }>(
    "/v1/environments",
    { limit: "200" },
    { enabled: open },
  );
  // Version pin options come from the selected agent's version history.
  const { data: versionsRes } = useApiQuery<{ data: { version: number }[] }>(
    agentId ? `/v1/agents/${agentId}/versions` : null,
    undefined,
    { enabled: open && !!agentId },
  );

  const agents = agentsRes?.data ?? [];
  const environments = envsRes?.data ?? [];
  const versions = versionsRes?.data ?? [];

  const create = useAsyncAction(async () => {
    setError("");
    try {
      const body: Record<string, unknown> = { agent_id: agentId };
      if (name.trim()) body.name = name.trim();
      if (environmentId !== AGENT_DEFAULT_ENV) body.environment_id = environmentId;
      if (version !== LATEST_VERSION) body.agent_version = Number(version);
      // Comma- or newline-separated origins → string[]. Empty → omitted,
      // which the server stores as null (any origin).
      const originList = origins
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      if (originList.length > 0) body.allowed_origins = originList;

      const result = await api<Deployment & { key: string }>("/v1/deployments", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setCreatedKey(result.key);
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create deployment");
    }
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={createdKey ? "Deployment Created" : "New Deployment"}
      subtitle={
        createdKey
          ? undefined
          : "Publish an agent behind a publishable key (oma_pk_…) for direct frontend access."
      }
      maxWidth="max-w-xl"
      footer={
        createdKey ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={create.loading}>
              Cancel
            </Button>
            <Button
              onClick={create.run}
              disabled={!agentId}
              loading={create.loading}
              loadingLabel="Creating…"
            >
              Create
            </Button>
          </>
        )
      }
    >
      {createdKey ? (
        <DeploymentKeyReveal deploymentKey={createdKey} />
      ) : (
        <div className="space-y-3">
          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <div>
            <label className="text-sm text-fg-muted block mb-1">Agent *</label>
            <Select
              value={agentId}
              onValueChange={(v) => {
                setAgentId(v);
                setVersion(LATEST_VERSION);
              }}
              placeholder="Select an agent…"
            >
              {agents.map((a) => (
                <SelectOption key={a.id} value={a.id}>
                  {a.name}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="deploy-name" className="text-sm text-fg-muted block mb-1">
              Name <span className="text-fg-subtle">(optional, defaults to the agent name)</span>
            </label>
            <input
              id="deploy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className={inputCls}
              placeholder="e.g. Marketing site chat"
            />
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Environment <span className="text-fg-subtle">(optional)</span>
            </label>
            <Select
              value={environmentId}
              onValueChange={setEnvironmentId}
              placeholder="Agent default"
            >
              <SelectOption value={AGENT_DEFAULT_ENV}>Agent default</SelectOption>
              {environments.map((e) => (
                <SelectOption key={e.id} value={e.id}>
                  {e.name}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div>
            <label className="text-sm text-fg-muted block mb-1">
              Version pin <span className="text-fg-subtle">(optional)</span>
            </label>
            <Select
              value={version}
              onValueChange={setVersion}
              placeholder="Latest"
              disabled={!agentId}
            >
              <SelectOption value={LATEST_VERSION}>Latest (follows updates)</SelectOption>
              {versions.map((v) => (
                <SelectOption key={v.version} value={String(v.version)}>
                  v{v.version}
                </SelectOption>
              ))}
            </Select>
          </div>
          <div>
            <label htmlFor="deploy-origins" className="text-sm text-fg-muted block mb-1">
              Allowed origins <span className="text-fg-subtle">(optional, comma or newline separated; blank allows any)</span>
            </label>
            <textarea
              id="deploy-origins"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              className={`${inputCls} min-h-20 font-mono text-xs resize-y`}
              placeholder={"https://example.com\nhttps://app.example.com"}
              rows={3}
            />
          </div>
        </div>
      )}
    </Modal>
  );
}
