// A session waiting on a person, through the real SessionDetail page
// (ported from main's SessionDetail.hitl test, rewritten for Muse's approval
// card and tool rows). The history is read on load, the "reload" path QA
// flagged: an idle requires_action session was drawn as a running tool and
// "Outcome: success".
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { installDomShims, mountSession, newRig, rigApi, type PageRig } from "./session-detail/test-page";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(installDomShims);

let rig: PageRig;
beforeEach(() => {
  rig = newRig();
  rigApi(api, rig);
});

const askTurn = [
  { type: "user.message", id: "u1", content: [{ type: "text", text: "qa approve" }] },
  { type: "session.status_running", id: "r1" },
  { type: "agent.tool_use", id: "call_qa_8", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
  {
    type: "session.status_idle",
    id: "i1",
    stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["call_qa_8"] },
  },
];

const confirmations = () =>
  rig.posts
    .filter((p) => p.path === "/v1/sessions/sess-1/events")
    .flatMap((p) => (p.body as { events: Array<Record<string, unknown>> }).events)
    .filter((e) => e.type === "user.tool_confirmation");

describe("SessionDetail human-in-the-loop", () => {
  it("asks for a decision on a reloaded requires_action session, instead of a running call and a success", async () => {
    rig.history = askTurn;
    mountSession();
    const allow = await screen.findByRole("button", { name: "Allow this call" });
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
    // The page says it is waiting on the person, not that it is working.
    expect(screen.getAllByText(/Waiting on you/i).length).toBeGreaterThan(0);
    expect(screen.queryByText(/is working/)).toBeNull();
    // The trajectory says success, but the turn is parked on the person.
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/sessions/sess-1/trajectory", expect.anything()));
    expect(screen.queryByText(/Outcome: success/i)).toBeNull();

    fireEvent.click(allow);
    await waitFor(() => expect(confirmations()).toEqual([{ type: "user.tool_confirmation", tool_use_id: "call_qa_8", result: "allow" }]));
  });

  it("denies with the reason the agent is told", async () => {
    rig.history = askTurn;
    mountSession();
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText(/Tell the agent why/), { target: { value: "not on production" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny this call" }));
    await waitFor(() =>
      expect(confirmations()).toEqual([
        { type: "user.tool_confirmation", tool_use_id: "call_qa_8", result: "deny", deny_message: "not on production" },
      ]),
    );
  });

  it("draws a denied call as denied, not completed, with no decision left to make", async () => {
    rig.history = [
      ...askTurn,
      { type: "user.tool_confirmation", id: "c1", tool_use_id: "call_qa_8", result: "deny", deny_message: "QA denial test" },
      { type: "session.status_running", id: "r2" },
      { type: "agent.tool_result", id: "t1", tool_use_id: "call_qa_8", content: "Denied: QA denial test" },
      { type: "session.status_idle", id: "i2", stop_reason: { type: "end_turn" } },
    ];
    mountSession();
    // The row says what happened to the call.
    const row = await screen.findByRole("button", { name: /env/ });
    expect(row).toHaveTextContent("Denied");
    expect(row).not.toHaveTextContent(/Approved|Completed/);
    expect(screen.queryByRole("button", { name: "Allow this call" })).toBeNull();
  });

  it("draws an is_error recovery placeholder as failed", async () => {
    rig.history = [
      { type: "user.message", id: "u1", content: [{ type: "text", text: "go" }] },
      { type: "agent.tool_use", id: "call_x", name: "bash", input: { command: "sleep 60" } },
      { type: "agent.tool_result", id: "t1", tool_use_id: "call_x", content: "outcome unknown; it MAY have taken effect", is_error: true },
      { type: "session.status_idle", id: "i1", stop_reason: { type: "end_turn" } },
    ];
    mountSession();
    const row = await screen.findByRole("button", { name: /sleep 60/ });
    expect(within(row).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(row).queryByLabelText("Completed")).toBeNull();
  });

  it("says a custom tool is waiting for the client's result, not running, and offers no approval", async () => {
    rig.history = [
      { type: "user.message", id: "u1", content: [{ type: "text", text: "email" }] },
      { type: "agent.custom_tool_use", id: "call_c", name: "send_email", input: { to: "a@b.c" } },
      {
        type: "session.status_idle",
        id: "i1",
        stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["call_c"] },
      },
    ];
    mountSession();
    const conversation = await screen.findByRole("log");
    await waitFor(() => expect(within(conversation).getAllByText(/waiting for/i).length).toBeGreaterThan(0));
    expect(within(conversation).queryByText(/^Running$/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Allow this call" })).toBeNull();
  });
});
