import { useEffect, useState } from "react";
import { BoxIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { useAsyncAction } from "../hooks/useAsyncAction";
import type { AgentRecord } from "../types/agent";
import { AgentAvatar } from "./AgentAvatar";
import { PickSelect } from "./agents/controls";
import { Callout } from "./Callout";
import { Combobox } from "./Combobox";
import { CodeWell, EventSection } from "./EventCard";
import { Field } from "./Field";
import { Modal } from "./Modal";
import { withReason } from "@/lib/failure-text";

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
  description?: string | null;
}

// Radix Select items can't carry an empty-string value, so the "no
// explicit pin / no explicit environment" rows use sentinels.
const AGENT_DEFAULT_ENV = "__agent_default__";
const LATEST_VERSION = "latest";

/** Ready-to-paste frontend snippet for a publishable key. Uses the
 *  console's own origin as baseUrl — the public gateway is mounted on the
 *  same host under /public/v1. */
export function deploymentSnippet(key: string): string {
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

/**
 * Show-once key reveal — shared between "deployment created" and "key
 * rotated". The key is never retrievable again after this dialog closes,
 * so the body leads with the warning and pairs the raw key with a
 * drop-in @openma/agent-sdk snippet. Each block has its own copy button.
 */
export function DeploymentKeyReveal({ deploymentKey }: { deploymentKey: string }) {
  const snippet = deploymentSnippet(deploymentKey);
  return (
    <div className="space-y-5">
      <Callout tone="warning" title="Copy this key now">
        It won't be shown again. If you lose it, rotate the deployment's key to get a new one.
      </Callout>
      <EventSection label="Publishable key" copy={deploymentKey}>
        <CodeWell className="py-3 text-small-size break-all select-all">{deploymentKey}</CodeWell>
      </EventSection>
      <EventSection label="Use it from your frontend" copy={snippet}>
        <CodeWell className="max-h-64 whitespace-pre">{snippet}</CodeWell>
      </EventSection>
      <p className="text-xs text-fg-subtle">
        A publishable key is safe to ship in browser code. It can only start and continue sessions with this
        deployment's agent.
      </p>
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
      subtitle="The previous key has stopped working. Update your frontend with this one."
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
 * phase 1 is the form (agent / name / environment / version pin /
 * origins), phase 2 swaps the same modal to the show-once key reveal
 * after the POST succeeds. Shared by DeploymentsList and AgentDetail.
 */
export function CreateDeploymentDialog({
  open,
  onClose,
  initialAgentId,
}: CreateDeploymentDialogProps) {
  const { api } = useApi();
  const queryClient = useQueryClient();

  const [agentId, setAgentId] = useState(initialAgentId ?? "");
  const [agentName, setAgentName] = useState("");
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
    setAgentName("");
    setName("");
    setEnvironmentId(AGENT_DEFAULT_ENV);
    setVersion(LATEST_VERSION);
    setOrigins("");
    setCreatedKey("");
    setError("");
  }, [open, initialAgentId]);

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

  const environments = envsRes?.data ?? [];
  const versions = [...(versionsRes?.data ?? [])].sort((a, b) => b.version - a.version);

  // Comma- or newline-separated origins → string[].
  const originList = origins
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // The gateway compares the browser's Origin header to this list exactly,
  // and an Origin is always scheme://host[:port]. Anything else can never
  // match, so say so before the deployment is created.
  const badOrigins = originList.filter((o) => !/^https?:\/\/[^/\s]+$/i.test(o));

  const create = useAsyncAction(async () => {
    setError("");
    try {
      const body: Record<string, unknown> = { agent_id: agentId };
      if (name.trim()) body.name = name.trim();
      if (environmentId !== AGENT_DEFAULT_ENV) body.environment_id = environmentId;
      if (version !== LATEST_VERSION) body.agent_version = Number(version);
      // Empty → omitted, which the server stores as null (any origin).
      if (originList.length > 0) body.allowed_origins = originList;

      const result = await api<Deployment & { key: string }>("/v1/deployments", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setCreatedKey(result.key);
      void queryClient.invalidateQueries({ queryKey: ["/v1/deployments"] });
    } catch (e) {
      setError(withReason("The deployment was not created", e));
    }
  });

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!create.loading) onClose();
      }}
      title={createdKey ? "Deployment created" : "New deployment"}
      subtitle={
        createdKey
          ? "Your frontend can now talk to this agent directly."
          : "Publish an agent behind a publishable key, so your own frontend can talk to it without a server in between."
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
            <Button onClick={create.run} disabled={!agentId || badOrigins.length > 0} loading={create.loading}>
              Create deployment
            </Button>
          </>
        )
      }
    >
      {createdKey ? (
        <DeploymentKeyReveal deploymentKey={createdKey} />
      ) : (
        <div className="space-y-5">
          {error && (
            <Callout tone="danger" title="The deployment was not created">
              {error}
            </Callout>
          )}

          <Field label="Agent">
            <Combobox<AgentRecord>
              value={agentId}
              onValueChange={(v, item) => {
                setAgentId(v);
                setAgentName(item?.name ?? "");
                setVersion(LATEST_VERSION);
              }}
              endpoint="/v1/agents"
              getValue={(a) => a.id}
              getLabel={(a) => (
                <span className="flex min-w-0 items-center gap-2">
                  <AgentAvatar name={a.name} id={a.id} size="xs" />
                  <span className="truncate">{a.name}</span>
                </span>
              )}
              getTextLabel={(a) => a.name}
              placeholder="Choose an agent"
            />
          </Field>

          <Field label="Name" hint="Optional. Shown in the deployments list.">
            <Input
              id="deploy-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={agentName || "Marketing site chat"}
              autoComplete="off"
            />
          </Field>

          <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2">
            <Field label="Environment">
              <PickSelect
                value={environmentId}
                onValueChange={setEnvironmentId}
                options={[
                  { value: AGENT_DEFAULT_ENV, label: "Agent default", hint: "Whatever the agent is set to use." },
                  ...environments.map((e) => ({
                    value: e.id,
                    label: e.name,
                    hint: e.description ?? undefined,
                    icon: BoxIcon,
                  })),
                ]}
              />
            </Field>
            <Field label="Version">
              <PickSelect
                value={version}
                onValueChange={setVersion}
                disabled={!agentId}
                options={[
                  { value: LATEST_VERSION, label: "Latest", hint: "Follows the agent as it is edited." },
                  ...versions.map((v) => ({
                    value: String(v.version),
                    label: `v${v.version}`,
                    hint: "Pinned. Edits to the agent do not reach this deployment.",
                  })),
                ]}
              />
            </Field>
          </div>

          <Field
            label="Allowed origins"
            hint="One per line. Leave empty to accept requests from any origin."
            error={
              badOrigins.length > 0
                ? `Origins look like https://example.com, with no path or trailing slash. Check: ${badOrigins.join(", ")}`
                : undefined
            }
          >
            <Textarea
              id="deploy-origins"
              value={origins}
              onChange={(e) => setOrigins(e.target.value)}
              className="min-h-[4.5rem] resize-y font-mono text-xs leading-relaxed md:text-xs"
              placeholder={"https://example.com\nhttps://app.example.com"}
              rows={3}
              spellCheck={false}
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}
