import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import type { Event } from "@/lib/events";

import { server } from "../../mocks/server";
import { ConversationView } from "./ConversationView";
import { useSessionOperations } from "./hooks";
import { buildConversation } from "./model";
import { OutputWell } from "./tools";

// Port of main's tool-calls/ToolCalls.test.tsx intent against Muse's
// conversation: what a person sees of the agent's tool calls, and what they
// can do with one that waits on them.

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
});

let sent: unknown[] = [];
beforeEach(() => {
  sent = [];
  server.use(
    http.get("*/v1/server_features", () => HttpResponse.json({ features: [] })),
    http.get("*/v1/operations", () => HttpResponse.json({ sessions: [], work_items: [], missions: [] })),
    http.get("*/v1/agents", () => HttpResponse.json({ data: [] })),
    http.post("*/v1/sessions/:id/events", async ({ request }) => {
      sent.push(await request.json());
      return HttpResponse.json({ accepted: true });
    }),
  );
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
const ev = (e: Record<string, unknown>) => e as Event;

function View({ events, running = false }: { events: Event[]; running?: boolean }) {
  const ops = useSessionOperations("sess-1");
  const { items } = buildConversation(events, { running });
  return (
    <ConversationView
      items={items}
      agent={{ id: "agent-1", name: "Support agent" }}
      sessionId="sess-1"
      running={running}
      streams={{ thinking: [], toolInputs: [], messages: [] }}
      queued={[]}
      ops={ops}
    />
  );
}

const show = (events: Event[], running = false) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <View events={events} running={running} />
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** The 40px row of a call, by the text it shows. */
const row = (text: string | RegExp) => screen.getByText(text).closest("button") as HTMLButtonElement;

describe("tool calls in the conversation", () => {
  it("shows each call as a row that opens to its command and output", () => {
    show([
      ev({ type: "user.message", id: "u1", processed_at: at(0), content: [{ type: "text", text: "run the tests" }] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "npm test" }, processed_at: at(1) }),
      ev({ type: "agent.tool_result", tool_use_id: "c1", content: "12 passed", processed_at: at(3) }),
      ev({ type: "agent.tool_use", id: "e1", name: "edit", input: { file_path: "/workspace/a.ts", old_string: "x = 1", new_string: "x = 2" }, processed_at: at(4) }),
      ev({ type: "agent.tool_result", tool_use_id: "e1", content: "ok", processed_at: at(5) }),
      ev({ type: "agent.message", id: "a1", processed_at: at(6), content: [{ type: "text", text: "All green." }] }),
      ev({ type: "session.status_idle", id: "i1", processed_at: at(6), stop_reason: { type: "end_turn" } }),
    ]);
    expect(screen.getByText("All green.")).toBeInTheDocument();
    expect(screen.getByText("Worked for 6.0s")).toBeInTheDocument();
    // Closed, a row says what was run and how long it took.
    expect(screen.queryByText("12 passed")).toBeNull();
    expect(screen.getByText("2.0s")).toBeInTheDocument();
    fireEvent.click(row("npm test"));
    expect(screen.getByText("12 passed")).toBeInTheDocument();
    fireEvent.click(row("/workspace/a.ts"));
    expect(screen.getByText("x = 2")).toBeInTheDocument();
  });

  it("marks a failed call, including a command that exited non-zero, and keeps a running one live", () => {
    show(
      [
        ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "go" }] }),
        ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "false" } }),
        ev({ type: "agent.tool_result", tool_use_id: "c1", content: "exit=1\n" }),
        ev({ type: "agent.tool_use", id: "c2", name: "read", input: { file_path: "/workspace/x" } }),
      ],
      true,
    );
    expect(within(row("false")).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(row("/workspace/x")).getByLabelText("Running")).toBeInTheDocument();
  });

  it("labels MCP calls by app and tool", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "find it" }] }),
      ev({ type: "agent.mcp_tool_use", id: "m1", name: "search_channels", mcp_server_name: "slack", input: { query: "incidents" } }),
      ev({ type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", content: [{ type: "text", text: "#inc-42" }] }),
    ]);
    expect(screen.getByText(/Slack ·/)).toBeInTheDocument();
    expect(screen.getByText("search_channels")).toBeInTheDocument();
    fireEvent.click(row("search_channels"));
    expect(screen.getByText("#inc-42")).toBeInTheDocument();
  });

  it("puts the approval controls on a call that waits for a person", async () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "check env" }] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c1"] } }),
    ]);
    const card = screen.getByRole("group", { name: "Approval needed" });
    expect(within(card).getByText("Support agent wants to run a command")).toBeInTheDocument();
    const allow = within(card).getByRole("button", { name: "Allow this call" });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await screen.findByText(/^Allowed\./);
    expect(sent).toEqual([{ events: [{ type: "user.tool_confirmation", tool_use_id: "c1", result: "allow" }] }]);
  });

  it("addresses a decision in a sub-agent's thread to that thread", async () => {
    show([
      ev({ type: "user.message", id: "u1", session_thread_id: "sthr_worker", content: [{ type: "text", text: "go" }] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "rm -rf build" }, evaluated_permission: "ask", session_thread_id: "sthr_worker" }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", event_ids: ["c1"] } }),
    ]);
    const allow = screen.getByRole("button", { name: "Allow this call" });
    await waitFor(() => expect(allow).toBeEnabled());
    fireEvent.click(allow);
    await screen.findByText(/^Allowed\./);
    expect(sent).toEqual([{ events: [{ type: "user.tool_confirmation", tool_use_id: "c1", result: "allow", session_thread_id: "sthr_worker" }] }]);
  });

  it("presents a deferred call_mcp_tool like a direct MCP call", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "find it" }] }),
      ev({ type: "agent.tool_use", id: "d1", name: "call_mcp_tool", input: { name: "mcp__slack__search_channels", arguments: '{"query":"incidents"}' } }),
      ev({ type: "agent.tool_result", tool_use_id: "d1", content: [{ type: "text", text: "#inc-42" }] }),
    ]);
    expect(screen.queryByText(/call_mcp_tool/)).toBeNull();
    expect(screen.getByText(/Slack ·/)).toBeInTheDocument();
    expect(screen.getByText("search_channels")).toBeInTheDocument();
    // The preview is the target's own argument, decoded.
    expect(screen.getByText("incidents")).toBeInTheDocument();
    fireEvent.click(row("search_channels"));
    expect(screen.getByText("query")).toBeInTheDocument();
    expect(screen.queryByText(/mcp__slack__search_channels/)).toBeNull();
    expect(screen.getByText("#inc-42")).toBeInTheDocument();
  });

  it("names the real app and tool on a deferred call's approval card", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "file it" }] }),
      ev({
        type: "agent.tool_use",
        id: "d1",
        name: "call_mcp_tool",
        input: { name: "mcp__linear__create_issue", arguments: { title: "Checkout 500s", teamId: "ENG" } },
        evaluated_permission: "ask",
      }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", event_ids: ["d1"] } }),
    ]);
    const card = screen.getByRole("group", { name: "Approval needed" });
    expect(within(card).getByText("Support agent wants to use Linear (create issue)")).toBeInTheDocument();
    expect(within(card).getByText("Linear · create_issue")).toBeInTheDocument();
    expect(within(card).getByText("Checkout 500s")).toBeInTheDocument();
    expect(screen.queryByText(/call_mcp_tool/)).toBeNull();
    expect(within(card).getByRole("button", { name: "Allow this call" })).toBeInTheDocument();
  });

  it("shows search_mcp_tools as a readable search", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "file it" }] }),
      ev({ type: "agent.tool_use", id: "s1", name: "search_mcp_tools", input: { query: "create issue", server: "linear" } }),
      ev({ type: "agent.tool_use", id: "s2", name: "search_mcp_tools", input: { query: "pages" } }),
    ]);
    expect(screen.getByText("Searched Linear tools")).toBeInTheDocument();
    expect(screen.getByText("“create issue”")).toBeInTheDocument();
    expect(screen.getByText("Searched all tools")).toBeInTheDocument();
    expect(screen.queryByText("search_mcp_tools")).toBeNull();
  });

  it("falls back to the plain call when call_mcp_tool has no valid target", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "file it" }] }),
      ev({ type: "agent.tool_use", id: "d1", name: "call_mcp_tool", input: { name: "create_issue", arguments: {} } }),
      ev({ type: "agent.tool_result", tool_use_id: "d1", content: "Unknown tool", is_error: true }),
    ]);
    expect(screen.getByText("call_mcp_tool")).toBeInTheDocument();
    expect(within(row("call_mcp_tool")).getByLabelText("Failed")).toBeInTheDocument();
  });

  it("folds a long run into one row that names what was used, deferred calls by their app", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "triage" }] }),
      ev({ type: "agent.tool_use", id: "s1", name: "search_mcp_tools", input: { query: "issue", server: "linear" } }),
      ev({ type: "agent.tool_use", id: "d1", name: "call_mcp_tool", input: { name: "mcp__linear__list_issues", arguments: {} } }),
      ev({ type: "agent.tool_result", tool_use_id: "d1", content: "[]" }),
      ev({ type: "agent.tool_use", id: "d2", name: "call_mcp_tool", input: { name: "mcp__linear__create_issue", arguments: { title: "Bug" } } }),
      ev({ type: "agent.tool_result", tool_use_id: "d2", content: "LIN-1" }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "ls" } }),
      ev({ type: "agent.tool_result", tool_use_id: "c1", content: "a" }),
      ev({ type: "agent.tool_use", id: "c2", name: "bash", input: { command: "exit 3" } }),
      ev({ type: "agent.tool_result", tool_use_id: "c2", content: "exit=3\n" }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "end_turn" } }),
    ]);
    const run = screen.getByRole("button", { name: /5 tool calls/ });
    expect(run).toHaveTextContent("Searched Linear tools · Linear ×2 · bash ×2");
    expect(run).toHaveTextContent("1 failed");
    // A failed call keeps the run open, so it is seen.
    expect(run).toHaveAttribute("aria-expanded", "true");
  });

  it("says a custom tool waits on the app, and offers no approval", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "email them" }] }),
      ev({ type: "agent.custom_tool_use", id: "c1", name: "send_email", input: { to: "a@b.c" } }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["c1"] } }),
    ]);
    const r = row("send_email");
    expect(within(r).getByText("Waiting for the app's result")).toBeInTheDocument();
    expect(within(r).queryByLabelText("Running")).toBeNull();
    expect(within(r).queryByLabelText("Completed")).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow this call" })).toBeNull();
    fireEvent.click(r);
    expect(screen.getByText(/the app that started the session runs it/)).toBeInTheDocument();
  });

  it("shows a denied call as denied, with what the agent was told", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [{ type: "text", text: "check env" }] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", event_ids: ["c1"] } }),
      ev({ type: "user.tool_confirmation", id: "x1", tool_use_id: "c1", result: "deny", deny_message: "not on prod" }),
      ev({ type: "session.status_running", id: "r2" }),
      ev({ type: "session.status_idle", id: "i2", stop_reason: { type: "end_turn" } }),
    ]);
    const r = row("env");
    expect(within(r).getByLabelText("Denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow this call" })).toBeNull();
    fireEvent.click(r);
    expect(screen.getByText(/The agent was told: “not on prod”/)).toBeInTheDocument();
  });
});

describe("long output", () => {
  it("is cut with a control to show every line", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<OutputWell>{text}</OutputWell>);
    expect(screen.queryByText(/line 50/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show all 50 lines" }));
    expect(screen.getByText(/line 50/)).toBeInTheDocument();
  });
});
