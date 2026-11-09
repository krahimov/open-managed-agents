import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { Event } from "../../lib/events";
import { buildTimeline } from "./model";
import { Output, WorkTimeline } from "./ToolCalls";

vi.mock("../../lib/api", () => ({ useApi: () => ({ api: vi.fn() }) }));

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
const ev = (e: Record<string, unknown>) => e as Event;

const show = (events: Event[]) =>
  render(
    <WorkTimeline
      items={buildTimeline(events).items}
      sessionId="sess-1"
      renderEvent={(e) => <p>{e.type === "agent.message" ? "final answer" : e.type}</p>}
    />,
  );

const finishedTurn = [
  ev({ type: "user.message", id: "u1", processed_at: at(0), content: [] }),
  ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "npm test" }, processed_at: at(1) }),
  ev({ type: "agent.tool_result", tool_use_id: "c1", content: "12 passed", processed_at: at(3) }),
  ev({ type: "agent.tool_use", id: "e1", name: "edit", input: { file_path: "/workspace/a.ts", old_string: "x = 1", new_string: "x = 2" }, processed_at: at(4) }),
  ev({ type: "agent.tool_result", tool_use_id: "e1", content: "ok", processed_at: at(5) }),
  ev({ type: "agent.message", id: "a1", processed_at: at(6), content: [{ type: "text", text: "done" }] }),
  ev({ type: "session.status_idle", id: "i1", processed_at: at(6), stop_reason: { type: "end_turn" } }),
];

describe("WorkTimeline", () => {
  it("collapses a finished turn behind 'Worked for' and expands on click", () => {
    show(finishedTurn);
    expect(screen.getByText("final answer")).toBeInTheDocument();
    expect(screen.queryByText("npm test")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /Worked for 6s/ }));
    // two calls → one summary row, collapsed until clicked
    const group = screen.getByRole("button", { name: /Changed 1 file, ran 1 command/ });
    expect(screen.queryByText("npm test")).toBeNull();
    fireEvent.click(group);
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.getByText("2s")).toBeInTheDocument();

    // expanding a call shows its command output / diff
    fireEvent.click(screen.getByText("npm test").closest("button")!);
    expect(screen.getByText("12 passed")).toBeInTheDocument();
    fireEvent.click(screen.getByText("a.ts").closest("button")!);
    expect(screen.getByText("x = 2").closest("[data-op]")).toHaveAttribute("data-op", "+");
  });

  it("marks a failed call and keeps a running one live", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "false" } }),
      ev({ type: "agent.tool_result", tool_use_id: "c1", content: "exit 1", is_error: true }),
      ev({ type: "agent.tool_use", id: "c2", name: "read", input: { file_path: "/workspace/x" } }),
    ]);
    expect(screen.getByRole("button", { name: /1 failed/ })).toBeInTheDocument();
    // a live group starts open
    expect(screen.getByRole("button", { name: "Ran false, failed" })).toBeInTheDocument();
    expect(document.querySelector('[data-status="running"]')).not.toBeNull();
    expect(screen.getAllByRole("status", { name: "Loading" }).length).toBeGreaterThan(0);
  });

  it("labels MCP calls by server and tool", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [] }),
      ev({ type: "agent.mcp_tool_use", id: "m1", name: "search_channels", mcp_server_name: "slack", input: { query: "incidents" } }),
      ev({ type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", content: [{ type: "text", text: "#inc-42" }] }),
    ]);
    expect(screen.getByText("Slack")).toBeInTheDocument();
    expect(screen.getByText("search channels")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Slack").closest("button")!);
    expect(screen.getByText("#inc-42")).toBeInTheDocument();
  });

  it("shows approval controls inline for a call awaiting approval", () => {
    show([
      ev({ type: "user.message", id: "u1", content: [] }),
      ev({ type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" }),
      ev({ type: "session.status_idle", id: "i1", stop_reason: { type: "requires_action", event_ids: ["c1"] } }),
    ]);
    expect(screen.getByText("Needs approval")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
  });
});

describe("Output", () => {
  it("truncates long output with a show-more toggle", () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
    render(<Output text={text} />);
    expect(screen.queryByText(/line 50/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 30 more lines" }));
    expect(screen.getByText(/line 50/)).toBeInTheDocument();
  });
});
