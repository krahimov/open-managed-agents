import { useMemo, useState } from "react";
import { Link } from "react-router";
import { DownloadIcon, ShieldCheckIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getActiveTenantId } from "@/lib/api";
import { getClerkBearerToken } from "@/lib/clerk-auth";
import { formatAbsolute, plural, toDate } from "@/lib/format";
import { sessionTitle } from "@/lib/sessions";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import {
  Callout,
  Chip,
  DateField,
  EmptyState,
  ErrorState,
  IdChip,
  RelativeTime,
  SectionCard,
  Skeleton,
  StatusBadge,
} from "../../../components/kit";
import type { SessionRecord } from "../../../types/session";
import { AccessPolicyEditor } from "../AccessPolicyEditor";

interface PermissionRuleView {
  effect: "allow" | "ask" | "deny";
  selector: string;
  description?: string;
}

interface PermissionGrantView {
  id: string;
  version: number;
  enabled: boolean;
  rules: PermissionRuleView[];
  approved_by: string;
  created_at: string;
}

interface CapabilityView {
  grant_id: string | null;
  grant_version: number | null;
  generated_at: string;
  entries: Array<{ tool: string; effect: PermissionRuleView["effect"]; selector: string | null }>;
  notes: string[];
}

interface ApprovalVersionView extends PermissionGrantView {
  diff: { added: PermissionRuleView[]; removed: PermissionRuleView[] };
}

interface ActivityView {
  from: string;
  to: string;
  events: Array<{ ts_iso: string; session_id: string; event_type: string; summary: string }>;
  tool_use: Array<{ session_id: string; tool_use_count: number; mcp_tool_use_count: number }>;
  truncated: boolean;
  row_cap: number;
}

/** One vocabulary for a rule's effect, here and in the capability table. */
const EFFECT: Record<PermissionRuleView["effect"], { label: string; tone: "neutral" | "warning" | "danger" }> = {
  allow: { label: "Allowed", tone: "neutral" },
  ask: { label: "Asks first", tone: "warning" },
  deny: { label: "Blocked", tone: "danger" },
};

function EffectChip({ effect }: { effect: PermissionRuleView["effect"] }) {
  const e = EFFECT[effect] ?? EFFECT.allow;
  return <Chip tone={e.tone}>{e.label}</Chip>;
}

/** yyyy-mm-dd, the value a <DateField> holds. */
const dateInputValue = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Print only the audit trail. The body class scopes the print stylesheet
 *  (see index.css); `afterprint` removes it so normal printing still works. */
export function printAuditTrail() {
  document.body.classList.add("print-audit-only");
  window.addEventListener("afterprint", () => document.body.classList.remove("print-audit-only"), { once: true });
  window.print();
}

const CAPABILITY_PREVIEW = 8;

/**
 * The server's notes on the tool list, in the console's words. The note
 * that no policy is enforced is dropped: the card's description says so.
 * A note this does not know is shown as the server wrote it.
 */
export function capabilityNotes(notes: string[] | undefined): string[] {
  return (notes ?? []).flatMap((note) => {
    if (/^No enabled baseline grant/i.test(note)) return [];
    if (/^MCP tool lists are discovered at session runtime/i.test(note)) {
      return [
        "An MCP server's tools are only known once a session runs, so each server is one row here and its row applies to all of its tools. Rules for a single MCP tool still apply in sessions.",
      ];
    }
    return [note];
  });
}

/**
 * Access: what this agent is allowed to do, and the record of it.
 *
 *   - Access policy: the versioned baseline grant. Edits apply to new
 *     sessions; each session keeps the version it started with.
 *   - What it can use: every tool the configuration exposes, evaluated
 *     through the policy.
 *   - Policy versions: who approved what, with the rule changes.
 *   - Policy and access events: audit frames from the event log, with a
 *     date range and a CSV export.
 *
 * The whole tab is the printable authority record ("Export" in the tab
 * bar); controls are left out of the print.
 */
export function AccessTab({
  agentId,
  agentName,
  sessions,
}: {
  agentId: string;
  agentName: string;
  /** The agent's loaded sessions, to show audit rows by session title. */
  sessions: SessionRecord[];
}) {
  const grants = useApiQuery<{ baseline: PermissionGrantView | null; versions: PermissionGrantView[] }>(
    `/v1/agents/${agentId}/grants`,
  );
  const baseline = grants.data?.baseline ?? null;
  const grantVersions = grants.data?.versions ?? [];
  const enforced = !!baseline && baseline.enabled;

  const capability = useApiQuery<CapabilityView>(`/v1/agents/${agentId}/evidence/capability`);
  const approvals = useApiQuery<{ versions: ApprovalVersionView[] }>(`/v1/agents/${agentId}/evidence/approvals`);

  const [from, setFrom] = useState(() => dateInputValue(Date.now() - 7 * 24 * 60 * 60 * 1000));
  const [to, setTo] = useState(() => dateInputValue(Date.now()));
  // Date-only inputs → inclusive day bounds in the browser's timezone.
  const fromIso = from ? new Date(`${from}T00:00:00`).toISOString() : undefined;
  const toIso = to ? new Date(`${to}T23:59:59.999`).toISOString() : undefined;
  const activity = useApiQuery<ActivityView>(`/v1/agents/${agentId}/evidence/activity`, { from: fromIso, to: toIso });

  const titleById = useMemo(() => new Map(sessions.map((s) => [s.id, sessionTitle(s, agentName)])), [sessions, agentName]);

  const downloadCsv = async () => {
    const qs = new URLSearchParams({ format: "csv" });
    if (fromIso) qs.set("from", fromIso);
    if (toIso) qs.set("to", toIso);
    // Raw fetch instead of api(): the helper JSON-parses every body and
    // this response is text/csv. Same auth headers it would send.
    const clerkToken = await getClerkBearerToken();
    const activeTenant = getActiveTenantId();
    let res: Response;
    try {
      res = await fetch(`/v1/agents/${agentId}/evidence/activity?${qs.toString()}`, {
        credentials: "include",
        headers: {
          ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
          ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
        },
      });
    } catch (err) {
      toast.error(`Network error: ${err instanceof Error ? err.message : "fetch failed"}`);
      return;
    }
    if (!res.ok) {
      toast.error(`CSV export failed (HTTP ${res.status})`);
      return;
    }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `evidence-activity-${agentId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const [showAllTools, setShowAllTools] = useState(false);
  const entries = capability.data?.entries ?? [];
  const approvalVersions = approvals.data?.versions ?? [];
  const events = activity.data?.events ?? [];
  const toolUse = activity.data?.tool_use ?? [];

  return (
    <div className="audit-trail-print space-y-4">
      <p className="text-small text-fg-muted">
        Authority record for {agentName}
        {capability.data && (
          <span className="text-fg-subtle"> · generated {formatAbsolute(capability.data.generated_at)}</span>
        )}
      </p>

      <SectionCard
        title="Access policy"
        description="Which tools new sessions may use. Each session keeps the policy version it started with."
        actions={
          !grants.isLoading && !grants.error ? (
            <AccessPolicyEditor
              agentId={agentId}
              baseline={baseline}
              onSaved={() => {
                void grants.refetch();
                void capability.refetch();
                void approvals.refetch();
              }}
              className="audit-no-print"
            />
          ) : undefined
        }
        flush={enforced}
        footer={
          enforced ? (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Chip tone="outline" mono>
                v{baseline.version}
              </Chip>
              <span>
                Approved by <span className="font-medium text-fg">{baseline.approved_by}</span>{" "}
                <RelativeTime value={baseline.created_at} />
              </span>
              {grantVersions.length > 1 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span>{plural(grantVersions.length, "version")}</span>
                </>
              )}
            </span>
          ) : undefined
        }
      >
        {grants.isLoading ? (
          <div className="space-y-2.5" aria-hidden="true">
            <Skeleton className="h-3.5 w-3/5" rounded="sm" />
            <Skeleton className="h-3.5 w-2/5" rounded="sm" />
          </div>
        ) : grants.error ? (
          <ErrorState compact title="Access policy could not be loaded" error={grants.error} retry={() => void grants.refetch()} />
        ) : !enforced ? (
          <div className="flex items-start gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-bg-soft text-fg-muted">
              <ShieldCheckIcon className="size-4" />
            </span>
            <div className="min-w-0 text-small">
              <p className="font-medium text-fg">No policy is enforced</p>
              <p className="mt-0.5 max-w-[70ch] text-fg-muted">
                This agent can use every tool its configuration exposes. Add a policy to block tools, or to make the
                agent ask before it uses them.
                {baseline && !baseline.enabled && <> The last policy (v{baseline.version}) is switched off.</>}
              </p>
            </div>
          </div>
        ) : (
          <ul>
            {baseline.rules.map((rule, i) => (
              <li key={i} className="flex min-h-12 items-center gap-3 border-t border-border px-5 py-2.5 first:border-t-0">
                <span className="w-[5.5rem] shrink-0">
                  <EffectChip effect={rule.effect} />
                </span>
                <code className="shrink-0 font-mono text-xs text-fg">{rule.selector}</code>
                {rule.description && (
                  <span className="min-w-0 truncate text-xs text-fg-subtle" title={rule.description}>
                    {rule.description}
                  </span>
                )}
              </li>
            ))}
            {baseline.rules.length === 0 && (
              <li className="px-5 py-4 text-small text-fg-subtle">This policy has no rules, so every configured tool is allowed.</li>
            )}
          </ul>
        )}
      </SectionCard>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SectionCard
          title="What it can use"
          description={
            capability.data?.grant_id
              ? `Every tool the configuration exposes, evaluated through policy v${capability.data.grant_version}.`
              : "Every tool the configuration exposes. With no policy enforced, all of them are allowed."
          }
          flush
          footer={
            entries.length > CAPABILITY_PREVIEW ? (
              <button
                type="button"
                onClick={() => setShowAllTools((v) => !v)}
                aria-expanded={showAllTools}
                className="audit-no-print font-medium text-fg-muted transition-quick hover:text-fg"
              >
                {showAllTools ? "Show fewer" : `Show all ${entries.length} tools`}
              </button>
            ) : undefined
          }
        >
          {capability.isLoading ? (
            <div className="space-y-3 px-5 py-4" aria-hidden="true">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-3.5 w-full" rounded="sm" />
              ))}
            </div>
          ) : capability.error ? (
            <div className="p-5">
              <ErrorState compact title="The capability statement could not be loaded" error={capability.error} retry={() => void capability.refetch()} />
            </div>
          ) : entries.length === 0 ? (
            <p className="px-5 py-4 text-small text-fg-subtle">This agent's configuration exposes no tools.</p>
          ) : (
            <Table className="text-small-size">
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-5">Tool</TableHead>
                  <TableHead className="w-[130px] px-4">Effect</TableHead>
                  <TableHead className="pr-5 pl-4">Decided by</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((e, i) => (
                  <TableRow
                    key={e.tool}
                    className={cn("h-11 hover:bg-transparent", !showAllTools && i >= CAPABILITY_PREVIEW && "hidden print:table-row")}
                  >
                    <TableCell className="pl-5 font-mono text-xs text-fg">{e.tool}</TableCell>
                    <TableCell className="px-4">
                      <EffectChip effect={e.effect} />
                    </TableCell>
                    <TableCell className="pr-5 pl-4 text-fg-muted">
                      {e.selector ? <code className="font-mono text-xs">{e.selector}</code> : <span className="text-fg-subtle">Default</span>}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {capabilityNotes(capability.data?.notes).length > 0 && (
            <div className="space-y-1.5 border-t border-border px-5 py-3.5 text-xs text-fg-subtle">
              {capabilityNotes(capability.data?.notes).map((n, i) => (
                <p key={i}>{n}</p>
              ))}
            </div>
          )}
        </SectionCard>

        <SectionCard title="Policy versions" description="Who approved what, newest first.">
          {approvals.isLoading ? (
            <div className="space-y-2.5" aria-hidden="true">
              <Skeleton className="h-3.5 w-4/5" rounded="sm" />
              <Skeleton className="h-3.5 w-3/5" rounded="sm" />
            </div>
          ) : approvals.error ? (
            <ErrorState compact title="Policy versions could not be loaded" error={approvals.error} retry={() => void approvals.refetch()} />
          ) : approvalVersions.length === 0 ? (
            <p className="text-small text-fg-subtle">Nothing has been approved for this agent yet.</p>
          ) : (
            <ol className="-my-1 space-y-4">
              {approvalVersions.map((v) => (
                <li key={v.version} className="text-small">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Chip tone="outline" mono>
                      v{v.version}
                    </Chip>
                    {!v.enabled && <StatusBadge status="disabled" label="Switched off" />}
                    <RelativeTime value={v.created_at} className="ml-auto text-xs text-fg-subtle" />
                  </div>
                  <p className="mt-1.5 text-xs text-fg-muted">
                    Approved by <span className="font-medium text-fg">{v.approved_by}</span>
                  </p>
                  {(v.diff.added.length > 0 || v.diff.removed.length > 0) && (
                    <div className="mt-2 space-y-1 font-mono text-xs">
                      {v.diff.added.map((r, i) => (
                        <div key={`a${i}`} className="truncate rounded-sm bg-success-subtle px-2 py-0.5 text-success" title={`Added: ${r.effect} ${r.selector}`}>
                          + {r.effect} {r.selector}
                        </div>
                      ))}
                      {v.diff.removed.map((r, i) => (
                        <div key={`r${i}`} className="truncate rounded-sm bg-danger-subtle px-2 py-0.5 text-danger" title={`Removed: ${r.effect} ${r.selector}`}>
                          − {r.effect} {r.selector}
                        </div>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </SectionCard>
      </div>

      <SectionCard
        title="Policy and access events"
        description="Policy changes, access requests and skill requests recorded in this agent's sessions."
        actions={
          <div className="audit-no-print flex flex-wrap items-center justify-end gap-2">
            <DateField
              value={from}
              max={to || undefined}
              onChange={setFrom}
              aria-label="Activity from date"
              placeholder="Any start"
              className="h-8 w-[9.75rem]"
            />
            <span className="text-xs text-fg-subtle">to</span>
            <DateField
              value={to}
              min={from || undefined}
              onChange={setTo}
              aria-label="Activity to date"
              placeholder="Today"
              className="h-8 w-[9.75rem]"
            />
            <Button variant="ghost" size="sm" onClick={() => void downloadCsv()}>
              <DownloadIcon data-icon="inline-start" />
              Download CSV
            </Button>
          </div>
        }
        flush
      >
        {activity.data?.truncated && (
          <div className="px-5 pt-4">
            <Callout tone="warning">
              Showing the first {activity.data.row_cap.toLocaleString()} events in this range. Narrow the dates or use the
              CSV export.
            </Callout>
          </div>
        )}
        {activity.isLoading ? (
          <div className="space-y-3 px-5 py-4" aria-hidden="true">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-3.5 w-full" rounded="sm" />
            ))}
          </div>
        ) : activity.error ? (
          <div className="p-5">
            <ErrorState compact title="Events could not be loaded" error={activity.error} retry={() => void activity.refetch()} />
          </div>
        ) : events.length === 0 ? (
          <EmptyState
            variant="plain"
            size="sm"
            icon={<ShieldCheckIcon />}
            title="No policy or access events in this range"
            body="Try a wider date range. Tool use per session is listed below."
          />
        ) : (
          <ul>
            {events.map((e, i) => (
              <li key={i} className="flex min-h-11 items-center gap-4 border-t border-border px-5 py-2 text-small-size first:border-t-0">
                <time dateTime={toDate(e.ts_iso)?.toISOString()} className="w-36 shrink-0 text-xs text-fg-subtle tabular-nums">
                  {auditTime(e.ts_iso)}
                </time>
                <span className="min-w-0 flex-1 truncate text-fg" title={e.summary}>
                  {e.summary}
                </span>
                <SessionLink id={e.session_id} title={titleById.get(e.session_id)} />
              </li>
            ))}
          </ul>
        )}

        {toolUse.length > 0 && (
          <div className="border-t border-border px-5 py-4">
            <h4 className="mb-2 text-xs font-medium text-fg-subtle">Tool use by session in this range</h4>
            <ul className="space-y-1">
              {toolUse.map((t) => (
                <li key={t.session_id} className="flex min-h-8 items-center justify-between gap-4 text-small-size">
                  <SessionLink id={t.session_id} title={titleById.get(t.session_id)} strong />
                  <span className="shrink-0 text-xs text-fg-muted tabular-nums">
                    {plural(t.tool_use_count, "tool call")} · {plural(t.mcp_tool_use_count, "MCP call")}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </SectionCard>
    </div>
  );
}

/** "Nov 4, 10:58 AM": an audit row wants the moment, not "5d ago". */
function auditTime(value: string): string {
  const d = toDate(value);
  if (!d) return "Time not recorded";
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A session by title when we know it, otherwise its copyable id. */
function SessionLink({ id, title, strong }: { id: string; title?: string; strong?: boolean }) {
  if (!title) return <IdChip id={id} label="Copy session id" className="shrink-0" />;
  return (
    <Link
      to={`/sessions/${id}`}
      title={title}
      className={cn(
        "min-w-0 truncate rounded-sm decoration-border-strong underline-offset-4 hover:underline",
        strong ? "font-medium text-fg" : "max-w-[18rem] shrink-0 text-xs text-fg-muted hover:text-fg",
      )}
    >
      {title}
    </Link>
  );
}
