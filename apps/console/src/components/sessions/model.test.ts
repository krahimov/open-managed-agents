import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/events";
import { sessionTitle } from "@/lib/sessions";

import { briefFailures, buildConversation, grantedRequestIds, handoffKey, handoffKeyOf, type Block, type Conversation, type ToolCall } from "./model";

const events = (list: Array<Record<string, unknown>>): Event[] =>
  list.map((e, i) => ({ id: `e${i}`, seq: i + 1, ts: 1_800_000_000_000 + i * 1000, ...e })) as unknown as Event[];

describe("a mission iteration", () => {
  it("is never titled by the mission's id", () => {
    expect(sessionTitle({ title: "Mission mis-V1StGXR8Z5jdHi6BmyTq4 · iteration 3", agent: undefined as never })).toBe(
      "Run until done · iteration 3",
    );
    expect(sessionTitle({ title: "Mission control retro", agent: undefined as never })).toBe("Mission control retro");
  });

  it("reads the failed checks out of the brief the run wrote", () => {
    const brief = [
      "[Mission mis-abc — iteration 3 of 10]",
      "",
      "Goal: migrate the routes",
      "",
      "When your turn ends, these checks must exit 0:",
      "  - npm test -- routes",
      "  - npx tsc --noEmit",
      "",
      "Previous attempt failed these checks:",
      "  - npm test -- routes",
      "      FAIL src/routes/events/events.test.ts",
      "      AssertionError: expected 500 to be 400",
    ].join("\n");
    expect(briefFailures(brief)).toEqual(["npm test -- routes"]);
    expect(briefFailures("Goal: anything")).toEqual([]);
  });

  it("opens with a note from the run, not a message from a person", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "[Mission mis-abc — iteration 2 of 10]\n\nGoal: x" }], metadata: { kind: "mission_iteration", mission_iteration: 2 } },
      ]),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "brief", iteration: 2, failing: [] });
  });
});

describe("a hand-off to another agent", () => {
  it("spells an agent id the way the runtime does in a tool name", () => {
    expect(handoffKeyOf("agent-rrtcdqruug4a13d0")).toBe("agent_rrtcdqruug4a13d0");
    expect(handoffKey("call_agent_agent_rrtcdqruug4a13d0")).toBe("agent_rrtcdqruug4a13d0");
    expect(handoffKey("bash")).toBeNull();
  });

  it("is named from the thread it started, and that thread's note is not drawn twice", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Is it ready?" }] },
        { type: "agent.tool_use", id: "call1", name: "call_agent_agent_rrtcdqruug4a13d0", input: { message: "Review #1850" } },
        { type: "session.thread_created", session_thread_id: "sthr_1", agent_id: "agent-rrtcdqruug4a13d0", agent_name: "PR Reviewer", parent_thread_id: "sthr_primary" },
        { type: "agent.tool_result", tool_use_id: "call1", content: "Safe to merge." },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["tools"]);
    const block = turn?.kind === "agent" ? turn.blocks[0] : undefined;
    const call = block?.kind === "tools" ? block.calls[0] : undefined;
    expect(call?.handoff).toEqual({ agentKey: "agent_rrtcdqruug4a13d0", agentId: "agent-rrtcdqruug4a13d0", agentName: "PR Reviewer", threadId: "sthr_1" });
    expect(call?.output).toBe("Safe to merge.");
  });
});

describe("a request the agent makes of a person", () => {
  it("is drawn once, as its card, without the tool call that produced it", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Build the plan" }] },
        { type: "agent.tool_use", id: "r1", name: "request_access", input: { service: "hubspot", reason: "To read the deal" } },
        { type: "system.access_request", request_id: "acreq-1", service: "hubspot", reason: "To read the deal", auth_kind: "composio" },
        { type: "agent.tool_result", tool_use_id: "r1", content: '{"request_id":"acreq-1","status":"pending"}' },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["card"]);
  });

  it("keeps the call when no card followed it", () => {
    const { items } = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "Build the plan" }] },
        { type: "agent.tool_use", id: "r1", name: "request_access", input: { service: "hubspot" } },
        { type: "agent.tool_result", tool_use_id: "r1", content: "Request failed", is_error: true },
      ]),
    );
    const turn = items.find((i) => i.kind === "agent");
    expect(turn?.kind === "agent" && turn.blocks.map((b) => b.kind)).toEqual(["tools"]);
  });
});

describe("a failed turn's explanation", () => {
  const RAW = "No output generated. Check the stream for errors.";
  const QUOTA = "429 insufficient_quota: You exceeded your current quota";

  it("is the model's own error, as the error card says it, even when the runtime reports the failure twice", () => {
    const c = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "span.model_request_end", finish_reason: "error", error_message: QUOTA },
        { type: "session.error", error: "model_error", message: RAW },
        { type: "session.status_idle" },
        { type: "session.error", error: "model_error", message: RAW, work_item_id: "sw_1" },
      ]),
    );
    expect(c.failed).toBe(true);
    expect(c.failure).toBe(QUOTA);
  });

  it("is the runtime's message when the model said nothing, and nothing once a new turn starts", () => {
    const only = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "session.error", error: "model_error", message: RAW },
      ]),
    );
    expect(only.failure).toBe(RAW);
    const again = buildConversation(
      events([
        { type: "user.message", content: [{ type: "text", text: "hey" }] },
        { type: "session.error", error: "model_error", message: RAW },
        { type: "user.message", content: [{ type: "text", text: "try again" }] },
      ]),
    );
    expect(again.failed).toBe(false);
    expect(again.failure).toBeNull();
  });
});

// ── tool calls (port of main's tool-calls/model.test.ts intent) ─────────

const blocksOf = (c: Conversation): Block[] => c.items.flatMap((i) => (i.kind === "agent" ? i.blocks : []));
const callsOf = (c: Conversation): ToolCall[] =>
  blocksOf(c).flatMap((b) => (b.kind === "tools" ? b.calls : b.kind === "approval" ? [b.call] : []));
const ask = (text = "go") => ({ type: "user.message", content: [{ type: "text", text }] });

describe("a tool call", () => {
  it("pairs with its result by id, with status, output and duration", () => {
    const calls = callsOf(
      buildConversation(
        events([
          ask(),
          { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "ls" } },
          { type: "agent.mcp_tool_use", id: "m1", name: "search", mcp_server_name: "slack", input: {} },
          { type: "agent.tool_result", tool_use_id: "c1", content: [{ type: "text", text: "a.txt" }] },
          { type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", content: '{"ok":true}' },
        ]),
      ),
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ status: "completed", output: "a.txt", durationMs: 2000 });
    expect(calls[1]).toMatchObject({ flavor: "mcp", server: "slack", status: "completed", output: '{"ok":true}' });
  });

  it("is failed when its result is an error, and running while the session works on it", () => {
    const calls = callsOf(
      buildConversation(
        events([
          ask(),
          { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "x" } },
          { type: "agent.tool_result", tool_use_id: "c1", content: "boom", is_error: true },
          { type: "agent.tool_use", id: "c2", name: "bash", input: { command: "y" } },
        ]),
        { running: true },
      ),
    );
    expect(calls.map((c) => c.status)).toEqual(["errored", "running"]);
  });

  it("is failed when a command exits non-zero, though the result is not flagged as an error", () => {
    const [failed, ok] = callsOf(
      buildConversation(
        events([
          ask(),
          { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "false" } },
          { type: "agent.tool_result", tool_use_id: "c1", content: "exit=1\nnope" },
          { type: "agent.tool_use", id: "c2", name: "bash", input: { command: "true" } },
          { type: "agent.tool_result", tool_use_id: "c2", content: "exit=0\n" },
        ]),
      ),
    );
    expect(failed).toMatchObject({ status: "errored", isError: true });
    expect(ok).toMatchObject({ status: "completed", isError: false });
  });

  it("reached through call_mcp_tool is the MCP call it carries, keeping its id", () => {
    const [deferred, stringArgs, malformed] = callsOf(
      buildConversation(
        events([
          ask(),
          { type: "agent.tool_use", id: "d1", name: "call_mcp_tool", input: { name: "mcp__linear__create_issue", arguments: '{"title":"Bug"}' } },
          { type: "agent.tool_result", tool_use_id: "d1", content: "LIN-1" },
          { type: "agent.tool_use", id: "d2", name: "call_mcp_tool", input: { name: "mcp__github__repos__create_pr", arguments: { draft: true } } },
          { type: "agent.tool_use", id: "d3", name: "call_mcp_tool", input: { arguments: { x: 1 } } },
        ]),
      ),
    );
    expect(deferred).toMatchObject({ id: "d1", flavor: "mcp", server: "linear", name: "create_issue", input: { title: "Bug" }, status: "completed", output: "LIN-1" });
    // The server ends at the first "__"; the tool keeps the rest.
    expect(stringArgs).toMatchObject({ server: "github", name: "repos__create_pr", input: { draft: true } });
    expect(malformed).toMatchObject({ flavor: "tool", name: "call_mcp_tool", input: { arguments: { x: 1 } } });
  });

  it("waits for a person when the session is parked on its approval, and nothing else does", () => {
    const c = buildConversation(
      events([
        ask(),
        { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
        { type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "tool_confirmation", event_ids: ["c1"] } },
      ]),
    );
    expect(c.pendingApprovals.map((p) => p.id)).toEqual(["c1"]);
    expect(blocksOf(c).map((b) => b.kind)).toEqual(["approval"]);
  });

  it("waits for a person when the runtime leaves out the action type or the ids", () => {
    const noType = buildConversation(
      events([
        ask(),
        { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
        { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
      ]),
    );
    expect(noType.pendingApprovals.map((p) => p.id)).toEqual(["c1"]);
    const noIds = buildConversation(
      events([
        ask(),
        { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
        { type: "session.status_idle", stop_reason: { type: "requires_action" } },
      ]),
    );
    expect(noIds.pendingApprovals.map((p) => p.id)).toEqual(["c1"]);
  });

  it("of a custom tool waits on the app that runs the session, not on a person", () => {
    const c = buildConversation(
      events([
        ask(),
        { type: "agent.custom_tool_use", id: "t1", name: "send_email", input: { to: "a@b.c" } },
        { type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["t1"] } },
      ]),
    );
    expect(c.pendingApprovals).toEqual([]);
    expect(callsOf(c)[0]).toMatchObject({ flavor: "custom", status: "waiting" });
  });

  it("of a custom tool runs once the app answered, and completes with the runtime's result", () => {
    const base = [
      ask(),
      { type: "agent.custom_tool_use", id: "t1", name: "send_email", input: {} },
      { type: "session.status_idle", stop_reason: { type: "requires_action", action_type: "custom_tool_result", event_ids: ["t1"] } },
      { type: "user.custom_tool_result", custom_tool_use_id: "t1", content: [] },
      { type: "session.status_running" },
    ];
    expect(callsOf(buildConversation(events(base), { running: true }))[0].status).toBe("running");
    const done = buildConversation(events([...base, { type: "agent.tool_result", tool_use_id: "t1", content: "sent" }]));
    expect(callsOf(done)[0]).toMatchObject({ status: "completed", output: "sent" });
  });

  it("allowed by a person runs while the session works, then shows who approved it", () => {
    const base = [
      ask(),
      { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
      { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
      { type: "user.tool_confirmation", tool_use_id: "c1", result: "allow" },
      { type: "session.status_running" },
    ];
    expect(callsOf(buildConversation(events(base), { running: true }))[0]).toMatchObject({ status: "running", approval: "allowed" });
    const done = buildConversation(events([...base, { type: "agent.tool_result", tool_use_id: "c1", content: "PATH=…" }]));
    expect(callsOf(done)[0]).toMatchObject({ status: "completed", approval: "allowed" });
  });

  it("denied by a person is denied, with what the agent was told", () => {
    const c = buildConversation(
      events([
        ask(),
        { type: "agent.tool_use", id: "c1", name: "bash", input: { command: "env" }, evaluated_permission: "ask" },
        { type: "session.status_idle", stop_reason: { type: "requires_action", event_ids: ["c1"] } },
        { type: "user.tool_confirmation", tool_use_id: "c1", result: "deny", deny_message: "no" },
        { type: "session.status_running" },
        { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ]),
    );
    expect(c.pendingApprovals).toEqual([]);
    expect(callsOf(c)[0]).toMatchObject({ status: "denied", approval: "denied", denyMessage: "no" });
  });
});

describe("what a message carries", () => {
  it("shows a person only what they typed, and lists the files they sent", () => {
    const attachments = [
      { file_id: "file_1", filename: "report.pdf", media_type: "application/pdf", size_bytes: 2048, kind: "file", path: "/mnt/session/uploads/report.pdf" },
    ];
    const { items } = buildConversation(
      events([
        {
          type: "user.message",
          content: [
            { type: "text", text: "Summarise this" },
            { type: "text", text: "[Attached file — the user attached this file to this message. …]\n- /mnt/session/uploads/report.pdf" },
          ],
          metadata: { attachments },
        },
      ]),
    );
    expect(items[0]).toMatchObject({ kind: "user", text: "Summarise this", attachments });
  });

  it("keeps every text block of a message sent without files", () => {
    const { items } = buildConversation(
      events([{ type: "user.message", content: [{ type: "text", text: "one " }, { type: "text", text: "two" }] }]),
    );
    expect(items[0]).toMatchObject({ kind: "user", text: "one two", attachments: [] });
  });
});

describe("a grant the server recorded", () => {
  const asked = [
    ask("Build the plan"),
    { type: "system.access_request", request_id: "acreq-1", service: "hubspot", reason: "To read the deal" },
  ];

  it("marks its request card granted and answered, and the request is no longer open", () => {
    const c = buildConversation(
      events([...asked, { type: "system.access_granted", request_id: "acreq-1", service: "hubspot", vault_id: "vlt_1" }]),
    );
    const card = blocksOf(c).find((b) => b.kind === "card");
    expect(card).toMatchObject({ card: "access_request", granted: true, request: "answered" });
    expect(c.openRequests).toEqual([]);
    // The grant itself is state for the card, never a row of its own.
    expect(blocksOf(c)).toHaveLength(1);
  });

  it("leaves a request without one open", () => {
    const c = buildConversation(events(asked));
    expect(blocksOf(c).find((b) => b.kind === "card")).toMatchObject({ granted: false, request: "open" });
    expect(c.openRequests.map((r) => r.key)).toEqual(["acreq-1"]);
  });

  it("marks a saved login switched, and memory turning on is its own card", () => {
    const c = buildConversation(
      events([
        ask("Set me up"),
        { type: "system.saved_login_attached", request_id: "sl-1", service: "linear", mcp_server_url: "https://mcp.linear.app/mcp", vault_id: "vlt_1", vault_name: "Linear", agent_name: "Ops", can_switch: true },
        { type: "system.memory_enabled", mode: "shared", store_id: "memstore_1", store_name: "Ops memory" },
        { type: "system.saved_login_attached", request_id: "sl-2", service: "notion", mcp_server_url: "https://mcp.notion.com/mcp", vault_id: "vlt_2", vault_name: "Notion", agent_name: "Ops", can_switch: true },
        { type: "system.access_granted", request_id: "sl-1", service: "linear", vault_id: "vlt_3" },
      ]),
    );
    expect(blocksOf(c).map((b) => (b.kind === "card" ? [b.card, b.granted ?? null] : b.kind))).toEqual([
      ["saved_login", true],
      ["memory_enabled", null],
      ["saved_login", false],
    ]);
  });

  it("is read by request id", () => {
    expect(
      [
        ...grantedRequestIds(
          events([
            { type: "system.access_granted", request_id: "a" },
            { type: "system.access_granted", request_id: "" },
            { type: "system.access_request", request_id: "b" },
          ]),
        ),
      ],
    ).toEqual(["a"]);
  });
});
