import { beforeEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BudgetStopNotice, SessionUsageBadge, formatTokens, formatUsd, usageRefreshKey } from "./SessionUsage";
import { budgetFromDraft, draftFromBudget, EMPTY_BUDGET_DRAFT } from "../pages/agents/BudgetFields";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => ({ useApi: () => ({ api }) }));

beforeEach(() => api.mockReset());

const report = {
  type: "model_usage",
  scope: { session_id: "sess_1" },
  totals: {
    model_calls: 3,
    input_tokens: 12_000,
    output_tokens: 400,
    cache_read_input_tokens: 8_000,
    cache_creation_input_tokens: 0,
    total_tokens: 12_400,
    cost_usd: 0.0312,
    unpriced_calls: 0,
  },
  by_model: [],
  budget: { max_tokens_per_session: 20_000, max_steps_per_turn: 10 },
};

it("shows session token usage and cost, with budget limits on expand", async () => {
  api.mockResolvedValue(report);
  render(<SessionUsageBadge sessionId="sess_1" refreshKey={3} />);
  const badge = await screen.findByRole("button", { name: "12k tokens · $0.03" });
  expect(api).toHaveBeenCalledWith("/v1/sessions/sess_1/usage", { silentErrors: true });
  fireEvent.click(badge);
  const dialog = screen.getByRole("dialog", { name: "Session usage" });
  expect(dialog).toHaveTextContent("Model calls3");
  expect(dialog).toHaveTextContent("Tokens per session12k tokens / 20k tokens");
  expect(dialog).toHaveTextContent("Model calls per turn10 calls");
});

it("hides the badge while the session has no model calls and no budget", async () => {
  api.mockResolvedValue({ ...report, totals: { ...report.totals, model_calls: 0 }, budget: null });
  const { container } = render(<SessionUsageBadge sessionId="sess_1" />);
  await waitFor(() => expect(api).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it("renders the budget-exhausted stop clearly", () => {
  render(
    <BudgetStopNotice
      event={{
        type: "session.warning",
        source: "budget_exhausted",
        message: "Budget exhausted: max_tokens_per_session (used 2,200 of 2,000 tokens).",
        details: { budget: "max_tokens_per_session", limit: 2000, used: 2200 },
      } as never}
    />,
  );
  const notice = screen.getByRole("status");
  expect(notice).toHaveTextContent("Budget exhausted: Tokens per session");
  expect(notice).toHaveTextContent("Used 2.2k tokens of 2.0k tokens.");
  expect(notice).toHaveTextContent("The agent stopped before its next model call.");
});

it("wall-clock stops say the turn was aborted", () => {
  render(<BudgetStopNotice event={{ details: { budget: "max_turn_wall_clock_seconds", limit: 30, used: 30.2 } }} />);
  expect(screen.getByRole("status")).toHaveTextContent("Used 30.2s of 30s. The turn was aborted. Send a message to continue.");
});

it("formats tokens and dollars", () => {
  expect(formatTokens(950)).toBe("950");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(formatUsd(0.0042)).toBe("$0.0042");
  expect(formatUsd(1.234)).toBe("$1.23");
});

it("agent form budget draft round-trips and validates", () => {
  expect(budgetFromDraft(EMPTY_BUDGET_DRAFT)).toEqual({ budget: null, errors: {} });
  const draft = { ...EMPTY_BUDGET_DRAFT, max_tokens_per_turn: "5000", max_cost_usd_per_session: "1.5", max_steps_per_turn: "2.5" };
  const { budget, errors } = budgetFromDraft(draft);
  expect(budget).toEqual({ max_tokens_per_turn: 5000, max_cost_usd_per_session: 1.5 });
  expect(errors).toEqual({ max_steps_per_turn: "Must be a whole number" });
  expect(draftFromBudget({ max_tokens_per_turn: 5000 })).toEqual({ ...EMPTY_BUDGET_DRAFT, max_tokens_per_turn: "5000" });
});

it("refreshes on compaction-only budget stops and when the panel opens (budgets QA r2)", async () => {
  // A turn can stop on its budget right after a metered compaction call,
  // with no further span.model_request_end — the key must still change.
  const before = [{ type: "span.model_request_end" }, { type: "span.model_request_end" }];
  const after = [...before, { type: "span.compaction_summarize_end" }, { type: "session.status_idle" }];
  expect(usageRefreshKey(after)).toBeGreaterThan(usageRefreshKey(before));

  api.mockResolvedValue(report);
  render(<SessionUsageBadge sessionId="sess_1" refreshKey={1} />);
  const badge = await screen.findByRole("button", { name: "12k tokens · $0.03" });
  const calls = api.mock.calls.length;
  fireEvent.click(badge);
  await waitFor(() => expect(api.mock.calls.length).toBe(calls + 1));
});
