import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { AgentVersionComparison } from "./AgentVersionComparison";
import type { AgentRecord } from "../../types/agent";

const mocks = vi.hoisted(() => ({ api: vi.fn(), detail: null as unknown, comparisons: true, asked: [] as string[] }));
vi.mock("../../lib/api", () => ({ useApi: () => ({ api: mocks.api }) }));
vi.mock("../../lib/server-features", () => ({ useServerFeature: (key: string) => key === "comparisons" && mocks.comparisons }));
vi.mock("../../lib/useApiQuery", () => ({
  useApiQuery: (path: string) => (mocks.asked.push(path), {
    data: path === "/v1/evals/suites" ? { data: [{ id: "suite-1", name: "Regression", task_count: 2 }] }
      : path === "/v1/environments" ? { data: [{ id: "env-1", name: "Test environment" }] }
      : path === "/v1/evals/comparisons" ? { data: [] }
      : path?.startsWith("/v1/evals/comparisons/") ? mocks.detail : undefined,
    isLoading: false, error: null, refetch: vi.fn(),
  }),
}));
const agent: AgentRecord = { id: "agent-1", name: "Agent", version: 2, model: "test", created_at: "2026-01-01" };
const view = (versions: AgentRecord[]) => <MemoryRouter><AgentVersionComparison agent={agent} versions={versions} /></MemoryRouter>;
beforeEach(() => { mocks.api.mockReset(); mocks.detail = null; mocks.comparisons = true; mocks.asked = []; });

describe("agent version comparison", () => {
  it("selects the prior version when history arrives after the agent and launches both against the same suite", async () => {
    mocks.api.mockResolvedValue({ id: "comparison-1" });
    const { rerender } = render(view([]));
    expect(screen.getByRole("button", { name: "Run comparison" })).toBeDisabled();
    rerender(view([{ ...agent, version: 1 }]));
    // The version pickers are custom selects: assert what they display.
    expect(screen.getByLabelText("Baseline version")).toHaveTextContent("v1");
    expect(screen.getByLabelText("Candidate version")).toHaveTextContent("v2");
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    await waitFor(() => expect(mocks.api).toHaveBeenCalledOnce());
    expect(JSON.parse(mocks.api.mock.calls[0][1].body)).toEqual({
      agent_id: "agent-1", baseline_version: 1, candidate_version: 2,
      environment_id: "env-1", suite_id: "suite-1",
    });
  });

  it("keeps missing cost and grades distinct from measured zero", async () => {
    const metrics = { version: 1, run_id: "run-1", status: "completed", total_trials: 1, completed_trials: 1,
      failed_trials: 0, graded_trials: 0, passed_trials: 0, success_rate: null, mean_latency_ms: 500,
      latency_samples: 1, tool_calls: 0, tool_failures: 0, input_tokens: 0, output_tokens: 0,
      estimated_cost_usd: null, missing_trajectories: 0 };
    mocks.detail = { baseline: metrics, candidate: { ...metrics, version: 2, run_id: "run-2", estimated_cost_usd: 0 }, config_diff: [] };
    mocks.api.mockResolvedValue({ id: "comparison-1" });
    render(view([{ ...agent, version: 1 }]));
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    expect(await screen.findByText("$0.0000")).toBeVisible();
    expect(screen.getByText("Unavailable")).toBeVisible();
    expect(screen.getAllByText("Not graded")).toHaveLength(2);
    expect(screen.getByRole("link", { name: "v2" })).toHaveAttribute("href", "/evals/run-2");
  });

  it("shows launch errors and allows retry", async () => {
    mocks.api.mockRejectedValue(new Error("Agent version not found"));
    render(view([{ ...agent, version: 1 }]));
    fireEvent.click(screen.getByRole("button", { name: "Run comparison" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Agent version not found");
    expect(screen.getByRole("button", { name: "Run comparison" })).toBeEnabled();
  });

  it("is left out, asking for nothing, where the server runs no comparisons", () => {
    mocks.comparisons = false;
    const { container } = render(view([{ ...agent, version: 1 }]));
    expect(container).toBeEmptyDOMElement();
    expect(mocks.asked).toEqual([]);
    expect(mocks.api).not.toHaveBeenCalled();
  });
});
