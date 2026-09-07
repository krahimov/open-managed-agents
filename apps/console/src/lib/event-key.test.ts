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
});
