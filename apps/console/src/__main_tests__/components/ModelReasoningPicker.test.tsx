import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ModelCard } from "@open-managed-agents/api-types";
import { ModelReasoningPicker, prettyModelName } from "./ModelReasoningPicker";
import { SessionModelPicker } from "./SessionModelPicker";
import { agentModelPatch } from "./AgentModelSwitcher";

vi.mock("../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => null),
}));

const card = (model_id: string, provider: string, model = model_id): ModelCard => ({
  id: `mc_${model_id}`,
  model_id,
  model,
  provider,
  created_at: "2026-11-01T00:00:00Z",
});

const CARDS: ModelCard[] = [
  card("claude-opus-5-5", "ant"),
  card("gpt-6.1-sol", "oai"),
  card("deepseek-chat", "oai-compatible"),
];

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("prettyModelName", () => {
  it.each([
    ["claude-opus-5-5", "Opus 5.5"],
    ["claude-fable-5-1", "Fable 5.1"],
    ["claude-sonnet-4-6-20260101", "Sonnet 4.6"],
    ["gpt-6.1-sol", "GPT-6.1 Sol"],
    ["gpt-7", "GPT-7"],
    ["o3", "o3"],
    ["deepseek-chat", "deepseek-chat"],
  ])("%s → %s", (id, pretty) => {
    expect(prettyModelName(id)).toBe(pretty);
  });
});

describe("ModelReasoningPicker", () => {
  it("shows the compact chip and a two-column popover with Default tags and checks", async () => {
    const onChange = vi.fn();
    render(
      <ModelReasoningPicker
        cards={CARDS}
        value={{ model: "claude-opus-5-5", level: "high" }}
        defaults={{ model: "claude-opus-5-5", level: "medium" }}
        onChange={onChange}
      />,
    );
    const chip = screen.getByTestId("model-reasoning-chip");
    expect(chip).toHaveTextContent("Opus 5.5High");
    fireEvent.click(chip);

    const models = await screen.findByRole("listbox", { name: "Model" });
    expect(within(models).getByText("Anthropic")).toBeInTheDocument();
    expect(within(models).getByText("OpenAI")).toBeInTheDocument();
    expect(within(models).getByText("OpenAI-compatible")).toBeInTheDocument();
    expect(within(models).getByRole("option", { name: /Opus 5.5/ })).toHaveAttribute("aria-selected", "true");

    const reasoning = screen.getByRole("listbox", { name: "Reasoning" });
    const levels = within(reasoning).getAllByRole("option").map((o) => o.textContent);
    expect(levels).toEqual(["Low", "MediumDefault", "High", "Extra High", "Max"]);
    expect(within(reasoning).getByRole("option", { name: "High" })).toHaveAttribute("aria-selected", "true");

    fireEvent.click(within(reasoning).getByRole("option", { name: /Extra High/ }));
    expect(onChange).toHaveBeenCalledWith({ model: "claude-opus-5-5", level: "xhigh" });
  });

  it("switching models keeps the level; non-reasoning models disable the column", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ModelReasoningPicker cards={CARDS} value={{ model: "claude-opus-5-5", level: "max" }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId("model-reasoning-chip"));
    fireEvent.click(await screen.findByRole("option", { name: /GPT-6.1 Sol/ }));
    expect(onChange).toHaveBeenCalledWith({ model: "gpt-6.1-sol", level: "max" });

    rerender(<ModelReasoningPicker cards={CARDS} value={{ model: "deepseek-chat", level: "max" }} onChange={onChange} />);
    expect(screen.getByText("This model doesn't take a reasoning level.")).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Max" })).toBeDisabled();
    // Chip drops the level for models that ignore it.
    expect(screen.getByTestId("model-reasoning-chip")).toHaveTextContent(/^deepseek-chat$/);
  });

  it("unset level reads as Medium", () => {
    render(<ModelReasoningPicker cards={CARDS} value={{ model: "gpt-6.1-sol", level: undefined }} onChange={() => {}} />);
    expect(screen.getByTestId("model-reasoning-chip")).toHaveTextContent("GPT-6.1 SolMedium");
  });
});

describe("SessionModelPicker", () => {
  it("loads the session override and posts metadata; picking the agent's own value clears it", async () => {
    const posts: unknown[] = [];
    let session = {
      id: "sess_1",
      agent: { id: "agent_1", model: "claude-opus-5-5", reasoning_level: "high" },
      metadata: { model: "gpt-6.1-sol" } as Record<string, unknown>,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input), "http://localhost");
        if (url.pathname === "/v1/model_cards") return Response.json({ data: CARDS });
        if (url.pathname === "/v1/sessions/sess_1" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          session = { ...session, metadata: { ...session.metadata, ...body.metadata } };
          return Response.json(session);
        }
        if (url.pathname === "/v1/sessions/sess_1") return Response.json(session);
        return Response.json({ data: [] });
      }),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <SessionModelPicker sessionId="sess_1" />
      </QueryClientProvider>,
    );

    const chip = await screen.findByTestId("model-reasoning-chip");
    // Override model, agent's level.
    await waitFor(() => expect(chip).toHaveTextContent("GPT-6.1 SolHigh"));
    fireEvent.click(chip);
    const reasoning = await screen.findByRole("listbox", { name: "Reasoning" });
    // "Default" marks the AGENT's configured level, not Medium.
    expect(within(reasoning).getByRole("option", { name: /HighDefault/ })).toBeInTheDocument();

    fireEvent.click(within(reasoning).getByRole("option", { name: "Max" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ metadata: { model: "gpt-6.1-sol", reasoning_level: "max" } });
    await waitFor(() => expect(screen.getByTestId("model-reasoning-chip")).toHaveTextContent("GPT-6.1 SolMax"));

    fireEvent.click(screen.getByTestId("model-reasoning-chip"));
    fireEvent.click(await screen.findByRole("option", { name: /Opus 5.5/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({ metadata: { model: null, reasoning_level: "max" } });
  });
});

describe("agentModelPatch (agent page quick switcher)", () => {
  const agent = { model: { id: "claude-opus-5-5", speed: "fast" }, version: 3, _oma: { reasoning_level: "high" as const } };

  it("sends only changed fields with the version guard, keeping speed", () => {
    expect(agentModelPatch(agent, { model: "claude-sonnet-5-5", level: "high" })).toEqual({
      model: { id: "claude-sonnet-5-5", speed: "fast" },
      version: 3,
    });
    expect(agentModelPatch(agent, { model: "claude-opus-5-5", level: "xhigh" })).toEqual({
      _oma: { reasoning_level: "xhigh" },
      version: 3,
    });
  });

  it("stores the default level as unset and no-ops when nothing changed", () => {
    expect(agentModelPatch(agent, { model: "claude-opus-5-5", level: "medium" })).toEqual({
      _oma: { reasoning_level: null },
      version: 3,
    });
    expect(agentModelPatch(agent, { model: "claude-opus-5-5", level: "high" })).toBeNull();
    expect(agentModelPatch({ model: "gpt-6.1-sol", version: 1, _oma: {} }, { model: "gpt-6.1-sol", level: "medium" })).toBeNull();
  });
});
