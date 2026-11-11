// Tool result → stored content, shared by the harness (apps/agent, in-turn)
// and the approval paths that run a tool outside the AI SDK loop
// (session-runtime's machine.ts on Node, session-do.ts on CF). Both must
// store the same thing for the same result: an approved MCP call that
// returned an image used to persist the whole base64 as JSON text, where
// the un-gated call stored a short placeholder.

import type { ContentBlock } from "@open-managed-agents/api-types";

export const MAX_TOOL_RESULT_CHARS = 50000;

/**
 * Truncate tool results that exceed the maximum size.
 * CC persists to disk; we truncate with preview since we don't have
 * local filesystem access from the harness layer.
 */
export function truncateResult(result: string): string {
  if (result.length > MAX_TOOL_RESULT_CHARS) {
    return result.slice(0, MAX_TOOL_RESULT_CHARS) + `\n...(truncated, total ${result.length} chars)`;
  }
  return result;
}

/** True for a wire ContentBlock[] (what MCP tools return for image results). */
export function isContentBlockArray(v: unknown): v is ContentBlock[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((b) => !!b && typeof b === "object" && typeof (b as { type?: unknown }).type === "string")
  );
}

/** A ContentBlock[] as plain text for agent.mcp_tool_result (string on the
 *  wire): text kept, each image replaced by a short placeholder. */
export function mcpWireText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => {
      if (b.type === "text") return b.text;
      if (b.type === "image") {
        return `[image ${b.source.media_type ?? ""} returned by the tool — shown when it ran, not kept in history]`;
      }
      return JSON.stringify(b);
    })
    .join("\n");
}

/**
 * What a tool's execute returned → result-event content, for callers that
 * run a tool directly (approved ask-gated calls). Strings and
 * ContentBlock[] (MCP image results, already capped) pass through — the
 * event builder turns the latter into placeholder text where the wire
 * wants a string; anything else is JSON, capped.
 */
export function toolExecutionResultContent(result: unknown): string | ContentBlock[] {
  if (typeof result === "string" || isContentBlockArray(result)) return result;
  return truncateResult(result == null ? "" : JSON.stringify(result));
}
