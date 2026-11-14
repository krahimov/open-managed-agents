import { useState } from "react";
import { PlusIcon, TriangleAlertIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { useApiMutation, useApiQuery } from "../../lib/useApiQuery";
import type { WorkspaceAccess } from "../../lib/operations";
import { Callout } from "../../components/Callout";
import { Modal } from "../../components/Modal";
import { SegmentedControl } from "../../components/SegmentedControl";
import { Tip } from "../../components/Tip";
import { Button } from "../../components/ui/button";

interface Rule { effect: "allow" | "ask" | "deny"; selector: string; description?: string }

const EFFECT_OPTIONS: Array<{ value: Rule["effect"]; label: string }> = [
  { value: "allow", label: "Allow" },
  { value: "ask", label: "Ask" },
  { value: "deny", label: "Deny" },
];

/**
 * The access policy editor: a button (shown to workspace owners and admins
 * only) that opens the policy in a dialog. A policy is an ordered list of
 * tool patterns with an effect each. Saving writes a new policy version
 * through `PUT /v1/agents/:id/grants/baseline`; sessions that are already
 * running keep the version they started with.
 */
export function AccessPolicyEditor({ agentId, baseline, onSaved, className }: {
  agentId: string;
  baseline: { rules: Rule[]; enabled: boolean; version: number } | null;
  onSaved: () => void;
  className?: string;
}) {
  const access = useApiQuery<WorkspaceAccess>("/v1/workspace/access");
  const [editing, setEditing] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState("");
  const mutation = useApiMutation({ onSuccess: () => { setEditing(false); onSaved(); } });
  if (!access.data?.authorization || !["owner", "admin"].includes(access.data.authorization.role)) return null;
  function start() {
    setRules(baseline?.rules.map((rule) => ({ ...rule })) ?? [{ selector: "*", effect: "ask" }]);
    setEnabled(baseline?.enabled ?? true); setError(""); mutation.reset(); setEditing(true);
  }
  function save() {
    if (rules.some((rule) => !rule.selector.trim())) { setError("Every rule needs a tool name or pattern."); return; }
    setError("");
    mutation.mutate({ path: `/v1/agents/${agentId}/grants/baseline`, method: "PUT", body: { enabled, rules: rules.map((rule) => ({ ...rule, selector: rule.selector.trim() })) } });
  }
  const problem = error || mutation.error?.message;
  return (
    <>
      <Button className={className} variant="outline" size="sm" onClick={start}>
        {baseline ? "Edit access policy" : "Add access policy"}
      </Button>
      <Modal
        open={editing}
        onClose={() => { if (!mutation.isPending) setEditing(false); }}
        title={baseline ? "Edit access policy" : "New access policy"}
        subtitle="Saving creates a new policy version for future sessions. Current sessions keep their existing policy."
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" disabled={mutation.isPending} onClick={() => setEditing(false)}>Cancel</Button>
            <Button loading={mutation.isPending} onClick={save}>Save policy version</Button>
          </>
        }
      >
        <div className="space-y-5">
          {problem && <Callout tone="danger" title="The policy was not saved">{problem}</Callout>}

          <div className="flex items-center justify-between gap-6 rounded-lg bg-bg-soft px-4 py-3">
            <div className="min-w-0">
              <label htmlFor="access-policy-enabled" className="block text-small-size font-medium text-fg">Enforce this policy</label>
              <p className="mt-0.5 text-small text-fg-muted">
                {enabled
                  ? "New sessions follow the rules below."
                  : "Disabling the policy allows all tools exposed by the agent configuration in new sessions."}
              </p>
            </div>
            <Switch id="access-policy-enabled" checked={enabled} onCheckedChange={setEnabled} />
          </div>

          <div>
            <div className="mb-2 flex items-end justify-between gap-4">
              <div>
                <h3 className="text-small leading-5 font-medium text-fg">Rules</h3>
                <p className="text-xs text-fg-subtle">A tool name, a pattern such as <code className="font-mono">mcp__github__*</code>, or <code className="font-mono">*</code> for everything else.</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setRules([...rules, { effect: "deny", selector: "" }])}>
                <PlusIcon data-icon="inline-start" />
                Add rule
              </Button>
            </div>
            {rules.length > 0 ? (
              <ul className="space-y-2">
                {rules.map((rule, index) => (
                  <li key={index} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                    <Input
                      aria-label={`Tool pattern ${index + 1}`}
                      value={rule.selector}
                      placeholder="bash, mcp__github__*, or *"
                      spellCheck={false}
                      aria-invalid={!!error && !rule.selector.trim()}
                      className="min-w-0 flex-1 font-mono"
                      onChange={(e) => setRules(rules.map((entry, i) => i === index ? { ...entry, selector: e.target.value } : entry))}
                    />
                    <SegmentedControl<Rule["effect"]>
                      label={`Effect ${index + 1}`}
                      value={rule.effect}
                      options={EFFECT_OPTIONS}
                      onChange={(effect) => setRules(rules.map((entry, i) => i === index ? { ...entry, effect } : entry))}
                    />
                    <Tip label="Remove rule">
                      <Button variant="ghost" size="icon-sm" aria-label={`Remove rule ${index + 1}`} onClick={() => setRules(rules.filter((_, i) => i !== index))}>
                        <XIcon />
                      </Button>
                    </Tip>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="flex items-center gap-2 rounded-lg border border-dashed border-border-strong px-4 py-3.5 text-small text-fg-muted">
                <TriangleAlertIcon className="size-4 shrink-0 text-warning" />
                An empty policy allows every configured tool.
              </p>
            )}
          </div>

          <Callout title="How rules are matched">
            <p>The most specific matching pattern wins. A tie favors Deny, then Ask. Unmatched tools are allowed. Use * to set a default.</p>
            <p className="mt-1.5">Ask requires an execution engine with tool confirmations. Use Deny for actions that must be blocked when confirmation support is unavailable.</p>
          </Callout>
        </div>
      </Modal>
    </>
  );
}
