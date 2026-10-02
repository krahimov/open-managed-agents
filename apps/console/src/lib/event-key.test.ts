import { describe, expect, it } from "vitest";
import { eventKey } from "./event-key";
import type { Event } from "./events";

function replay(events: Event[]): Event[] {
  return [...new Map(events.map(event => [eventKey(event), event])).values()];
}

describe("session event replay identity", () => {
  it("keeps repeated completed key presses while deduplicating live/history overlap", () => {
    const first = { type: "agent.tool_result", tool_use_id: "call_1", content: "Pressed desktop key" };
    const second = { ...first, tool_use_id: "call_2" };
    const events = replay([first, second, { ...first, seq: 12 }, { ...second, seq: 18 }]);
    expect(events.map(event => event.tool_use_id)).toEqual(["call_1", "call_2"]);
  });
  it("keeps identical screenshots returned by distinct calls", () => {
    const content = [{ type: "image", text: "same screenshot" }];
    expect(replay([
      { type: "agent.tool_result", tool_use_id: "capture_1", content },
      { type: "agent.tool_result", tool_use_id: "capture_2", content },
    ])).toHaveLength(2);
  });
  it("deduplicates persisted events by sequence while keeping repeated status changes", () => {
    const first = { type: "session.status_idle", seq: 4 };
    expect(replay([first, { ...first }, { ...first, seq: 9 }])).toHaveLength(2);
  });
  it("preserves explicit event IDs and distinguishes MCP calls", () => {
    expect(eventKey({type:"agent.message",id:"event_1"})).toBe("event_1");
    expect(replay([
      {type:"agent.mcp_tool_result",mcp_tool_use_id:"mcp_1",content:"ok"},
      {type:"agent.mcp_tool_result",mcp_tool_use_id:"mcp_2",content:"ok"},
    ])).toHaveLength(2);
  });

  describe("pending-queue frames", () => {
    // QA F7 reproducer: Node frames carry event_id + nested event but no
    // top-level id/seq/ts, so distinct frames used to share one key.
    for (const type of ["system.user_message_pending", "system.user_message_promoted"]) {
      it(`keeps distinct Node ${type} frames apart and dedupes repeats`, () => {
        const a = { type, event_id: "message-a", pending_seq: 1, event: { type: "user.message", content: [{ type: "text", text: "first" }] } };
        const b = { type, event_id: "message-b", pending_seq: 2, event: { type: "user.message", content: [{ type: "text", text: "second" }] } };
        expect(eventKey(a)).not.toBe(eventKey(b));
        expect(replay([a, b, { ...a }])).toHaveLength(2);
      });
    }

    it("falls back to the nested event id when event_id is missing", () => {
      const frame = (id: string) => ({ type: "system.user_message_pending", event: { type: "user.message", id } });
      expect(eventKey(frame("sevt_1"))).not.toBe(eventKey(frame("sevt_2")));
    });

    it("keys CF promoted frames by event_id, not the promoted row's seq", () => {
      // CF promoted frames echo the seq of the user event they promote.
      const userEvent = { type: "user.message", seq: 7 };
      const promoted = { type: "system.user_message_promoted", event_id: "sevt_u", pending_seq: 3, seq: 7, processed_at: "t", session_thread_id: "sthr_primary" };
      expect(eventKey(promoted)).toBe("system.user_message_promoted:sevt_u");
      expect(replay([userEvent, promoted])).toHaveLength(2);
    });

    it("keeps CF legacy-backfill promoted frames (empty event_id) distinct by seq", () => {
      const p = (seq: number) => ({ type: "system.user_message_promoted", event_id: "", seq, processed_at: "t" });
      expect(replay([p(4), p(5), p(4)])).toHaveLength(2);
      expect(eventKey(p(4))).not.toBe(eventKey({ type: "user.message", seq: 4 }));
    });

    it("does not let a pending and a promoted frame for the same input collide", () => {
      const pending = { type: "system.user_message_pending", event_id: "sevt_x", pending_seq: 1 };
      const promoted = { type: "system.user_message_promoted", event_id: "sevt_x", pending_seq: 1 };
      expect(eventKey(pending)).not.toBe(eventKey(promoted));
    });
  });
});
