import { useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CopyIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useApi } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import {
  TriggerFields,
  buildTriggerRuleBody,
  createTriggerRuleDraft,
  type TriggerRuleDraft,
} from "../../../components/agents/TriggerFields";
import { describeTrigger, humanize, triggerSourceMeta, wakeModeMeta, type AmbientRule } from "../../../components/agents/triggers";
import { Disclosure } from "../../../components/Disclosure";
import {
  Callout,
  Chip,
  CodeWell,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  EntityAvatar,
  ErrorState,
  Modal,
  RelativeTime,
  RowActionsMenu,
  Skeleton,
} from "../../../components/kit";
import { failureSentence } from "../../../lib/failure-text";

/**
 * Triggers: the standing rules that wake this agent without a person
 * (the API calls them ambient rules). Each is a card that says, in words,
 * when the agent wakes and what it does, with a switch to pause it.
 * Adding one is a deliberate action in a dialog, never a form left open
 * in the page.
 */
export function TriggersTab({
  agentId,
  agentName,
  rules,
  loading,
  error,
  retry,
  archived,
  onAdd,
}: {
  agentId: string;
  agentName: string;
  rules: AmbientRule[];
  loading: boolean;
  error: unknown;
  retry: () => void;
  archived: boolean;
  onAdd: () => void;
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const path = `/v1/agents/${agentId}/ambient-rules`;
  const [pending, setPending] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<AmbientRule | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: [path] });

  const setEnabled = async (rule: AmbientRule, next: boolean) => {
    setPending(rule.id);
    try {
      await api(`${path}/${rule.id}`, { method: "PATCH", body: JSON.stringify({ enabled: next }) });
      await invalidate();
    } catch {
      // The API client already raised a toast.
    } finally {
      setPending(null);
    }
  };

  if (error) return <ErrorState title="Triggers could not be loaded" error={error} retry={retry} />;

  if (loading) {
    return (
      <div className="space-y-3" aria-hidden="true">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={i} className="surface flex items-start gap-4 rounded-xl p-5">
            <Skeleton className="size-10" rounded="lg" />
            <div className="flex-1 space-y-2.5 pt-0.5">
              <Skeleton className="h-4 w-56" rounded="sm" />
              <Skeleton className="h-3.5 w-72 max-w-full" rounded="sm" />
              <Skeleton className="h-[22px] w-40" rounded="full" />
            </div>
            <Skeleton className="h-[22px] w-[38px]" rounded="full" />
          </div>
        ))}
      </div>
    );
  }

  if (rules.length === 0) {
    return (
      <EmptyState
        icon={<TriggerEmptyIcon />}
        title="No triggers yet"
        body={
          archived
            ? "This agent was archived without any triggers."
            : `A trigger starts a fresh session of ${agentName} on a schedule, or when something happens in a connected app.`
        }
        action={
          archived ? undefined : (
            <Button variant="outline" onClick={onAdd}>
              <PlusIcon data-icon="inline-start" />
              Add trigger
            </Button>
          )
        }
      />
    );
  }

  const on = rules.filter((r) => r.enabled).length;

  return (
    <div>
      <p className="mb-4 text-small text-fg-muted">
        Each trigger starts a fresh session of {agentName}.{" "}
        <span className="text-fg-subtle">
          {on} of {rules.length} switched on.
        </span>
      </p>
      <div className="space-y-3">
        {rules.map((rule, i) => (
          <TriggerCard
            key={rule.id}
            rule={rule}
            agentId={agentId}
            busy={pending === rule.id}
            onToggle={(next) => void setEnabled(rule, next)}
            onDelete={() => setToDelete(rule)}
            style={{ "--i": Math.min(i, 8) } as React.CSSProperties}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        destructive
        title={`Delete "${toDelete?.name ?? "trigger"}"?`}
        body="The agent stops waking for it. Sessions it already started stay in history. This cannot be undone."
        confirmLabel="Delete trigger"
        onConfirm={async () => {
          if (!toDelete) return;
          await api(`${path}/${toDelete.id}`, { method: "DELETE" });
          await invalidate();
          toast.success("Trigger deleted");
        }}
      />
    </div>
  );
}

function TriggerEmptyIcon() {
  const Icon = triggerSourceMeta("schedule").icon;
  return <Icon />;
}

function TriggerCard({
  rule,
  agentId,
  busy,
  onToggle,
  onDelete,
  style,
}: {
  rule: AmbientRule;
  agentId: string;
  busy: boolean;
  onToggle: (next: boolean) => void;
  onDelete: () => void;
  style?: React.CSSProperties;
}) {
  const source = triggerSourceMeta(rule.trigger?.source);
  const wake = wakeModeMeta(rule.wake_mode);
  const d = describeTrigger(rule.trigger);
  // Say each thing once. The server writes a default description that
  // restates the trigger ("Wake on GitHub pull_request.labeled with label
  // needs-agent-review."), and the card already shows the event, the label
  // and the repository: such a description adds nothing and is left out. A
  // description that says something of its own is kept. The source chip
  // goes too when the summary line already names the source.
  const description = restates(rule.description, [rule.name, d.summary, source.label, eventOf(rule), ...d.facts.flatMap((f) => [f.label, f.value])])
    ? null
    : rule.description;
  const sourceNamed = d.summary.toLowerCase().includes(source.label.toLowerCase());
  const endpoint = `${window.location.origin}/v1/agents/${agentId}/ambient-rules/${rule.id}/events`;
  const example = '{"event_id":"incident-123","data":{"window_id":"w05"}}';

  return (
    <article style={style} className="surface stagger animate-rise-in rounded-xl p-5">
      <div className="flex items-start gap-4">
        <EntityAvatar icon={source.icon} size="lg" className={cn(!rule.enabled && "opacity-60")} />
        <div className="min-w-0 flex-1">
          <h3 className="text-h3 break-words text-fg">{rule.name}</h3>
          <p className="mt-0.5 text-small text-fg-muted">
            <span className="font-medium text-fg">{d.summary}</span>
            {d.cron && <span className="ml-1.5 font-mono text-xs">{d.cron}</span>}
            {d.timezone && <span> · {d.timezone.replace(/_/g, " ")}</span>}
          </p>
          {description && <p className="mt-2 max-w-[72ch] text-small text-fg-muted">{description}</p>}
          {d.prompt && (
            <p className="mt-2 max-w-[72ch] border-l-2 border-border-strong pl-3 text-small text-fg-muted">
              <span className="text-fg-subtle">Each run is told: </span>
              {d.prompt}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {!sourceNamed && <Chip icon={source.icon}>{source.label}</Chip>}
            <Chip title={wake.hint}>{wake.short}</Chip>
            {d.facts.map((fact) => (
              <Chip key={fact.key} tone="outline" title={`${fact.label}: ${fact.value}`} className="max-w-[20rem]">
                <span className="text-fg-subtle">{fact.label}</span> {fact.value}
              </Chip>
            ))}
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-subtle">
            {rule.enabled && rule.next_wake_at ? (
              <span>
                Next run <RelativeTime value={rule.next_wake_at} className="font-medium text-fg-muted" />
              </span>
            ) : (
              <span>{rule.enabled ? (rule.trigger?.source === "schedule" ? "Next run not scheduled yet" : "Waiting for the next event") : "Paused"}</span>
            )}
            {rule.last_decision && (
              <>
                <span aria-hidden="true">·</span>
                <span title={rule.last_decision.reason}>
                  Last time: {humanize(rule.last_decision.outcome).toLowerCase()}{" "}
                  <RelativeTime value={rule.last_decision.decided_at} />
                </span>
                {rule.last_decision.session_id && (
                  <Link
                    to={`/sessions/${rule.last_decision.session_id}`}
                    className={inlineLink}
                  >
                    View session
                  </Link>
                )}
              </>
            )}
            {!rule.last_decision && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Added <RelativeTime value={rule.created_at} />
                </span>
              </>
            )}
          </div>

          {rule.trigger?.source === "webhook" && (
            <Disclosure title="Webhook endpoint" variant="bare" className="-mx-3.5 mt-2">
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <CodeWell className="min-w-0 flex-1 py-2">
                    <span className="text-fg-subtle select-none">POST </span>
                    {endpoint}
                  </CodeWell>
                  <CopyButton value={endpoint} label="Copy endpoint URL" size="md" />
                </div>
                <p className="text-xs text-fg-subtle">
                  Authenticate with a workspace API key. Send a unique <code className="font-mono">event_id</code> for each
                  event and reuse it when you retry.
                </p>
                <CodeWell className="py-2">{example}</CodeWell>
              </div>
            </Disclosure>
          )}
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <label className="flex h-8 cursor-pointer items-center gap-2 text-xs font-medium text-fg-muted">
            <span className="w-5 text-right">{rule.enabled ? "On" : "Off"}</span>
            <Switch
              checked={rule.enabled}
              disabled={busy}
              onCheckedChange={onToggle}
              aria-label={`${rule.name}: ${rule.enabled ? "on" : "off"}`}
            />
          </label>
          <RowActionsMenu
            label={`Actions for ${rule.name}`}
            actions={[
              { label: "Copy trigger id", icon: <CopyIcon />, onSelect: () => void copyText(rule.id) },
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: onDelete },
            ]}
          />
        </div>
      </div>
    </article>
  );
}

/**
 * Add a trigger. Opens from the Triggers tab; on success the rules list
 * refetches and the dialog closes.
 */
export function AddTriggerDialog({
  agentId,
  agentName,
  open,
  onClose,
}: {
  agentId: string;
  agentName: string;
  open: boolean;
  onClose: () => void;
}) {
  const { api } = useApi();
  const qc = useQueryClient();
  const path = `/v1/agents/${agentId}/ambient-rules`;
  const [draft, setDraft] = useState<TriggerRuleDraft>(createTriggerRuleDraft);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    if (saving) return;
    onClose();
    // Reset after the exit animation so the form does not flash empty.
    window.setTimeout(() => {
      setDraft(createTriggerRuleDraft());
      setError(null);
    }, 250);
  };

  const create = async () => {
    setSaving(true);
    setError(null);
    try {
      const body = buildTriggerRuleBody(draft);
      await api(path, { method: "POST", body: JSON.stringify(body) });
      await qc.invalidateQueries({ queryKey: [path] });
      toast.success("Trigger added");
      setSaving(false);
      onClose();
      window.setTimeout(() => setDraft(createTriggerRuleDraft()), 250);
    } catch (e) {
      setError(failureSentence(e));
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Add trigger"
      subtitle={`Wake ${agentName} on a schedule, or when something happens. Each run starts a fresh session.`}
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void create()} disabled={!draft.name.trim()} loading={saving}>
            Create trigger
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <Callout tone="danger" title="The trigger could not be created">
            {error}
          </Callout>
        )}
        <TriggerFields value={draft} onChange={setDraft} autoFocusName />
      </div>
    </Modal>
  );
}

/** The raw event name of an event trigger ("pull_request.labeled"), when it has one. */
function eventOf(rule: AmbientRule): string {
  const event = (rule.trigger?.config as { event?: unknown } | undefined)?.event;
  return typeof event === "string" ? event : "";
}

/** Words that carry no information of their own in a trigger's description. */
const FILLER = new Set(["wake", "wakes", "on", "with", "the", "a", "an", "and", "for", "in", "of", "to", "when", "is", "from", "by", "at", "run", "runs", "trigger", "triggers", "event", "events"]);

const wordsOf = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * True when `description` only repeats what `shown` already says: every
 * word of it that carries meaning is already on the card.
 */
export function restates(description: string | null | undefined, shown: Array<string | null | undefined>): boolean {
  if (!description?.trim()) return true;
  const have = new Set(shown.flatMap((t) => wordsOf(t ?? "")));
  // "labelled" and "labeled", "PRs" and "PR": compare loosely on the stem.
  const stem = (w: string) => w.replace(/(l?led|ed|s)$/, "");
  const stems = new Set([...have].map(stem));
  return wordsOf(description).every((w) => FILLER.has(w) || have.has(w) || stems.has(stem(w)));
}
