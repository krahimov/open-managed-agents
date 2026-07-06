import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useParams, Link, useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { GitHubIcon, LinearIcon, SlackIcon } from "../components/icons";
import { Page } from "../components/Page";
import { Modal } from "../components/Modal";
import { Field } from "../components/Field";
import { PageHeader } from "../components/PageHeader";
import { CreateDeploymentDialog } from "../components/CreateDeploymentDialog";
import { Button } from "@/components/ui/button";
import type { AgentRecord as Agent } from "../types/agent";
import { AmbientTriggerControls } from "../components/AmbientTriggerControls";
import {
  COMPOSIO_MANAGED_AGENT_INTEGRATIONS,
  composioIntegrationIcon,
} from "../lib/composio-integrations";
import {
  AMBIENT_WAKE_MODES,
  buildAmbientTrigger,
  buildBudget,
  buildDecisionPolicy,
  createDefaultAmbientTriggerDraft,
  scheduleSummary,
  type AmbientBudgetPreset,
  type AmbientDecisionPreset,
  type AmbientTriggerSource,
  type AmbientWakeMode,
} from "../lib/ambient-controls";

/** Shared publication shape across Linear / GitHub / Slack — they all
 *  expose the same id / status / mode / persona / workspace_name fields. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

interface AmbientRule {
  type: "ambient_rule";
  id: string;
  agent_id: string;
  name: string;
  description?: string;
  enabled: boolean;
  trigger: { source: AmbientTriggerSource; config?: Record<string, unknown> };
  wake_mode: AmbientWakeMode;
  decision_policy?: Record<string, unknown>;
  budget?: Record<string, unknown>;
  created_at: string;
  updated_at?: string;
  next_wake_at?: string;
  last_wake_at?: string;
  last_decision?: { outcome: string; reason?: string; decided_at: string; session_id?: string };
}

export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);

  // Single-resource fetches via TQ. `enabled: !!id` defers until the route
  // param is available; the publication queries inherit the same gate.
  // Each query runs independently — failures on the publication endpoints
  // (404 / not-installed) don't block the agent detail render, same as
  // the previous behavior where each had its own .catch.
  const enabled = !!id;
  const { data: agent, error: agentError } = useApiQuery<Agent>(
    id ? `/v1/agents/${id}` : null,
    undefined,
    { enabled },
  );
  const { data: versionsRes } = useApiQuery<{ data: Agent[] }>(
    id ? `/v1/agents/${id}/versions` : null,
    undefined,
    { enabled },
  );
  // Reverse-lookup publications per provider. Each endpoint exists thanks
  // to the /linear/agents/:id/publications + /slack/agents/:id/publications
  // + /github/agents/:id/publications routes added on the main worker.
  const { data: linearRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/linear/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: githubRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/github/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );
  const { data: slackRes } = useApiQuery<{ data: Pub[] }>(
    id ? `/v1/integrations/slack/agents/${id}/publications` : null,
    undefined,
    { enabled },
  );

  const ambientRulesPath = id ? `/v1/agents/${id}/ambient-rules` : null;
  const { data: ambientRulesRes } = useApiQuery<{ data: AmbientRule[] }>(
    ambientRulesPath,
    undefined,
    { enabled },
  );

  const versions = versionsRes?.data ?? [];
  // Filter to live publications only — same predicate the old useEffect ran.
  const linearPubs = useMemo(
    () => (linearRes?.data ?? []).filter((p) => p.status === "live"),
    [linearRes],
  );
  const githubPubs = useMemo(
    () => (githubRes?.data ?? []).filter((p) => p.status === "live"),
    [githubRes],
  );
  const slackPubs = useMemo(
    () => (slackRes?.data ?? []).filter((p) => p.status === "live"),
    [slackRes],
  );

  const error = agentError instanceof Error ? agentError.message : agentError ? String(agentError) : "";

  const modelStr = (m: Agent["model"]) => typeof m === "string" ? m : `${m?.id} (${m?.speed || "standard"})`;
  const composioToolkits = Array.isArray(agent?.metadata?.composio_toolkits)
    ? agent.metadata.composio_toolkits.filter((id): id is string => typeof id === "string")
    : [];
  const composioApps = composioToolkits.map((slug) => {
    const known = COMPOSIO_MANAGED_AGENT_INTEGRATIONS.find((entry) => entry.slug === slug);
    return known ?? {
      slug,
      name: slug,
      category: "App",
      description: "",
      domain: "composio.dev",
    };
  });

  const archive = async () => {
    if (!confirm("Archive this agent?")) return;
    await api(`/v1/agents/${id}/archive`, { method: "POST", body: "{}" });
    nav("/agents");
  };

  const del = async () => {
    if (!confirm("Delete this agent? This cannot be undone.")) return;
    await api(`/v1/agents/${id}`, { method: "DELETE" });
    nav("/agents");
  };

  if (error) return <div className="p-10 text-danger">Error: {error}</div>;
  if (!agent) return <div className="p-10 text-fg-subtle">Loading...</div>;

  return (
    <Page
      header={
        <PageHeader
          title={agent.name}
          actions={
            <>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => nav(`/sessions?new=1&agent_id=${encodeURIComponent(agent.id)}`)}
              >
                Start session
              </Button>
              <Button variant="outline" size="sm" onClick={() => setShowDeploy(true)}>
                Deploy
              </Button>
              <Button variant="outline" size="sm" onClick={archive}>
                Archive
              </Button>
              <Button variant="destructive" size="sm" onClick={del}>
                Delete
              </Button>
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        {editing && (
          <EditAgentModal agent={agent} onClose={() => setEditing(false)} />
        )}
        {/* Properties grid */}
        <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 max-w-2xl text-sm">
          <span className="text-fg-muted">ID</span><span className="font-mono text-xs">{agent.id}</span>
          <span className="text-fg-muted">Model</span><span>{modelStr(agent.model)}</span>
          <span className="text-fg-muted">Harness</span><span>{agent._oma?.harness || "default"}</span>
          {agent._oma?.default_environment_id && (
            <>
              <span className="text-fg-muted">Default Sandbox</span>
              <span className="font-mono text-xs">{agent._oma.default_environment_id}</span>
            </>
          )}
          {agent._oma?.default_vault_ids && agent._oma.default_vault_ids.length > 0 && (
            <>
              <span className="text-fg-muted">Default Vaults</span>
              <span className="font-mono text-xs">{agent._oma.default_vault_ids.join(", ")}</span>
            </>
          )}
          {agent._oma?.runtime_binding && (
            <>
              <span className="text-fg-muted">Local Runtime</span>
              <span className="text-xs">
                <span className="font-mono">{agent._oma.runtime_binding.runtime_id.slice(0, 8)}…</span>
                <span className="text-fg-subtle"> · ACP agent: </span>
                <span className="font-mono">{agent._oma.runtime_binding.acp_agent_id}</span>
              </span>
            </>
          )}
          <span className="text-fg-muted">Version</span><span>v{agent.version}</span>
          <span className="text-fg-muted">Tools</span>
          <span>{(agent.tools || []).map((t: any) => t.type === "custom" ? `Custom: ${t.name}` : t.type).join(", ") || "None"}</span>
          <span className="text-fg-muted">Created</span><span>{new Date(agent.created_at).toLocaleString()}</span>
          <span className="text-fg-muted">Updated</span><span>{new Date(agent.updated_at || agent.created_at).toLocaleString()}</span>
          {agent.archived_at && <><span className="text-fg-muted">Archived</span><span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span></>}
        </div>

      {/* Integrations — one fold per provider so adding a 4th / 5th doesn't
          push the rest of the page below the viewport. Default-open when
          there's at least one live publication so the user sees what's wired
          up at a glance; otherwise default-closed. */}
      <div className="mt-6 max-w-2xl">
        <h2 className="font-display text-base font-semibold mb-2">Integrations</h2>
        {composioApps.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 mb-3">
            {composioApps.map((entry) => (
              <div
                key={entry.slug}
                className="border border-border rounded-md p-3 flex items-center gap-3 bg-bg"
              >
                <img
                  src={composioIntegrationIcon(entry)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                  className="w-6 h-6 rounded shrink-0"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
                <div className="min-w-0">
                  <div className="font-medium text-sm text-fg truncate">{entry.name}</div>
                  <div className="text-xs text-fg-subtle">{entry.category}</div>
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="space-y-2">
          <IntegrationFold
            kind="linear"
            label="Linear"
            icon={<LinearIcon className="w-4 h-4" />}
            pubs={linearPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="github"
            label="GitHub"
            icon={<GitHubIcon className="w-4 h-4" />}
            pubs={githubPubs}
            agentId={agent.id}
          />
          <IntegrationFold
            kind="slack"
            label="Slack"
            icon={<SlackIcon className="w-4 h-4" />}
            pubs={slackPubs}
            agentId={agent.id}
          />
        </div>
      </div>

      <AmbientRulesPanel
        agentId={agent.id}
        rules={ambientRulesRes?.data ?? []}
      />

      {/* System prompt */}
      {agent.system && (
        <div className="mt-8 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">System Prompt</h2>
          <pre className="bg-bg-surface border border-border rounded-lg p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto font-mono text-fg-muted leading-relaxed">
            {agent.system}
          </pre>
        </div>
      )}

      {/* Version history */}
      {versions.length > 0 && (
        <div className="mt-8 max-w-2xl">
          <h2 className="font-display text-base font-semibold mb-2">Version History</h2>
          <div className="border border-border rounded-lg overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase">
                  <th className="text-left px-4 py-2">Version</th>
                  <th className="text-left px-4 py-2">Model</th>
                  <th className="text-left px-4 py-2">System Prompt</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr key={v.version} className="border-t border-border">
                    <td className="px-4 py-2">v{v.version}</td>
                    <td className="px-4 py-2 text-fg-muted">{modelStr(v.model)}</td>
                    <td className="px-4 py-2 text-fg-muted max-w-xs truncate">{v.system || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      </div>

      <CreateDeploymentDialog
        open={showDeploy}
        onClose={() => setShowDeploy(false)}
        initialAgentId={agent.id}
      />
    </Page>
  );
}

function AmbientRulesPanel({
  agentId,
  rules,
}: {
  agentId: string;
  rules: AmbientRule[];
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const path = `/v1/agents/${agentId}/ambient-rules`;
  const [name, setName] = useState("");
  const [triggerDraft, setTriggerDraft] = useState(createDefaultAmbientTriggerDraft("schedule"));
  const [wakeMode, setWakeMode] = useState<AmbientWakeMode>("decide");
  const [enabled, setEnabled] = useState(true);
  const [nextWakeAt, setNextWakeAt] = useState("");
  const [decisionPreset, setDecisionPreset] = useState<AmbientDecisionPreset>("new_signal");
  const [budgetPreset, setBudgetPreset] = useState<AmbientBudgetPreset>("standard");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: [path] });

  const createRule = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name,
        enabled,
        trigger: buildAmbientTrigger(triggerDraft),
        wake_mode: wakeMode,
      };
      const policy = buildDecisionPolicy(decisionPreset);
      if (policy) body.decision_policy = policy;
      const budget = buildBudget(budgetPreset);
      if (budget) body.budget = budget;
      if (nextWakeAt) body.next_wake_at = new Date(nextWakeAt).toISOString();
      await api(path, { method: "POST", body: JSON.stringify(body) });
      setName("");
      setTriggerDraft(createDefaultAmbientTriggerDraft("schedule"));
      setDecisionPreset("new_signal");
      setBudgetPreset("standard");
      setNextWakeAt("");
      await invalidate();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to create ambient rule");
    } finally {
      setSaving(false);
    }
  };

  const setRuleEnabled = async (rule: AmbientRule, next: boolean) => {
    await api(`${path}/${rule.id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: next }),
    });
    await invalidate();
  };

  const deleteRule = async (rule: AmbientRule) => {
    if (!confirm(`Delete ambient rule "${rule.name}"?`)) return;
    await api(`${path}/${rule.id}`, { method: "DELETE" });
    await invalidate();
  };

  return (
    <div className="mt-8 max-w-4xl">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between mb-3">
        <div>
          <h2 className="font-display text-base font-semibold">Ambient</h2>
          <p className="text-xs text-fg-subtle">
            {rules.filter((r) => r.enabled).length} enabled · {rules.length} total
          </p>
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="border border-border rounded-lg overflow-hidden">
          {rules.length === 0 ? (
            <div className="px-4 py-8 text-sm text-fg-subtle">
              No ambient rules configured.
            </div>
          ) : (
            <div className="divide-y divide-border">
              {rules.map((rule) => (
                <div key={rule.id} className="px-4 py-3 flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-medium text-sm text-fg truncate">{rule.name}</span>
                      <span className={rule.enabled ? "text-xs text-success" : "text-xs text-fg-subtle"}>
                        {rule.enabled ? "Enabled" : "Disabled"}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-fg-subtle">
                      <span>{rule.trigger.source}</span>
                      <span>{rule.wake_mode}</span>
                      {rule.trigger.source === "schedule" && (
                        <span>{scheduleSummary(rule.trigger.config) ?? "Schedule"}</span>
                      )}
                      <span>{rule.next_wake_at ? `Next ${new Date(rule.next_wake_at).toLocaleString()}` : "No next wake"}</span>
                      {rule.last_decision && <span>Last {rule.last_decision.outcome}</span>}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex items-center gap-2 text-xs text-fg-muted min-h-9">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        onChange={(e) => void setRuleEnabled(rule, e.target.checked)}
                        className="accent-[var(--brand)]"
                      />
                      Active
                    </label>
                    <Button variant="outline" size="sm" onClick={() => void deleteRule(rule)}>
                      Delete
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="border border-border rounded-lg p-4 space-y-3">
          <h3 className="font-display text-sm font-semibold">New Rule</h3>
          {err && <div className="text-xs text-danger">{err}</div>}
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Hourly PR review"
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
            />
          </Field>
          <AmbientTriggerControls
            value={triggerDraft}
            onChange={setTriggerDraft}
            inputClassName="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Wake mode">
              <select
                value={wakeMode}
                onChange={(e) => setWakeMode(e.target.value as AmbientWakeMode)}
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
              >
                {AMBIENT_WAKE_MODES.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </Field>
            <Field label="Decision">
              <select
                value={decisionPreset}
                onChange={(e) => setDecisionPreset(e.target.value as AmbientDecisionPreset)}
                className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
              >
                <option value="always">Always wake</option>
                <option value="new_signal">Only for new signal</option>
                <option value="approval_required">Ask before acting</option>
              </select>
            </Field>
          </div>
          <Field label="Budget">
            <select
              value={budgetPreset}
              onChange={(e) => setBudgetPreset(e.target.value as AmbientBudgetPreset)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
            >
              <option value="conservative">Conservative</option>
              <option value="standard">Standard</option>
              <option value="intensive">High frequency</option>
            </select>
          </Field>
          <label className="inline-flex items-center gap-2 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="accent-[var(--brand)]"
            />
            Enabled
          </label>
          <Field label="Next wake">
            <input
              type="datetime-local"
              value={nextWakeAt}
              onChange={(e) => setNextWakeAt(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
            />
          </Field>
          <Button
            size="sm"
            onClick={() => void createRule()}
            disabled={saving || !name.trim()}
            className="w-full"
          >
            {saving ? "Creating…" : "Create rule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * One foldable provider section. Default-open when there's a live
 * publication, default-closed otherwise — opening an empty section
 * just to find the "Publish to X" link is wasteful.
 */
function IntegrationFold({
  kind,
  label,
  icon,
  pubs,
  agentId,
}: {
  kind: "linear" | "github" | "slack";
  label: string;
  icon: React.ReactNode;
  pubs: Pub[];
  agentId: string;
}) {
  return (
    <details
      open={pubs.length > 0}
      className="border border-border rounded-lg bg-bg-surface/30 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="px-4 py-2.5 min-h-11 sm:min-h-0 flex items-center gap-3 text-sm cursor-pointer hover:bg-bg-surface/60 list-none">
        <span className="text-fg-muted shrink-0">{icon}</span>
        <span className="font-medium text-fg">{label}</span>
        <span className="ml-auto text-xs text-fg-subtle">
          {pubs.length === 0 ? "Not published" : `${pubs.length} live`}
        </span>
      </summary>
      <div className="px-4 pb-3 pt-2 border-t border-border/40 space-y-1.5 text-sm">
        {pubs.length === 0 ? (
          <Link
            to={`/integrations/${kind}/publish?agent_id=${agentId}`}
            className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-0 text-brand hover:underline"
          >
            Publish to {label} →
          </Link>
        ) : (
          <>
            {pubs.map((p) => (
              <Link
                key={p.id}
                to={`/integrations/${kind}`}
                className="flex items-center gap-2 min-h-11 sm:min-h-0 text-fg-muted hover:text-fg"
              >
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success-subtle text-success">
                  Live
                </span>
                <span>
                  as <strong>{p.persona.name}</strong> in {p.workspace_name ?? `${label} workspace`}
                </span>
                {p.mode === "full" && (
                  <span className="text-xs text-fg-subtle">(full identity)</span>
                )}
              </Link>
            ))}
            <Link
              to={`/integrations/${kind}/publish?agent_id=${agentId}`}
              className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline pt-1"
            >
              + Publish to another workspace
            </Link>
          </>
        )}
      </div>
    </details>
  );
}


/**
 * Edit modal — drives POST /v1/agents/:id (each save creates a new agent
 * version; running sessions keep their pinned snapshot). Sends the full
 * config with unedited fields passed through so the versioned update
 * never drops tools / mcp_servers / metadata.
 */
function EditAgentModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { api } = useApi();
  const qc = useQueryClient();
  const { data: skillsRes } = useApiQuery<{
    data: Array<{ id: string; name: string; description: string }>;
  }>("/v1/skills");
  const allSkills = skillsRes?.data ?? [];

  const initialModel =
    typeof agent.model === "string" ? agent.model : ((agent.model as { id?: string })?.id ?? "");
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(initialModel);
  const [system, setSystem] = useState(agent.system ?? "");
  const [harness, setHarness] = useState(agent._oma?.harness ?? "default");
  const [skillIds, setSkillIds] = useState<Set<string>>(
    () =>
      new Set(
        ((agent.skills ?? []) as Array<{ skill_id?: string }>)
          .map((s) => s?.skill_id)
          .filter((x): x is string => !!x),
      ),
  );
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggleSkill = (sid: string) =>
    setSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(sid)) next.delete(sid);
      else next.add(sid);
      return next;
    });

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        name,
        model,
        system,
        tools: agent.tools,
        mcp_servers: agent.mcp_servers,
        metadata: (agent as { metadata?: Record<string, unknown> }).metadata,
        skills: [...skillIds].map((skill_id) => ({ type: "custom", skill_id })),
        _oma: { ...(agent._oma ?? {}), harness },
      };
      for (const k of Object.keys(body)) {
        if (body[k] === undefined || body[k] === null) delete body[k];
      }
      await api(`/v1/agents/${agent.id}`, { method: "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}`] });
      await qc.invalidateQueries({ queryKey: [`/v1/agents/${agent.id}/versions`] });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Edit agent"
      subtitle={`Saving creates version ${agent.version + 1}; running sessions keep their snapshot.`}
      footer={
        <div className="flex items-center gap-2 justify-end w-full">
          {err && <span className="text-danger text-xs mr-auto">{err}</span>}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={save} disabled={saving || !name.trim() || !model.trim()}>
            {saving ? "Saving…" : "Save changes"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
            />
          </Field>
          <Field label="Model">
            <input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg font-mono text-xs text-fg"
            />
          </Field>
        </div>
        <Field label="Harness">
          <select
            value={harness}
            onChange={(e) => setHarness(e.target.value)}
            className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg text-fg"
          >
            <option value="default">default — platform loop, model-card API billing</option>
            <option value="claude-agent-sdk">claude-agent-sdk — local Claude Code, subscription billing</option>
            <option value="acp-proxy">acp-proxy — delegate to a registered local runtime</option>
          </select>
        </Field>
        <Field label="System prompt">
          <textarea
            value={system}
            onChange={(e) => setSystem(e.target.value)}
            rows={7}
            className="w-full px-2.5 py-1.5 text-sm rounded-md border border-border bg-bg font-mono text-xs leading-relaxed text-fg resize-y"
          />
        </Field>
        <Field label={`Skills (${skillIds.size} attached)`}>
          {allSkills.length === 0 ? (
            <p className="text-xs text-fg-subtle">
              No skills in this workspace yet — import one on the Skills page.
            </p>
          ) : (
            <div className="max-h-44 overflow-y-auto border border-border rounded-md divide-y divide-border">
              {allSkills.map((sk) => (
                <label
                  key={sk.id}
                  className="flex items-start gap-2.5 px-3 py-2 cursor-pointer hover:bg-bg-surface transition-colors duration-[var(--dur-quick)]"
                >
                  <input
                    type="checkbox"
                    checked={skillIds.has(sk.id)}
                    onChange={() => toggleSkill(sk.id)}
                    className="mt-0.5 accent-[var(--brand)]"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm text-fg">{sk.name}</span>
                    <span className="block text-xs text-fg-subtle truncate">
                      {sk.description || "—"}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}
