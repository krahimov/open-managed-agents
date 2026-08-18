// Turn-scoped reminders (memory-facts-design §5 push, cache-safe variant):
// appended to the LAST user message's parts in the model context, never to
// the system prompt and never to the persisted event.

// @ts-nocheck
import { describe, it, expect } from "vitest";
import { appendTurnReminders } from "../../apps/agent/src/harness/default-loop";

describe("appendTurnReminders", () => {
  it("appends a <source>-wrapped text part to the last user message (array content)", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "earlier" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "book a 9am meeting" }] },
    ];
    appendTurnReminders(messages, [{ source: "memory:relevant", text: "- [preference] No meetings before 10am." }]);
    expect(messages).toHaveLength(3);
    const last = messages[2];
    expect(last.role).toBe("user");
    expect(last.content).toHaveLength(2);
    expect(last.content[0]).toEqual({ type: "text", text: "book a 9am meeting" });
    expect(last.content[1].text).toBe('<source name="memory:relevant">\n- [preference] No meetings before 10am.\n</source>');
    // earlier messages untouched
    expect(messages[0].content).toEqual([{ type: "text", text: "earlier" }]);
  });

  it("handles string content by converting to parts", () => {
    const messages = [{ role: "user", content: "hi" }];
    appendTurnReminders(messages, [{ source: "a", text: "x" }, { source: "b", text: "y" }]);
    expect(messages[0].content[0]).toEqual({ type: "text", text: "hi" });
    expect(messages[0].content[1].text).toBe('<source name="a">\nx\n</source>\n\n<source name="b">\ny\n</source>');
  });

  it("adds a new user message when the tail isn't a user message", () => {
    const messages = [{ role: "assistant", content: [{ type: "text", text: "ok" }] }];
    appendTurnReminders(messages, [{ source: "a", text: "x" }]);
    expect(messages).toHaveLength(2);
    expect(messages[1].role).toBe("user");
  });
});
