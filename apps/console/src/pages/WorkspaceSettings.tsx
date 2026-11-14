import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { KeyRoundIcon, RotateCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { useAgents } from "../lib/directory";
import { formatCompact, formatCost, plural } from "../lib/format";
import type { WorkspaceAccess } from "../lib/operations";
import { useServerFeatures } from "../lib/server-features";
import { useApiMutation, useApiQuery } from "../lib/useApiQuery";
import { Avatar } from "../components/Avatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { EmptyState } from "../components/EmptyState";
import { Field } from "../components/Field";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { SectionCard } from "../components/SectionCard";
import { Select, SelectGroup, SelectGroupLabel, SelectOption } from "../components/Select";
import { Skeleton } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import { toMillis } from "../integrations/components/relativeTime";
import { failureSentence } from "@/lib/failure-text";

interface Member {
  user_id: string;
  role: string;
  created_at: number;
}
interface Budget {
  scope_id: string;
  daily_tokens: number | null;
  daily_cost_usd: number | null;
  max_concurrent_sessions: number | null;
}
interface Audit {
  id: string;
  actor_id: string | null;
  actor_kind: string;
  method: string;
  path: string;
  status: number;
  created_at: number;
}
interface Me {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
}

type Role = "viewer" | "operator" | "admin" | "owner";

const ROLES: Array<{ value: Role; label: string; can: string }> = [
  { value: "viewer", label: "Viewer", can: "Can inspect agents, sessions and usage. Cannot run or change anything." },
  { value: "operator", label: "Operator", can: "Can run sessions and evals and review approvals. Cannot change configuration." },
  { value: "admin", label: "Administrator", can: "Can change configuration, credentials, members and limits." },
  { value: "owner", label: "Owner", can: "Can do everything, including handing over ownership." },
];
const roleMeta = (role: string) => ROLES.find((r) => r.value === (role === "member" ? "operator" : role)) ?? ROLES[0];

const LIMIT_FIELDS = [
  { key: "daily_tokens", label: "Tokens per day", min: "1", step: "1" },
  { key: "daily_cost_usd", label: "Estimated cost per day (USD)", min: "0.01", step: "any" },
  { key: "max_concurrent_sessions", label: "Concurrent sessions", min: "1", step: "1" },
] as const;
type LimitKey = (typeof LIMIT_FIELDS)[number]["key"];

const AUDIT_PREVIEW = 8;

/**
 * Workspace settings: who you are here, who else is, how much agents may
 * spend, and a record of configuration changes. One narrow column, one
 * card per topic, the settings pattern the rest of the console follows.
 *
 * Each card is there only where the server keeps what it shows
 * (`useServerFeatures`): roles (`workspace_access`), the member list, role
 * changes and the history (`workspace_admin`), limits (`budgets`). A server
 * without the member list still has you: Members then shows your own row,
 * read-only, and says that roles are not managed here.
 */
export function WorkspaceSettings() {
  const features = useServerFeatures();
  const has = (key: "workspace_access" | "workspace_admin" | "budgets") => features.data?.features.has(key) ?? false;
  const accessOn = has("workspace_access");
  const adminOn = has("workspace_admin");
  const access = useApiQuery<WorkspaceAccess>(accessOn ? "/v1/workspace/access" : null);
  const me = useApiQuery<Me>("/v1/me");
  const auth = access.data?.authorization;
  const admin = !!auth && ["owner", "admin"].includes(auth.role);
  const editable = admin && auth?.kind !== "api_key" && adminOn;
  const budgetsSupported = !!access.data?.budgets_supported && has("budgets");

  const members = useApiQuery<{ data: Member[] }>("/v1/workspace/members", undefined, { enabled: admin && adminOn });
  const audit = useApiQuery<{ data: Audit[] }>("/v1/workspace/audit", AUDIT_PARAMS, { enabled: admin && adminOn });
  const budgets = useApiQuery<{ data: Budget[] }>("/v1/workspace/budgets", undefined, { enabled: admin && budgetsSupported });

  const tenantName = me.data?.tenant?.name;
  const topics = [admin ? "Members" : "Your access", budgetsSupported ? "execution limits" : "", adminOn ? "administrative history" : ""].filter(Boolean);
  const about = topics.length === 1 ? topics[0] : `${topics.slice(0, -1).join(", ")} and ${topics[topics.length - 1]}`;
  const loading = features.isLoading || (accessOn && access.isLoading);

  return (
    <Page
      width="narrow"
      header={
        // The header spans the frame, as on every top-level page: the title on
        // the one left edge, the action on the one right edge. The cards keep
        // the narrow measure a settings form reads at.
        <PageHeader
          title="Workspace"
          width="wide"
          subtitle={tenantName ? `${about} for ${tenantName}.` : `${about}.`}
          actions={
            <Button variant="outline" asChild>
              <Link to="/api-keys">
                <KeyRoundIcon data-icon="inline-start" />
                Manage API keys
              </Link>
            </Button>
          }
        />
      }
    >
      {accessOn && access.error ? (
        <ErrorState title="Your access could not be loaded" error={access.error} retry={access.refetch} />
      ) : loading ? (
        <LoadingStack />
      ) : !accessOn ? (
        // No roles on this server: everyone signed in manages the workspace.
        <div className="animate-rise-in space-y-6">
          <AccessCard auth={null} me={me.data ?? null} rolesKept={false} />
        </div>
      ) : (
        <div className="animate-rise-in space-y-6">
          {/* Who you are here is said once. An administrator finds themselves
              in Members (the row marked "You", with their role); everyone
              else, who has no member list to look at, gets this card. */}
          {!admin ? (
            <AccessCard auth={auth ?? null} me={me.data ?? null} />
          ) : auth?.kind === "api_key" ? (
            <Callout tone="neutral" title="Signed in with an API key">
              This key has {roleMeta(auth.role).label.toLowerCase()} access. Membership and limits can only be changed from a
              signed-in session, not with an API key.
            </Callout>
          ) : null}

          {admin && (
            <>
              <MembersCard
                query={adminOn ? members : ONLY_YOU}
                me={me.data ?? null}
                selfRole={auth?.role}
                editable={editable}
                viewerIsOwner={auth?.role === "owner"}
                listed={adminOn}
                onSaved={() => {
                  void members.refetch();
                  void audit.refetch();
                }}
              />
              {budgetsSupported && (
                <LimitsCard
                  supported
                  query={budgets}
                  editable={editable}
                  onSaved={() => {
                    void budgets.refetch();
                    void audit.refetch();
                  }}
                />
              )}
              {adminOn && <HistoryCard query={audit} me={me.data ?? null} />}
            </>
          )}
        </div>
      )}
    </Page>
  );
}

const AUDIT_PARAMS = { limit: "50" } as const;

type Query<T> = { data?: T; error: unknown; isLoading: boolean; isFetching: boolean; refetch: () => unknown };

/** Where the server keeps no member list: an empty one, so Members shows only you. */
const ONLY_YOU: Query<{ data: Member[] }> = { data: { data: [] }, error: null, isLoading: false, isFetching: false, refetch: () => undefined };

function LoadingStack() {
  return (
    <div className="space-y-6" aria-hidden="true">
      {[3, 2, 5].map((rows, i) => (
        <div key={i} className="surface rounded-xl">
          <div className="space-y-2 px-5 pt-5 pb-4">
            <Skeleton className="h-4 w-32" rounded="sm" />
            <Skeleton className="h-3 w-72 max-w-full" rounded="sm" />
          </div>
          <RowSkeletons rows={rows} />
        </div>
      ))}
    </div>
  );
}

function RowSkeletons({ rows }: { rows: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 border-t border-border px-5 py-3.5">
          <Skeleton className="size-7" rounded="full" />
          <Skeleton className="h-3.5 flex-1" rounded="sm" style={{ maxWidth: `${46 - i * 6}%` }} />
          <div className="flex-1" />
          <Skeleton className="h-3.5 w-20" rounded="sm" />
        </div>
      ))}
    </div>
  );
}

// ── Your access ─────────────────────────────────────────────────────────

/**
 * Who you are in this workspace and what that lets you do. Shown to
 * people who are not administrators: they see no member list, so this is
 * the one place their role is said. (An administrator's own row in
 * Members says it; showing both put the same person on the page twice.)
 */
function AccessCard({
  auth,
  me,
  rolesKept = true,
}: {
  auth: WorkspaceAccess["authorization"];
  me: Me | null;
  /** False on a server that keeps no workspace roles: there is no role to say. */
  rolesKept?: boolean;
}) {
  if (!rolesKept) {
    const name = me?.user?.name?.trim() || me?.user?.email || "You";
    return (
      <section className="surface rounded-xl">
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
          <Avatar name={name} size="lg" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-h3 text-fg" title={name}>
              {name}
            </p>
            {me?.user?.email && me.user.name && <p className="mt-0.5 truncate text-small text-fg-muted">{me.user.email}</p>}
          </div>
        </div>
        <div className="border-t border-border px-5 py-3 text-small text-fg-muted">
          This server keeps no workspace roles: everyone signed in to the workspace can run and change its agents.
        </div>
      </section>
    );
  }
  if (!auth) {
    return (
      <Callout tone="warning" title="No workspace role">
        This sign-in has no role in the workspace, so there is nothing to manage here.
      </Callout>
    );
  }
  const role = roleMeta(auth.role);
  const name = me?.user?.name?.trim() || me?.user?.email || "You";
  const viaKey = auth.kind === "api_key";
  return (
    <section className="surface rounded-xl">
      <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center">
        <Avatar name={name} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p className="truncate text-h3 text-fg" title={name}>
              {name}
            </p>
            <Chip>{role.label}</Chip>
            {viaKey && <Chip tone="outline">Signed in with an API key</Chip>}
          </div>
          <p className="mt-0.5 text-small text-fg-muted">{role.can}</p>
        </div>
      </div>
      <div className="border-t border-border px-5 py-3 text-small text-fg-muted">
        {viaKey
          ? "Membership and limits can only be changed from a signed-in session, not with an API key."
          : "A workspace administrator manages members, limits and the administrative history."}
      </div>
    </section>
  );
}

// ── Members ─────────────────────────────────────────────────────────────

function MembersCard({
  query,
  me,
  selfRole,
  editable,
  viewerIsOwner,
  listed: kept = true,
  onSaved,
}: {
  query: Query<{ data: Member[] }>;
  me: Me | null;
  /** The signed-in person's role, from the access report. */
  selfRole?: string;
  editable: boolean;
  viewerIsOwner: boolean;
  /** False on a server that keeps no member list: only your own row, read-only. */
  listed?: boolean;
  onSaved: () => void;
}) {
  const listed = query.data?.data ?? [];
  // A workspace whose member list is still empty (a single-person or local
  // workspace) has one member all the same: the person looking at it. Say
  // so, rather than "No members" under a card that names them.
  const onlyYou = listed.length === 0 && !!me?.user && !!selfRole;
  const rows: Member[] = onlyYou ? [{ user_id: me!.user!.id, role: selfRole!, created_at: 0 }] : listed;
  return (
    <SectionCard
      title="Members"
      description={kept ? "People in this workspace and what each may do." : "Who you are in this workspace."}
      flush
      footer={
        !kept ? (
          <span>This server does not list the other members or change roles from the console.</span>
        ) : (
          <dl className="grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
            {ROLES.map((r) => (
              <div key={r.value}>
                <dt className="text-xs font-medium text-fg">{r.label}</dt>
                <dd className="text-xs text-fg-subtle">{r.can}</dd>
              </div>
            ))}
          </dl>
        )
      }
    >
      {query.error ? (
        <div className="p-5">
          <ErrorState title="Members could not be loaded" error={query.error} retry={query.refetch} compact />
        </div>
      ) : query.isLoading ? (
        <RowSkeletons rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          variant="plain"
          title="No members to show"
          body="People appear here once they have signed in to this workspace."
        />
      ) : (
        <ul>
          {rows.map((member) => (
            <MemberRow
              key={member.user_id}
              member={member}
              isYou={!!me?.user && me.user.id === member.user_id}
              displayName={me?.user && me.user.id === member.user_id ? me.user.name?.trim() || me.user.email : undefined}
              caption={
                onlyYou
                  ? kept
                    ? "The only member so far. Others appear here once they sign in."
                    : me?.user?.name?.trim() && me.user.email
                      ? me.user.email
                      : "Your account"
                  : undefined
              }
              editable={editable && !onlyYou}
              readOnly={!kept}
              viewerIsOwner={viewerIsOwner}
              onSaved={onSaved}
            />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function MemberRow({
  member,
  isYou,
  displayName,
  caption,
  editable,
  viewerIsOwner,
  readOnly = false,
  onSaved,
}: {
  member: Member;
  isYou: boolean;
  displayName?: string;
  /** Replaces the "Joined …" line. */
  caption?: string;
  editable: boolean;
  viewerIsOwner: boolean;
  /** The role is said, not offered: there is nothing to change it with. */
  readOnly?: boolean;
  onSaved: () => void;
}) {
  const current = member.role === "member" ? "operator" : member.role;
  const [role, setRole] = useState(current);
  useEffect(() => setRole(current), [current]);
  const save = useApiMutation({
    onSuccess: () => {
      toast.success(`${displayName ?? member.user_id} is now ${roleMeta(role).label.toLowerCase()}`);
      onSaved();
    },
  });
  const locked = !editable || member.role === "owner";
  const dirty = role !== current;
  const name = displayName ?? member.user_id;
  // An email reads as a name; an opaque user id is set in mono.
  const looksLikeId = !displayName && !member.user_id.includes("@");
  const lockReason = !editable
    ? "Only an administrator in a signed-in session can change roles"
    : member.role === "owner"
      ? "An owner's role is changed by handing over ownership"
      : "";

  return (
    <li className="border-t border-border px-5 py-3 first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Avatar name={name} size="md" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className={cn("truncate text-small-size font-medium text-fg", looksLikeId && "font-mono font-normal")} title={member.user_id}>
              {name}
            </p>
            {isYou && <Chip>You</Chip>}
          </div>
          <p className="text-xs text-fg-subtle">
            {caption ?? (
              <>
                Joined <RelativeTime value={toMillis(member.created_at)} fallback="at an unknown time" />
              </>
            )}
          </p>
        </div>
        {readOnly ? (
          <Chip className="shrink-0">{roleMeta(current).label}</Chip>
        ) : (
          <div className="flex shrink-0 items-center gap-2">
            {dirty && (
              <>
                <Button variant="ghost" size="sm" onClick={() => setRole(current)} disabled={save.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  loading={save.isPending}
                  onClick={() =>
                    save.mutate({ path: `/v1/workspace/members/${encodeURIComponent(member.user_id)}`, method: "PUT", body: { role } })
                  }
                >
                  Save role
                </Button>
              </>
            )}
            <Tip label={lockReason}>
              <span>
                <Select
                  value={role}
                  onValueChange={setRole}
                  disabled={locked || save.isPending}
                  placeholder={`Role for ${name}`}
                  className="h-8 w-[9.5rem]"
                >
                  <SelectOption value="viewer">Viewer</SelectOption>
                  <SelectOption value="operator">Operator</SelectOption>
                  <SelectOption value="admin">Administrator</SelectOption>
                  {(viewerIsOwner || member.role === "owner") && <SelectOption value="owner">Owner</SelectOption>}
                </Select>
              </span>
            </Tip>
          </div>
        )}
      </div>
      {save.error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          The role was not changed. {failureSentence(save.error)}
        </p>
      )}
    </li>
  );
}

// ── Execution limits ────────────────────────────────────────────────────

function limitChips(b: Budget): string[] {
  const out: string[] = [];
  if (b.daily_tokens != null) out.push(`${formatCompact(b.daily_tokens)} tokens a day`);
  if (b.daily_cost_usd != null) out.push(`${formatCost(b.daily_cost_usd)} a day`);
  if (b.max_concurrent_sessions != null) out.push(`${plural(b.max_concurrent_sessions, "session")} at once`);
  return out;
}

function LimitsCard({
  supported,
  query,
  editable,
  onSaved,
}: {
  supported: boolean;
  query: Query<{ data: Budget[] }>;
  editable: boolean;
  onSaved: () => void;
}) {
  const { agents, byId, error: agentsError, refetch: refetchAgents } = useAgents();
  const [scope, setScope] = useState("workspace");
  const [draft, setDraft] = useState<Record<LimitKey, string>>({ daily_tokens: "", daily_cost_usd: "", max_concurrent_sessions: "" });
  const [validation, setValidation] = useState("");
  const rows = useMemo(() => query.data?.data ?? [], [query.data]);
  const scopeName = (id: string) => (id === "workspace" ? "Entire workspace" : (byId.get(id)?.name ?? "A deleted agent"));

  const save = useApiMutation({
    onSuccess: () => {
      toast.success(`Limits saved for ${scope === "workspace" ? "the workspace" : scopeName(scope)}`);
      onSaved();
    },
  });

  useEffect(() => {
    const current = rows.find((row) => row.scope_id === scope);
    setDraft({
      daily_tokens: current?.daily_tokens?.toString() ?? "",
      daily_cost_usd: current?.daily_cost_usd?.toString() ?? "",
      max_concurrent_sessions: current?.max_concurrent_sessions?.toString() ?? "",
    });
    setValidation("");
  }, [scope, rows]);

  function saveBudget() {
    const body = Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() === "" ? null : Number(value)]));
    for (const [key, value] of Object.entries(body)) {
      if (value !== null && (!Number.isFinite(value) || value <= 0 || (key !== "daily_cost_usd" && !Number.isSafeInteger(value)))) {
        setValidation("Enter positive limits. Tokens and concurrent sessions must be whole numbers.");
        return;
      }
    }
    setValidation("");
    save.mutate({ path: `/v1/workspace/budgets/${encodeURIComponent(scope)}`, method: "PUT", body });
  }

  if (!supported) {
    return (
      <SectionCard title="Execution limits" description="Caps on what agents may spend in a day.">
        <Callout tone="neutral">This runtime does not support workspace execution limits.</Callout>
      </SectionCard>
    );
  }

  const activeAgents = agents.filter((a) => !a.archived_at);
  // Scopes that have a limit but no longer match a listed agent still need to be reachable.
  const orphanScopes = rows.filter((r) => r.scope_id !== "workspace" && !activeAgents.some((a) => a.id === r.scope_id));
  const inPlace = rows.map((r) => ({ row: r, chips: limitChips(r) })).filter((r) => r.chips.length > 0);
  const saved = rows.find((r) => r.scope_id === scope);
  const dirty = LIMIT_FIELDS.some((f) => draft[f.key] !== (saved?.[f.key]?.toString() ?? ""));

  return (
    <SectionCard
      title="Execution limits"
      description="Caps on what agents may spend. Daily totals reset at midnight UTC."
      footer={
        <span>
          Cost limits use API-price estimates. A model request already in flight can pass a limit before its usage is reported.
        </span>
      }
    >
      {query.error ? (
        <ErrorState title="Limits could not be loaded" error={query.error} retry={query.refetch} compact />
      ) : query.isLoading ? (
        <div className="space-y-4" aria-hidden="true">
          <Skeleton className="h-9 w-full" rounded="md" />
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-9" rounded="md" />
            <Skeleton className="h-9" rounded="md" />
            <Skeleton className="h-9" rounded="md" />
          </div>
        </div>
      ) : (
        <div className="space-y-5">
          {agentsError != null && (
            <ErrorState title="Agents could not be loaded for the list below" error={agentsError} retry={refetchAgents} compact />
          )}

          {inPlace.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-subtle">Limits in place</p>
              <ul className="overflow-hidden rounded-lg border border-border">
                {inPlace.map(({ row, chips }) => (
                  <li key={row.scope_id} className="border-t border-border first:border-t-0">
                    <button
                      type="button"
                      onClick={() => setScope(row.scope_id)}
                      aria-pressed={scope === row.scope_id}
                      className={cn(
                        "flex w-full flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 py-2.5 text-left transition-quick hover:bg-bg-hover",
                        scope === row.scope_id && "bg-bg-soft",
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate text-small-size font-medium text-fg">{scopeName(row.scope_id)}</span>
                      <span className="flex flex-wrap gap-1.5">
                        {chips.map((c) => (
                          <Chip key={c}>{c}</Chip>
                        ))}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <Field label="Applies to" hint="Agent limits apply alongside the workspace limits, never instead of them.">
            <Select value={scope} onValueChange={setScope} placeholder="Budget scope" disabled={save.isPending}>
              <SelectOption value="workspace">Entire workspace</SelectOption>
              {(activeAgents.length > 0 || orphanScopes.length > 0) && (
                <SelectGroup>
                  <SelectGroupLabel>One agent</SelectGroupLabel>
                  {activeAgents.map((agent) => (
                    <SelectOption key={agent.id} value={agent.id}>
                      {agent.name}
                    </SelectOption>
                  ))}
                  {orphanScopes.map((row) => (
                    <SelectOption key={row.scope_id} value={row.scope_id}>
                      {scopeName(row.scope_id)}
                    </SelectOption>
                  ))}
                </SelectGroup>
              )}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            {LIMIT_FIELDS.map((f) => (
              <Field key={f.key} label={f.label}>
                <Input
                  type="number"
                  inputMode="decimal"
                  min={f.min}
                  step={f.step}
                  placeholder="No limit"
                  value={draft[f.key]}
                  disabled={!editable || save.isPending}
                  onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
                />
              </Field>
            ))}
          </div>

          {validation && (
            <Callout tone="danger" title="These limits cannot be saved">
              {validation}
            </Callout>
          )}
          {save.error && (
            <Callout tone="danger" title="The limits were not saved">
              {failureSentence(save.error)}
            </Callout>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-fg-subtle">
              {editable ? "Leave a field empty to remove that limit." : "Only an administrator in a signed-in session can change limits."}
            </p>
            <Button onClick={saveBudget} disabled={!editable || !dirty} loading={save.isPending}>
              Save limits
            </Button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ── Administrative history ──────────────────────────────────────────────

const NOUNS: Record<string, string> = {
  agents: "agent",
  sessions: "session",
  environments: "environment",
  vaults: "vault",
  credentials: "credential",
  memory_stores: "memory store",
  memories: "memory",
  skills: "skill",
  model_cards: "model",
  api_keys: "API key",
  deployments: "deployment",
  runtimes: "runtime",
  evals: "eval",
  files: "file",
  missions: "mission",
  "ambient-rules": "trigger",
  members: "member role",
  budgets: "execution limits",
  integrations: "integration",
  composio: "Composio connection",
};
const VERBS: Record<string, string> = {
  archive: "Archived",
  unarchive: "Restored",
  restore: "Restored",
  cancel: "Cancelled",
  stop: "Stopped",
  retry: "Retried",
  deploy: "Deployed",
  rotate: "Rotated",
};
const RESOLVABLE = new Set(["agents", "vaults", "environments"]);
const article = (noun: string) => (/^(execution|member)/.test(noun) ? "" : /^[aeiou]/i.test(noun) ? "an " : "a ");

/** Turn "POST /v1/agents/agent-x/archive" into "Archived agent" + the record to name. */
function describeAudit(method: string, path: string): { text: string; collection?: string; id?: string } {
  const parts = path.replace(/^\/v1(?:\/oma)?\/?/, "").split("/").filter(Boolean);
  // /workspace/members/:id and /workspace/budgets/:scope read as their sub-collection.
  if (parts[0] === "workspace" && parts[1]) parts.shift();
  const [collection, id, sub] = parts;
  const noun = NOUNS[collection ?? ""];
  if (!noun) return { text: `${method} ${path}` };
  const ref = id && RESOLVABLE.has(collection) ? { collection, id } : {};
  if (method === "DELETE") return { text: id ? `Deleted ${noun}` : `Cleared ${noun}`, ...ref };
  if (sub && VERBS[sub]) return { text: `${VERBS[sub]} ${noun}`, ...ref };
  if (sub) {
    const subNoun = NOUNS[sub] ?? sub.replace(/[-_]/g, " ");
    return { text: `Added ${article(subNoun)}${subNoun} to ${noun}`, ...ref };
  }
  if (!id && method === "POST") return { text: `Created ${article(noun)}${noun}` };
  return { text: `Updated ${noun}`, ...ref };
}

const ACTOR_KIND: Record<string, string> = {
  session: "Signed-in session",
  api_key: "API key",
  development: "Local development",
};

function HistoryCard({ query, me }: { query: Query<{ data: Audit[] }>; me: Me | null }) {
  const [showAll, setShowAll] = useState(false);
  const rows = query.data?.data ?? [];
  const visible = showAll ? rows : rows.slice(0, AUDIT_PREVIEW);

  // Names for the records the requests touched, from the cached lists. A
  // deleted record stays unnamed here: the log must not trigger failing reads.
  const { byId: agentsById } = useAgents();
  const vaults = useApiQuery<{ data: Array<{ id: string; name: string }> }>("/v1/vaults", LIST_PARAMS, { staleTime: 300_000 });
  const environments = useApiQuery<{ data: Array<{ id: string; name: string }> }>("/v1/environments", LIST_PARAMS, { staleTime: 300_000 });
  const nameOf = (collection?: string, id?: string): string | undefined => {
    if (!collection || !id) return undefined;
    if (collection === "agents") return agentsById.get(id)?.name;
    const list = collection === "vaults" ? vaults.data?.data : environments.data?.data;
    return list?.find((row) => row.id === id)?.name;
  };

  return (
    <SectionCard
      title="Administrative history"
      description="The 50 most recent configuration requests, including rejected ones."
      flush
      actions={
        <Button variant="ghost" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching} aria-label="Refresh history">
          <RotateCwIcon data-icon="inline-start" className={cn(query.isFetching && "animate-spin")} />
          Refresh
        </Button>
      }
      footer={
        rows.length > AUDIT_PREVIEW ? (
          <div className="flex items-center justify-between gap-3">
            <span>
              Showing {visible.length} of {rows.length}
            </span>
            <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
              {showAll ? "Show fewer" : `Show all ${rows.length}`}
            </Button>
          </div>
        ) : undefined
      }
    >
      {query.error ? (
        <div className="p-5">
          <ErrorState title="History could not be loaded" error={query.error} retry={query.refetch} compact />
        </div>
      ) : query.isLoading ? (
        <RowSkeletons rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          size="sm"
          variant="plain"
          title="No administrative requests yet"
          body="Changes to agents, credentials, members and limits are recorded here."
        />
      ) : (
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">Recent administrative requests</caption>
          <colgroup>
            <col />
            <col className="w-[7.5rem]" />
            <col className="w-[7.5rem]" />
            <col className="w-[6rem]" />
          </colgroup>
          <thead>
            <tr>
              <HeadCell className="pl-5">Change</HeadCell>
              <HeadCell>By</HeadCell>
              <HeadCell>Result</HeadCell>
              <HeadCell className="pr-5 text-right">When</HeadCell>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => {
              const d = describeAudit(row.method, row.path);
              const name = nameOf(d.collection, d.id);
              const ok = row.status < 400;
              const kind = ACTOR_KIND[row.actor_kind] ?? row.actor_kind;
              const isMe = !!me?.user && row.actor_id === me.user.id;
              const actor = isMe ? me.user!.name?.trim() || me.user!.email : row.actor_id || kind;
              return (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-2.5 pr-4 pl-5 align-middle">
                    <p className="truncate text-small-size text-fg" title={name ? `${d.text} ${name}` : d.text}>
                      {d.text}
                      {name && <span className="font-medium"> {name}</span>}
                    </p>
                    <p className="truncate font-mono text-xs text-fg-subtle" title={`${row.method} ${row.path}`}>
                      {row.method} {row.path}
                    </p>
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <span className="block truncate text-small-size text-fg-muted" title={[actor, row.actor_id && row.actor_id !== actor ? row.actor_id : null, kind].filter(Boolean).join(" · ")}>
                      {actor}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 align-middle">
                    <Tip label={`HTTP ${row.status}`}>
                      <span className="inline-flex">
                        <StatusBadge
                          status={ok ? "success" : "failed"}
                          label={ok ? "Accepted" : row.status >= 500 ? "Failed" : "Rejected"}
                        />
                      </span>
                    </Tip>
                  </td>
                  <td className="py-2.5 pr-5 pl-4 text-right align-middle text-small-size">
                    <RelativeTime value={toMillis(row.created_at)} className="text-fg-muted" fallback="Not recorded" />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SectionCard>
  );
}

const LIST_PARAMS = { limit: "200" } as const;

function HeadCell({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn("h-9 px-4 text-xs font-medium whitespace-nowrap text-fg-subtle", className)}>
      {children}
    </th>
  );
}
