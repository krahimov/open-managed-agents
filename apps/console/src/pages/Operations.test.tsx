import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { Operations } from "./Operations";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { FirstRunGuide, SAMPLE_TASK } from "../components/FirstRunGuide";
import { AccessPolicyEditor } from "./agents/AccessPolicyEditor";
import { ApiError } from "../lib/api";
import type { OperationsReport } from "../lib/operations";

const { api } = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../lib/api", async (original) => ({ ...await original<typeof import("../lib/api")>(), useApi: () => ({ api }) }));

const report: OperationsReport = {
  sessions: [{ id: "session_1", title: "Research report", agent_id: "agent_1", status: "idle", updated_at: 1, last_event_at: 1, error: null,
    pending_approvals: [{ tool_use_id: "tool_1", name: "send_email", input: { to: "review@example.test", body: "Draft report" }, requested_at: 1 }],
  }], missions: [], work_items: [], truncated: false,
  usage: { totals: { cost_usd: 8, processed_tokens: 500, sessions: 1 } },
  budgets: [{ scope_id: "workspace", limits: { daily_cost_usd: 10, daily_tokens: null, max_concurrent_sessions: null }, usage: { estimated_cost_usd: 8, tokens: 500, active_sessions: 0, unpriced_calls: 0 }, exceeded: [] }],
};

function show(element: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={client}>{element}</QueryClientProvider></MemoryRouter>);
}

beforeEach(() => { api.mockReset(); });

describe("Workspace operations", () => {
  it("shows failed reads as errors with a retry instead of an empty workspace", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/access") return { authorization: { role: "operator", kind: "session" } };
      throw new Error("Database unavailable");
    });
    show(<Operations />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Activity could not be loaded");
    expect(screen.queryByText("No pending approvals in the loaded sessions.")).not.toBeInTheDocument();
    const before = api.mock.calls.length;
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.mock.calls.length).toBeGreaterThan(before));
  });

  it("explains unsupported runtimes and links to sessions", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/access") return { authorization: { role: "operator", kind: "session" } };
      throw new ApiError({ status: 501, code: "unsupported", message: "Node runtime required" });
    });
    show(<Operations />);
    expect(await screen.findByRole("link", { name: "Open sessions to review activity" })).toHaveAttribute("href", "/sessions");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
  });

  it("shows exact approval arguments and sends only the selected call's decision", async () => {
    let approved = false;
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/v1/workspace/access") return { authorization: { role: "operator", kind: "session" } };
      if (init?.method === "POST") { approved = true; return {}; }
      return approved ? { ...report, sessions: [] } : report;
    });
    show(<Operations />);
    expect(await screen.findByText("Daily estimated cost: 80% of limit used")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("tab", { name: "Approvals (1)" }));
    // The request lists each argument by name, with its exact value.
    const request = screen.getByRole("group", { name: "Approval needed" });
    expect(within(request).getByText("review@example.test")).toBeInTheDocument();
    expect(within(request).getByText("Draft report")).toBeInTheDocument();
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Allow this call" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/operations/sessions/session_1/approvals", expect.objectContaining({
      method: "POST", body: JSON.stringify({ tool_use_id: "tool_1", result: "allow" }),
    })));
    expect(await screen.findByText("No pending approvals in the loaded sessions.")).toBeInTheDocument();
  });

  it("keeps approval controls disabled for viewers", async () => {
    api.mockImplementation(async (path: string) => path === "/v1/workspace/access" ? { authorization: { role: "viewer", kind: "session" } } : report);
    show(<Operations />);
    await userEvent.click(await screen.findByRole("tab", { name: "Approvals (1)" }));
    expect(screen.getByRole("button", { name: "Allow this call" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("distinguishes pausing future mission iterations from stopping active work", async () => {
    api.mockImplementation(async (path: string) => path === "/v1/workspace/access"
      ? { authorization: { role: "operator", kind: "session" } }
      : { ...report, missions: [{ id: "mission_1", goal: "Test mission", status: "running", iteration: 1, updated_at: 1, active_session_id: "session_1" }] });
    show(<Operations />);
    await userEvent.click(await screen.findByRole("button", { name: "Pause future iterations" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/missions/mission_1/stop", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "pause_future" }) })));
    // Stopping interrupts work in flight, so it asks first; pausing does not.
    await userEvent.click(screen.getByRole("button", { name: "End the run" }));
    await userEvent.click(await screen.findByRole("dialog").then((d) => within(d).getByRole("button", { name: "End the run" })));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/missions/mission_1/stop", expect.objectContaining({ method: "POST", body: JSON.stringify({ mode: "stop_now" }) })));
  });

  it("validates budgets, preserves owner role, and sends explicit limit removal", async () => {
    api.mockImplementation(async (path: string) => {
      if (path === "/v1/workspace/access") return { authorization: { role: "owner", kind: "session" }, budgets_supported: true };
      if (path === "/v1/workspace/members") return { data: [{ user_id: "user_owner", role: "owner", created_at: 1 }] };
      if (path === "/v1/workspace/budgets") return { data: [{ scope_id: "workspace", daily_tokens: 100, daily_cost_usd: 10, max_concurrent_sessions: 2 }] };
      return { data: [] };
    });
    show(<WorkspaceSettings />);
    expect(await screen.findByRole("combobox", { name: "Role for user_owner" })).toBeDisabled();
    const tokens = await screen.findByRole("spinbutton", { name: "Tokens per day" });
    await userEvent.clear(tokens); await userEvent.type(tokens, "-1");
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter positive limits");
    expect(api.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    await userEvent.clear(tokens);
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/workspace/budgets/workspace", expect.objectContaining({ method: "PUT", body: JSON.stringify({ daily_tokens: null, daily_cost_usd: 10, max_concurrent_sessions: 2 }) })));
  });

  it("runs a safe sample only on request and reuses the session after send failure", async () => {
    let sends = 0;
    api.mockImplementation(async (path: string, init?: RequestInit) => {
      if (path.startsWith("/v1/agents")) return { data: [{ id: "agent_1", name: "Researcher", model: "test", _oma: { default_environment_id: "env_1" } }] };
      if (path === "/v1/sessions" && init?.method === "POST") return { id: "session_sample" };
      if (path.endsWith("/events")) { sends++; throw new Error("Message could not be sent"); }
      throw new Error("Unexpected request");
    });
    show(<FirstRunGuide />);
    await screen.findByRole("option", { name: "Researcher" });
    expect(api.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Agent for sample task" }), "agent_1");
    await userEvent.click(screen.getByRole("button", { name: "Run sample task" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Message could not be sent");
    await userEvent.click(screen.getByRole("button", { name: "Send sample task" }));
    await waitFor(() => expect(sends).toBe(2));
    expect(api.mock.calls.filter(([path, init]) => path === "/v1/sessions" && init?.method === "POST")).toHaveLength(1);
    expect(api).toHaveBeenCalledWith("/v1/sessions/session_sample/events", expect.objectContaining({ body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: SAMPLE_TASK }] }] }) }));
  });

  it("requires deliberate policy saving and preserves the new-session scope", async () => {
    api.mockResolvedValue({ authorization: { role: "admin", kind: "session" } });
    const saved = vi.fn();
    show(<AccessPolicyEditor agentId="agent_1" baseline={null} onSaved={saved} />);
    await userEvent.click(await screen.findByRole("button", { name: "Add access policy" }));
    expect(screen.getByText(/Current sessions keep their existing policy/)).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox", { name: "Tool pattern 1" }));
    await userEvent.click(screen.getByRole("button", { name: "Save policy version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Every rule needs a tool name");
    await userEvent.type(screen.getByRole("textbox", { name: "Tool pattern 1" }), "bash");
    await userEvent.click(screen.getByRole("radio", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Save policy version" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/agents/agent_1/grants/baseline", expect.objectContaining({ method: "PUT", body: JSON.stringify({ enabled: true, rules: [{ selector: "bash", effect: "deny" }] }) })));
    expect(saved).toHaveBeenCalledOnce();
  });
});
