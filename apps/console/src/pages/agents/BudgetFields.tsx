import type { AgentBudget } from "@open-managed-agents/api-types";

/**
 * Agent budget (usage limits) editor — `agent.metadata.budget`
 * (docs/budgets.md). Kept out of AgentFormDialog: the dialog only stores a
 * string draft per field and converts with budgetFromDraft / draftFromBudget.
 */

export type BudgetDraft = Record<keyof AgentBudget, string>;

export const EMPTY_BUDGET_DRAFT: BudgetDraft = {
  max_tokens_per_turn: "",
  max_tokens_per_session: "",
  max_cost_usd_per_session: "",
  max_turn_wall_clock_seconds: "",
  max_steps_per_turn: "",
};

const FIELDS: Array<{
  key: keyof AgentBudget;
  label: string;
  hint: string;
  integer: boolean;
  step?: string;
}> = [
  { key: "max_tokens_per_turn", label: "Tokens per turn", hint: "input + output tokens across one turn's model calls", integer: true },
  { key: "max_tokens_per_session", label: "Tokens per session", hint: "across every turn of a session", integer: true },
  { key: "max_cost_usd_per_session", label: "Cost per session (USD)", hint: "estimated from the model price table", integer: false, step: "0.01" },
  { key: "max_turn_wall_clock_seconds", label: "Turn wall-clock (seconds)", hint: "the turn is aborted after this long", integer: false, step: "1" },
  { key: "max_steps_per_turn", label: "Model calls per turn", hint: "replaces the default cap of 100", integer: true },
];

/** Draft → budget. Blank fields are omitted; returns null when nothing is set.
 *  Invalid entries are reported in `errors` (keyed by field). */
export function budgetFromDraft(draft: BudgetDraft): {
  budget: AgentBudget | null;
  errors: Partial<Record<keyof AgentBudget, string>>;
} {
  const budget: AgentBudget = {};
  const errors: Partial<Record<keyof AgentBudget, string>> = {};
  for (const f of FIELDS) {
    const raw = (draft[f.key] ?? "").trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      errors[f.key] = "Must be a positive number";
      continue;
    }
    if (f.integer && !Number.isInteger(n)) {
      errors[f.key] = "Must be a whole number";
      continue;
    }
    budget[f.key] = n;
  }
  return { budget: Object.keys(budget).length > 0 ? budget : null, errors };
}

export function draftFromBudget(raw: unknown): BudgetDraft {
  const draft = { ...EMPTY_BUDGET_DRAFT };
  if (!raw || typeof raw !== "object") return draft;
  for (const f of FIELDS) {
    const v = (raw as Record<string, unknown>)[f.key];
    if (typeof v === "number" && Number.isFinite(v)) draft[f.key] = String(v);
  }
  return draft;
}

export function BudgetFields({
  value,
  onChange,
  inputClassName,
}: {
  value: BudgetDraft;
  onChange: (next: BudgetDraft) => void;
  inputClassName?: string;
}) {
  const { budget, errors } = budgetFromDraft(value);
  const count = budget ? Object.keys(budget).length : 0;
  return (
    <details className="rounded-lg border border-border px-3 py-2" open={count > 0}>
      <summary className="text-sm text-fg-muted cursor-pointer select-none">
        Budget (usage limits){count > 0 ? ` — ${count} set` : ""}
      </summary>
      <p className="text-xs text-fg-subtle mt-2 mb-2">
        Checked before every model call. When a limit would be exceeded the turn stops with stop
        reason <code>budget_exhausted</code>. Leave blank for no limit. Sessions keep the budget
        of the agent version they started with.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map((f) => (
          <div key={f.key}>
            <label htmlFor={`agent-budget-${f.key}`} className="text-xs text-fg-muted block mb-1">
              {f.label}
            </label>
            <input
              id={`agent-budget-${f.key}`}
              type="number"
              inputMode={f.integer ? "numeric" : "decimal"}
              min={0}
              step={f.step ?? "1"}
              value={value[f.key]}
              placeholder="No limit"
              aria-invalid={errors[f.key] ? true : undefined}
              onChange={(e) => onChange({ ...value, [f.key]: e.target.value })}
              className={inputClassName}
            />
            <p className={`text-[11px] mt-0.5 ${errors[f.key] ? "text-danger" : "text-fg-subtle"}`}>
              {errors[f.key] ?? f.hint}
            </p>
          </div>
        ))}
      </div>
    </details>
  );
}
