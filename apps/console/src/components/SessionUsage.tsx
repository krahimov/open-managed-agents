import { useEffect, useState } from "react";
import type { AgentBudget, BudgetName, ModelUsageReport } from "@open-managed-agents/api-types";
import { useApi } from "../lib/api";
import { Badge } from "./Badge";

/**
 * Session token / cost usage (GET /v1/sessions/:id/usage) and the
 * budget-exhausted notice (docs/budgets.md).
 *
 *   <SessionUsageBadge>  header chip "12.4k tokens · $0.0312"; click to
 *                        expand per-model totals and the agent budget.
 *   <BudgetStopNotice>   rendering of the `session.warning` with source
 *                        `budget_exhausted` the runtime writes when a
 *                        budget ends a turn.
 */

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

const BUDGET_LABELS: Record<BudgetName, { label: string; unit: "tokens" | "usd" | "seconds" | "calls" }> = {
  max_tokens_per_turn: { label: "Tokens per turn", unit: "tokens" },
  max_tokens_per_session: { label: "Tokens per session", unit: "tokens" },
  max_cost_usd_per_session: { label: "Cost per session", unit: "usd" },
  max_turn_wall_clock_seconds: { label: "Turn wall-clock", unit: "seconds" },
  max_steps_per_turn: { label: "Model calls per turn", unit: "calls" },
  tenant_daily_tokens: { label: "Tenant daily tokens", unit: "tokens" },
  tenant_daily_cost_usd: { label: "Tenant daily cost", unit: "usd" },
};

function formatBudgetValue(name: BudgetName, v: number): string {
  const unit = BUDGET_LABELS[name]?.unit;
  if (unit === "usd") return formatUsd(v);
  if (unit === "tokens") return `${formatTokens(v)} tokens`;
  if (unit === "seconds") return `${v}s`;
  if (unit === "calls") return `${v} calls`;
  return String(v);
}

export function budgetLabel(name: string): string {
  return BUDGET_LABELS[name as BudgetName]?.label ?? name;
}

export function SessionUsageBadge({
  sessionId,
  refreshKey,
}: {
  sessionId: string;
  /** Changes whenever a model call finished (e.g. count of
   *  span.model_request_end events) — triggers a refetch. */
  refreshKey?: number | string;
}) {
  const { api } = useApi();
  const [report, setReport] = useState<ModelUsageReport | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api<ModelUsageReport>(`/v1/sessions/${sessionId}/usage`, { silentErrors: true });
        if (!cancelled) setReport(r);
      } catch {
        // Older servers don't have the endpoint — just hide the badge.
        if (!cancelled) setReport(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, sessionId, refreshKey]);

  if (!report || (report.totals.model_calls === 0 && !report.budget)) return null;
  const t = report.totals;
  const label = `${formatTokens(t.total_tokens)} tokens${t.cost_usd !== null ? ` · ${formatUsd(t.cost_usd)}` : ""}`;
  return (
    <span className="relative">
      <Badge label={label} title="Model token usage and estimated cost" onClick={() => setOpen((v) => !v)} />
      {open && (
        <div
          role="dialog"
          aria-label="Session usage"
          className="absolute z-20 mt-1 left-0 w-80 rounded-md border border-border bg-bg p-3 text-xs shadow-lg"
        >
          <UsageDetails report={report} />
        </div>
      )}
    </span>
  );
}

export function UsageDetails({ report }: { report: ModelUsageReport }) {
  const t = report.totals;
  const budget: AgentBudget | null | undefined = report.budget;
  const used: Partial<Record<BudgetName, number>> = {
    max_tokens_per_session: t.total_tokens,
    ...(t.cost_usd !== null ? { max_cost_usd_per_session: t.cost_usd } : {}),
  };
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">
        <span className="text-fg-subtle">Model calls</span>
        <span>{t.model_calls}</span>
        <span className="text-fg-subtle">Input tokens</span>
        <span>{t.input_tokens.toLocaleString()}</span>
        <span className="text-fg-subtle">Output tokens</span>
        <span>{t.output_tokens.toLocaleString()}</span>
        <span className="text-fg-subtle">Cache read</span>
        <span>{t.cache_read_input_tokens.toLocaleString()}</span>
        <span className="text-fg-subtle">Est. cost</span>
        <span>{t.cost_usd !== null ? formatUsd(t.cost_usd) : "unknown"}</span>
      </div>
      {t.unpriced_calls > 0 && (
        <div className="text-fg-subtle">
          {t.unpriced_calls} call(s) use a model without a known price and aren't in the cost.
        </div>
      )}
      {report.by_model.length > 1 && (
        <div>
          <div className="text-[10px] uppercase text-fg-subtle mb-0.5">By model</div>
          {report.by_model.map((m) => (
            <div key={m.model} className="flex justify-between font-mono">
              <span className="truncate">{m.model || "(unknown)"}</span>
              <span>
                {formatTokens(m.total_tokens)}
                {m.cost_usd !== null ? ` · ${formatUsd(m.cost_usd)}` : ""}
              </span>
            </div>
          ))}
        </div>
      )}
      {budget && Object.keys(budget).length > 0 && (
        <div>
          <div className="text-[10px] uppercase text-fg-subtle mb-0.5">Budget</div>
          {(Object.entries(budget) as Array<[BudgetName, number]>).map(([name, limit]) => (
            <div key={name} className="flex justify-between font-mono">
              <span>{budgetLabel(name)}</span>
              <span>
                {used[name] !== undefined ? `${formatBudgetValue(name, used[name]!)} / ` : ""}
                {formatBudgetValue(name, limit)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function nextStepHint(name: BudgetName): string {
  switch (name) {
    case "max_tokens_per_turn":
    case "max_steps_per_turn":
    case "max_turn_wall_clock_seconds":
      return "Send a message to continue.";
    case "tenant_daily_tokens":
    case "tenant_daily_cost_usd":
      return "The daily limit resets at 00:00 UTC.";
    default:
      // Session budgets are pinned with the agent snapshot.
      return "This session can't make more model calls; raise the agent's budget and start a new session.";
  }
}

/** session.warning { source: "budget_exhausted", details: { budget, limit, used } }. */
export function BudgetStopNotice({ event }: { event: { message?: unknown; details?: unknown } }) {
  const d = (event.details ?? {}) as { budget?: BudgetName; limit?: number; used?: number };
  const name = d.budget;
  return (
    <div
      role="status"
      className="max-w-2xl bg-warning-subtle rounded-lg px-4 py-2.5 text-sm text-warning"
    >
      <div className="font-medium mb-0.5">Budget exhausted{name ? `: ${budgetLabel(name)}` : ""}</div>
      {name && typeof d.limit === "number" && typeof d.used === "number" ? (
        <div>
          Used {formatBudgetValue(name, d.used)} of {formatBudgetValue(name, d.limit)}.{" "}
          {name === "max_turn_wall_clock_seconds"
            ? "The turn was aborted."
            : "The agent stopped before its next model call."}{" "}
          {nextStepHint(name)}
        </div>
      ) : (
        <div>{String(event.message ?? "")}</div>
      )}
    </div>
  );
}
