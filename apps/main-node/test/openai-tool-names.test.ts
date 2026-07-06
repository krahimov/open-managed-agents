// OpenAI 64-char function-name cap — regression for the production 400:
//   "Invalid 'messages[8].tool_calls[0].function.name': string too long.
//    Expected a string with maximum length 64, but got 70 instead."
// (Composio MCP names exceed the cap; every gpt-* turn that touched them
// died mid-loop with no reply.)

import { describe, it, expect } from "vitest";
import {
  OPENAI_MAX_TOOL_NAME,
  openAiSafeToolName,
  sanitizeOpenAiToolNames,
} from "@open-managed-agents/agent/harness/provider";

// The exact 70-char name from the failing prod session.
const COMPOSIO_LONG =
  "mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MULTI_EXECUTE_TOOL";

describe("openAiSafeToolName", () => {
  it("is identity for names within the cap", () => {
    expect(openAiSafeToolName("bash")).toBe("bash");
    const exactly64 = "a".repeat(64);
    expect(openAiSafeToolName(exactly64)).toBe(exactly64);
  });

  it("shortens the real Composio name to ≤64 and stays deterministic", () => {
    expect(COMPOSIO_LONG.length).toBeGreaterThan(OPENAI_MAX_TOOL_NAME);
    const safe = openAiSafeToolName(COMPOSIO_LONG);
    expect(safe.length).toBeLessThanOrEqual(OPENAI_MAX_TOOL_NAME);
    expect(safe).toBe(openAiSafeToolName(COMPOSIO_LONG)); // deterministic
    expect(safe.startsWith("mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MUL")).toBe(true);
  });

  it("is idempotent — a mangled name re-mangles to itself (history replay)", () => {
    const safe = openAiSafeToolName(COMPOSIO_LONG);
    expect(openAiSafeToolName(safe)).toBe(safe);
  });

  it("distinct long names with a shared prefix don't collide", () => {
    const a = "mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MULTI_EXECUTE_TOOL";
    const b = "mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MULTI_EXECUTE_TOOLS";
    expect(openAiSafeToolName(a)).not.toBe(openAiSafeToolName(b));
  });
});

describe("sanitizeOpenAiToolNames", () => {
  it("no-op fast path returns the same references when everything fits", () => {
    const tools = { bash: { x: 1 } };
    const messages = [
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "t1", toolName: "bash" }] },
    ];
    const out = sanitizeOpenAiToolNames({ tools, messages });
    expect(out.tools).toBe(tools);
    expect(out.messages).toBe(messages);
  });

  it("re-keys long tool names and rewrites history tool parts consistently", () => {
    const safe = openAiSafeToolName(COMPOSIO_LONG);
    const execute = async () => "ok";
    const tools: Record<string, unknown> = { bash: { execute }, [COMPOSIO_LONG]: { execute } };
    const messages = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling" },
          { type: "tool-call", toolCallId: "call_1", toolName: COMPOSIO_LONG, input: { q: 1 } },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "call_1", toolName: COMPOSIO_LONG, output: { ok: true } },
        ],
      },
    ];
    const out = sanitizeOpenAiToolNames({ tools, messages });
    expect(Object.keys(out.tools!)).toEqual(["bash", safe]);
    // Every name in the payload now fits OpenAI's cap.
    for (const k of Object.keys(out.tools!)) expect(k.length).toBeLessThanOrEqual(64);
    const asst = out.messages![1] as { content: Array<{ type: string; toolName?: string }> };
    expect(asst.content[1].toolName).toBe(safe);
    const toolMsg = out.messages![2] as { content: Array<{ toolName?: string }> };
    expect(toolMsg.content[0].toolName).toBe(safe);
    // History name matches the tools-dict key → the SDK can pair them.
    expect(Object.keys(out.tools!)).toContain(asst.content[1].toolName);
    // Untouched entries pass through, string content untouched.
    expect(out.messages![0]).toBe(messages[0]);
  });
});
