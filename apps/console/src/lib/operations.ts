export interface BudgetScope {
  scope_id: string;
  limits: { daily_tokens: number | null; daily_cost_usd: number | null; max_concurrent_sessions: number | null };
  usage: { tokens: number; estimated_cost_usd: number; active_sessions: number; unpriced_calls: number };
  exceeded: string[];
}

export interface OperationsReport {
  sessions: Array<{
    id: string; title: string; agent_id: string; status: string;
    updated_at: string | number; last_event_at: string | number | null; error: string | null;
    pending_approvals: Array<{ tool_use_id: string; name: string; input: unknown; requested_at: string | number }>;
  }>;
  missions: Array<{
    id: string; goal: string; status: string; iteration: number; active_session_id: string | null; updated_at: number;
    /** Sent by the Node runtime; older runtimes omit them. */
    agent_id?: string; created_at?: number;
    budget?: { max_iterations?: number; wall_clock_minutes?: number };
  }>;
  work_items: Array<{
    id: string; sessionId: string; status: string; attempts: number; lastError: string | null; updatedAt: number;
    /** Sent by the Node runtime; older runtimes omit them. */
    agentId?: string; createdAt?: number;
    /** The queued event this item was processing (the message that failed). */
    event?: { type?: string; content?: Array<{ type?: string; text?: string }> | string };
  }>;
  usage: { totals: { cost_usd: number; processed_tokens: number; sessions: number; calls?: number } };
  budgets: BudgetScope[];
  truncated: boolean;
}

export interface WorkspaceAccess {
  authorization: { role: "owner" | "admin" | "operator" | "viewer"; kind: string; scopes?: string[] } | null;
  budgets_supported: boolean;
}

export function budgetWarnings(scope: BudgetScope): string[] {
  const warnings: string[] = [];
  for (const [label, limit, used] of [
    ["Daily tokens", scope.limits.daily_tokens, scope.usage.tokens],
    ["Daily estimated cost", scope.limits.daily_cost_usd, scope.usage.estimated_cost_usd],
    ["Concurrent sessions", scope.limits.max_concurrent_sessions, scope.usage.active_sessions],
  ] as const) {
    if (limit !== null && limit > 0 && used / limit >= 0.8) warnings.push(`${label}: ${Math.round(100 * used / limit)}% of limit used`);
  }
  if (scope.limits.daily_cost_usd !== null && scope.usage.unpriced_calls > 0) {
    warnings.push(`${scope.usage.unpriced_calls} calls have no price estimate. Resolve model pricing to resume cost-limited work.`);
  }
  return warnings;
}

export const displayDate = (value: string | number | null | undefined) => value == null ? "Not recorded" : new Date(value).toLocaleString();
