// MCP tool results — one model-facing form, in-turn and on replay.
//
// The AI SDK MCP client's execute returns the raw CallToolResult
// ({ content: [...], structuredContent?, isError? }) and converts it for
// the model with its own toModelOutput. The harness persisted that RAW
// object (normalizeToolOutputForWire fell back to JSON.stringify), so every
// later turn replayed a larger, differently shaped blob than the model saw
// in-turn — structuredContent duplicated the text, the JSON envelope
// wrapped it — which changed the request prefix and broke the provider
// prompt cache from that tool result on. Nothing capped MCP results
// either (built-ins truncate at MAX_TOOL_RESULT_CHARS).
//
// Now the MCP tool's execute itself returns the model-facing value:
//   - text-only result (the common case) → one string, text parts joined
//     with "\n", capped at MAX_TOOL_RESULT_CHARS. The string is what the
//     model sees in-turn ({type:"text"}), what agent.mcp_tool_result stores
//     and what history replays — byte for byte.
//   - result with images → ContentBlock[] (the text, then base64 images),
//     shown to the model as content parts. agent.mcp_tool_result content is
//     a string on the wire, so the persisted copy keeps the text and puts a
//     placeholder where each image was (mcpWireText); only these results
//     replay differently from what the model saw in-turn. Through
//     call_mcp_tool (agent.tool_result, which carries ContentBlock[]) they
//     persist exactly as shown.
//
// Old events stored the JSON envelope as a plain string; they stay strings
// and replay exactly as before.
//
// Oversized text results (mcpResultWithSpill): a result is persisted once
// but re-read on every later model call of the thread — on the 2026-11
// gpt-6.1-sol evals MCP results were ~70% of all input tokens, single
// results up to the 50k-char cap (Composio SEARCH_TOOLS schemas, PostHog
// docs, workbench dumps). When the agent has a sandbox file tool, a text
// result over the preview limit is written in full to the sandbox
// (MCP_RESULT_SPILL_DIR, JSON pretty-printed so read/grep can address
// lines) and the model gets the head plus a note naming the file. Decided
// once, when the result is produced: the preview is what is persisted and
// replayed, so earlier history — and the provider prompt cache — never
// changes. A failed write falls back to the plain cap.

import type { JSONValue } from "ai";
import { isContentBlockArray, truncateResult, type ContentBlock } from "@open-managed-agents/shared";

// The cap, ContentBlock[] check and wire placeholder live in shared
// (packages/shared/src/tool-result.ts) — the approval paths in
// session-runtime and session-do store results with them too.
export { MAX_TOOL_RESULT_CHARS, isContentBlockArray, mcpWireText, truncateResult } from "@open-managed-agents/shared";

interface McpContentPart {
  type?: unknown;
  text?: unknown;
  data?: unknown;
  mimeType?: unknown;
}

interface CallToolResultLike {
  content?: McpContentPart[];
  structuredContent?: unknown;
  toolResult?: unknown;
  isError?: unknown;
}

/** True for an MCP CallToolResult (current `content` shape, or the legacy
 *  2024-10 `toolResult` shape). Wire ContentBlocks / AI SDK outputs carry a
 *  `type` and are not results. */
export function isCallToolResult(raw: unknown): raw is CallToolResultLike {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || "type" in raw) return false;
  const r = raw as CallToolResultLike;
  return Array.isArray(r.content) || "structuredContent" in r || "toolResult" in r;
}


/**
 * Raw MCP tool output → the value the model sees (and the harness
 * persists). Pure; same input → same bytes. Non-result values (already a
 * string, a thrown-error string) are truncated and passed through.
 */
export function mcpResultForModel(raw: unknown): string | ContentBlock[] {
  const v = mcpResultUncapped(raw);
  return typeof v === "string" ? truncateResult(v) : v;
}

/** mcpResultForModel without the text cap (images are capped already). */
function mcpResultUncapped(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (!isCallToolResult(raw)) return raw == null ? "" : JSON.stringify(raw);

  const texts: string[] = [];
  const images: ContentBlock[] = [];
  if (Array.isArray(raw.content)) {
    for (const part of raw.content) {
      if (part?.type === "text" && typeof part.text === "string") {
        texts.push(part.text);
      } else if (part?.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string") {
        images.push({ type: "image", source: { type: "base64", media_type: part.mimeType, data: part.data } } as ContentBlock);
      } else {
        // resource / resource_link / audio — same serialization the AI SDK
        // MCP client uses for parts it doesn't map.
        texts.push(JSON.stringify(part));
      }
    }
  }
  // Spec: a tool returning structuredContent SHOULD also return it as a
  // text block; only fall back to it (or the legacy toolResult) when the
  // result carries no content at all.
  if (texts.length === 0 && images.length === 0) {
    const fallback = raw.structuredContent ?? raw.toolResult;
    if (fallback !== undefined) texts.push(typeof fallback === "string" ? fallback : JSON.stringify(fallback));
  }
  let text = texts.join("\n");
  // isError has no slot in a plain text result; keep the signal in the text.
  if (raw.isError === true && !/^\s*error\b/i.test(text)) text = `Error: ${text}`;
  if (images.length === 0) return text;
  text = truncateResult(text);
  return [...(text ? [{ type: "text", text } as ContentBlock] : []), ...images];
}

/** Where oversized MCP results are written in full (sandbox path). */
export const MCP_RESULT_SPILL_DIR = "/workspace/.tool-results";
/** Default preview length (chars, ~5k tokens) above which a text MCP
 *  result is spilled. Per agent: `metadata.mcp_result_max_chars` (0 turns
 *  spilling off → the plain MAX_TOOL_RESULT_CHARS cap). */
export const DEFAULT_MCP_RESULT_PREVIEW_CHARS = 20_000;

export interface McpResultSpill {
  /** Preview length; longer text results are spilled. */
  maxChars: number;
  /** Persist `content` at `path` (sandbox writeFile; creates parents). */
  write(path: string, content: string): Promise<unknown>;
  /** Sandbox tools the note may point the model at (read / grep / bash). */
  readers: string[];
}

/** `metadata.mcp_result_max_chars` → preview length; 0 = no spilling. */
export function mcpResultPreviewChars(metadata: unknown): number {
  const v = (metadata as { mcp_result_max_chars?: unknown } | null | undefined)?.mcp_result_max_chars;
  if (typeof v !== "number" || !Number.isFinite(v)) return DEFAULT_MCP_RESULT_PREVIEW_CHARS;
  return v <= 0 ? 0 : Math.max(1_000, Math.floor(v));
}

/** Sandbox file for one call's full result. */
export function mcpSpillPath(toolCallId: string, json: boolean): string {
  const id = toolCallId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "result";
  return `${MCP_RESULT_SPILL_DIR}/${id}.${json ? "json" : "txt"}`;
}

/** The persisted form of a spilled result: its head (cut at a line end
 *  when one is near) and a note naming the full copy. Pure. */
export function mcpSpillPreview(
  text: string,
  path: string,
  opts: { maxChars: number; readers: string[]; lines: number; json: boolean },
): string {
  const nl = text.lastIndexOf("\n", opts.maxChars);
  const cut = nl > opts.maxChars * 0.8 ? nl : opts.maxChars;
  const how = opts.readers.length > 0 ? ` with ${opts.readers.join(" / ")}` : "";
  return (
    `${text.slice(0, cut)}\n` +
    `...[output truncated: showing the first ${cut} of ${text.length} chars. ` +
    `The full output is saved at ${path} (${opts.json ? "pretty-printed JSON, " : ""}${opts.lines} lines) — ` +
    `search or page through that file${how} instead of calling the tool again.]`
  );
}

/**
 * mcpResultForModel for a call the harness can spill: a text result
 * longer than `spill.maxChars` is written in full to the sandbox and
 * replaced by mcpSpillPreview. Images, short results, no spill config or
 * a failed write → exactly mcpResultForModel.
 */
export async function mcpResultWithSpill(
  raw: unknown,
  toolCallId: string | undefined,
  spill: McpResultSpill | undefined,
): Promise<string | ContentBlock[]> {
  const v = mcpResultUncapped(raw);
  if (typeof v !== "string") return v;
  if (!spill || spill.maxChars <= 0 || !toolCallId || v.length <= spill.maxChars) return truncateResult(v);
  let file = v;
  let json = false;
  if (/^\s*[[{]/.test(v)) {
    try {
      file = JSON.stringify(JSON.parse(v), null, 2);
      json = true;
    } catch {
      // Not JSON after all — keep the text as is.
    }
  }
  const path = mcpSpillPath(toolCallId, json);
  try {
    await spill.write(path, file);
  } catch (err) {
    console.warn(`[mcp] could not save the full result to ${path}: ${err instanceof Error ? err.message : String(err)}`);
    return truncateResult(v);
  }
  return mcpSpillPreview(v, path, {
    maxChars: spill.maxChars,
    readers: spill.readers,
    lines: file.split("\n").length,
    json,
  });
}

type ModelOutput =
  | { type: "text"; value: string }
  | { type: "content"; value: Array<{ type: "text"; text: string } | { type: "image-data"; data: string; mediaType: string }> }
  | { type: "json"; value: JSONValue };

/**
 * toModelOutput for MCP tools and call_mcp_tool: the model-facing value →
 * AI SDK ToolResultOutput, the same shape the history projection
 * (wireContentToToolOutput in runtime/history.ts) rebuilds from the
 * persisted event, so replay matches the in-turn request.
 */
export function mcpModelOutput({ output }: { output: unknown }): ModelOutput {
  const v = isCallToolResult(output) ? mcpResultForModel(output) : output;
  if (typeof v === "string") return { type: "text", value: v };
  if (isContentBlockArray(v)) {
    return {
      type: "content",
      value: v.map((b) => {
        if (b.type === "text") return { type: "text" as const, text: b.text };
        if (b.type === "image" && b.source.type === "base64") {
          return { type: "image-data" as const, data: b.source.data ?? "", mediaType: b.source.media_type ?? "image/png" };
        }
        return { type: "text" as const, text: JSON.stringify(b) };
      }),
    };
  }
  return { type: "json", value: (v ?? null) as JSONValue };
}
