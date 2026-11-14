import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { ApiError, useApi } from "./api";
import { runName, type EvalRun } from "./evals";
import { useApiQuery } from "./useApiQuery";
import { useServerFeatures } from "./server-features";
import type { OperationsReport } from "./operations";
import { attentionBySession, sessionTitle } from "./sessions";
import type { AgentRecord } from "../types/agent";
import type { SessionRecord } from "../types/session";

/**
 * The workspace directory: small, shared, cached reads that let any screen
 * show a NAME where the API hands it an id, and show activity next to an
 * agent. Every hook here hits an existing list endpoint through the normal
 * API client and is deduplicated by TanStack Query, so calling the same
 * hook from the sidebar, the command palette and a page costs one request.
 */

const MINUTE = 60_000;

/** All agents in the workspace (active and archived), newest first. */
export function useAgents() {
  const query = useApiQuery<{ data: AgentRecord[] }>(
    "/v1/agents",
    DIRECTORY_AGENT_PARAMS,
    { staleTime: MINUTE },
  );
  const agents = query.data?.data ?? EMPTY_AGENTS;
  const byId = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  return { ...query, agents, byId };
}
const DIRECTORY_AGENT_PARAMS = { limit: "200", status: "any" } as const;
const EMPTY_AGENTS: AgentRecord[] = [];

/** The most recent sessions (up to 100), newest first. */
export function useRecentSessions() {
  const query = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    RECENT_SESSION_PARAMS,
    { staleTime: 20_000, refetchInterval: MINUTE },
  );
  const sessions = query.data?.data ?? EMPTY_SESSIONS;
  return { ...query, sessions };
}
const RECENT_SESSION_PARAMS = { limit: "100" } as const;
const EMPTY_SESSIONS: SessionRecord[] = [];

export interface AgentActivity {
  /** Sessions in the recent window (last 100 workspace sessions). */
  sessions: number;
  running: number;
  /** ISO timestamp of the newest session, or null when it has none. */
  lastActiveAt: string | null;
}

/** Per-agent activity derived from the recent sessions window. */
export function useAgentActivity() {
  const { sessions, isLoading } = useRecentSessions();
  const byAgent = useMemo(() => {
    const map = new Map<string, AgentActivity>();
    for (const s of sessions) {
      const id = s.agent?.id;
      if (!id) continue;
      const cur = map.get(id) ?? { sessions: 0, running: 0, lastActiveAt: null };
      cur.sessions += 1;
      if (s.status === "running") cur.running += 1;
      const at = s.updated_at || s.created_at;
      if (!cur.lastActiveAt || at > cur.lastActiveAt) cur.lastActiveAt = at;
      map.set(id, cur);
    }
    return map;
  }, [sessions]);
  return { byAgent, isLoading };
}

/**
 * Operations report (pending approvals, failed work, budgets). Shares its
 * cache entry with <OperationsSummary> and the Operations page.
 *
 * Only some servers have it (`useServerFeature("operations")`). Where it is
 * not, the report is never asked for: `unsupported` is true, `report` stays
 * undefined and every count is 0, so the sidebar badge, Home and the
 * session readings all fall back together to what the session lists and
 * logs can say. `isLoading` covers the wait for the feature list too, so no
 * caller draws "nothing waiting" before it is known whether anything could
 * be. A runtime that lists the feature but answers 501 is `unsupported`
 * as well.
 */
export function useOperations() {
  const { api } = useApi();
  const features = useServerFeatures();
  const available = features.data?.features.has("operations") ?? false;
  const query = useQuery({
    queryKey: ["/v1/operations"],
    queryFn: ({ signal }) => api<OperationsReport>("/v1/operations", { signal, silentErrors: true }),
    enabled: available,
    retry: false,
    staleTime: 20_000,
    refetchInterval: MINUTE,
  });
  const featuresLoading = features.isLoading;
  // Anything but a report (a stub, an older shape) is no report.
  const report = isOperationsReport(query.data) ? query.data : undefined;
  const summary = useMemo(() => {
    const approvals = report?.sessions.reduce((n, s) => n + s.pending_approvals.length, 0) ?? 0;
    const failed =
      report?.work_items.filter((w) => w.status === "failed" || w.status === "dead_letter").length ?? 0;
    return { approvals, failed, total: approvals + failed, attention: attentionBySession(report) };
  }, [report]);
  const unsupported =
    (!featuresLoading && !available) || (query.error instanceof ApiError && query.error.status === 501);
  return {
    ...query,
    // A disabled query is never "loading"; until the feature list answers it is.
    isLoading: featuresLoading || (available && query.isLoading),
    // A missing report is not an error the person can retry.
    error: unsupported ? null : query.error,
    report,
    unsupported,
    ...summary,
  };
}

function isOperationsReport(value: unknown): value is OperationsReport {
  const r = value as Partial<OperationsReport> | null | undefined;
  return !!r && Array.isArray(r.sessions) && Array.isArray(r.work_items);
}

// ────────────────────────────────────────────────────────────────────────
// Resolve an id to a name.
// ────────────────────────────────────────────────────────────────────────

export type EntityKind = "agent" | "session" | "environment" | "vault" | "memory_store" | "eval_run";

interface EntityMeta {
  /** Collection endpoint. `${endpoint}/${id}` fetches one. */
  endpoint: string;
  /** Console route prefix: `${route}/${id}`. */
  route: string;
  /** Singular noun for fallbacks and tooltips. */
  noun: string;
  /** Whether to warm the directory from the list endpoint (small collections). */
  list: boolean;
}

export const ENTITY_META: Record<EntityKind, EntityMeta> = {
  agent: { endpoint: "/v1/agents", route: "/agents", noun: "Agent", list: true },
  session: { endpoint: "/v1/sessions", route: "/sessions", noun: "Session", list: false },
  environment: { endpoint: "/v1/environments", route: "/environments", noun: "Environment", list: true },
  vault: { endpoint: "/v1/vaults", route: "/vaults", noun: "Vault", list: true },
  memory_store: { endpoint: "/v1/memory_stores", route: "/memory", noun: "Memory store", list: true },
  // A run has no name of its own: it is called by its suite, or by what kind of run it is.
  eval_run: { endpoint: "/v1/evals/runs", route: "/evals", noun: "Eval run", list: false },
};

interface Named {
  id: string;
  name?: string | null;
  title?: string | null;
  agent?: { name?: string };
}

const LIST_PARAMS = { limit: "200" } as const;

/**
 * Name for an entity id. Looks in the cached list for the kind first, then
 * falls back to a single GET (archived rows, or more than 200 of a kind).
 * While loading, `name` is undefined: render a skeleton, not the id.
 */
export function useEntityName(kind: EntityKind, id: string | null | undefined) {
  const meta = ENTITY_META[kind];
  const listParams = kind === "agent" ? DIRECTORY_AGENT_PARAMS : LIST_PARAMS;
  const list = useApiQuery<{ data: Named[] }>(meta.list && id ? meta.endpoint : null, listParams, {
    staleTime: 5 * MINUTE,
  });
  const fromList = id ? list.data?.data.find((row) => row.id === id) : undefined;
  const needSingle = !!id && !fromList && (!meta.list || !list.isLoading);
  const single = useApiQuery<Named>(needSingle ? `${meta.endpoint}/${id}` : null, undefined, {
    staleTime: 5 * MINUTE,
  });
  const row = fromList ?? single.data;
  const isLoading = !!id && !row && (list.isLoading || single.isLoading);
  let name: string | undefined;
  if (row) {
    name =
      row.name?.trim() ||
      // A session is named by the one rule every list uses (a mission
      // iteration's title carries an id and is never shown as written).
      (kind === "session" && (row.title?.trim() || row.agent?.name) ? sessionTitle({ title: row.title, agent: row.agent as never }) : undefined) ||
      row.title?.trim() ||
      (kind === "eval_run" ? runName(row as unknown as EvalRun) : undefined) ||
      undefined;
  }
  return {
    name,
    isLoading,
    /** True when the lookups finished and nothing matched (deleted, no access). */
    missing: !!id && !row && !isLoading,
    href: id ? `${meta.route}/${id}` : undefined,
    noun: meta.noun,
  };
}
