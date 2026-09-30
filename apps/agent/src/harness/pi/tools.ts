/**
 * OMA platform tools (AI SDK `tool()` objects) → pi-agent-core AgentTools.
 *
 * Execution always goes through the OMA tool's own `execute`, so sandbox
 * routing, the vault outbound proxy, MCP bridging, access-policy wrappers
 * and output truncation behave exactly as on the default harness. The
 * adapter only translates shapes:
 *
 *   inputSchema (zod | jsonSchema()) → plain JSON Schema via AI SDK
 *   `asSchema()`. pi-ai validates non-TypeBox schemas through its
 *   JSON-schema path (with primitive coercion); the OMA schema's own
 *   `validate` then runs too, so zod defaults/transforms still apply.
 *
 *   execute output → OMA wire content (`string | ContentBlock[]`, the
 *   exact normalization default-loop applies) → pi content (text/image).
 *   The wire form travels in `details.oma_wire` so the harness can
 *   persist it byte-identically to the default harness.
 *
 * Tools WITHOUT execute (always_ask permission policy, client-side custom
 * tools) must not run: they return a sentinel result flagged
 * `details.oma_pending`; the harness suppresses its tool_result, records
 * the call in `runtime.pendingConfirmations`, and ends the loop after the
 * turn — the same "requires_action" contract the default harness gets from
 * the AI SDK leaving such calls unresulted.
 */

import { asSchema } from "ai";
import type { ModelMessage } from "ai";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ContentBlock } from "@open-managed-agents/shared";
import { openAiSafeToolName } from "../provider";

export const PENDING_TOOL_TEXT =
  "Awaiting user action (tool confirmation or client-side result); this call has not run yet.";

export interface OmaToolDetails {
  /** Wire content persisted as agent.tool_result.content. */
  oma_wire?: string | ContentBlock[];
  /** Set when the tool has no execute — needs confirmation / client result. */
  oma_pending?: true;
}

export interface AdaptedTools {
  tools: AgentTool[];
  /** OMA tool name → wire tool name. */
  toWire: (omaName: string) => string;
  /** Wire tool name → OMA tool name (identity for unknown names). */
  toOma: (wireName: string) => string;
  /** True when the OMA tool has no execute function. */
  isPending: (omaName: string) => boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OmaTool = { description?: string; inputSchema?: any; parameters?: any; execute?: (...args: any[]) => any };

/** JSON Schema cleanup for provider tool declarations. */
function cleanSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return { type: "object", properties: {} };
  const { $schema: _drop, ...rest } = schema as Record<string, unknown>;
  if (rest.type === undefined && rest.properties === undefined) {
    return { type: "object", properties: {}, ...rest };
  }
  return rest;
}

function isAsyncIterable(v: unknown): v is AsyncIterable<unknown> {
  return !!v && typeof v === "object" && Symbol.asyncIterator in (v as object);
}

/**
 * AI SDK tool output → OMA wire content. Kept byte-compatible with
 * default-loop.ts normalizeToolOutputForWire (which receives the raw
 * execute output on the AI SDK path) so both harnesses persist identical
 * agent.tool_result payloads.
 */
export function normalizeToolOutputForWire(raw: unknown): string | ContentBlock[] {
  if (typeof raw === "string") return raw;
  if (raw == null) return "";
  if (typeof raw === "object" && "type" in (raw as object)) {
    const r = raw as { type: string; value?: unknown; reason?: string };
    if (r.type === "text" && "text" in (raw as object)) return [raw as ContentBlock];
    if (r.type === "image" && "source" in (raw as object)) return [raw as ContentBlock];
    if (r.type === "document" && "source" in (raw as object)) return [raw as ContentBlock];
    if (r.type === "text" && "value" in (raw as object)) return String(r.value);
    if (r.type === "json") return JSON.stringify(r.value);
    if (r.type === "error-text" || r.type === "error-json") {
      return typeof r.value === "string" ? r.value : JSON.stringify(r.value);
    }
    if (r.type === "execution-denied") return JSON.stringify({ denied: true, reason: r.reason });
  }
  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "type" in b)) {
    return raw as ContentBlock[];
  }
  return JSON.stringify(raw);
}

/** OMA wire content → pi tool-result content. */
export function wireToPiContent(wire: string | ContentBlock[]): (TextContent | ImageContent)[] {
  if (typeof wire === "string") return [{ type: "text", text: wire }];
  const out: (TextContent | ImageContent)[] = [];
  for (const b of wire) {
    if (b.type === "text") out.push({ type: "text", text: b.text });
    else if (b.type === "image" && b.source.type === "base64" && b.source.data) {
      out.push({ type: "image", data: b.source.data, mimeType: b.source.media_type ?? "image/png" });
    } else if (b.type === "image") {
      out.push({ type: "text", text: `[image: ${b.source.url ?? b.source.file_id ?? "unavailable"}]` });
    } else if (b.type === "document") {
      const mt = b.source.media_type ?? "application/octet-stream";
      if (b.source.type === "text" && b.source.data) out.push({ type: "text", text: b.source.data });
      else out.push({ type: "text", text: `[document ${b.title ?? mt} returned — not viewable by this harness]` });
    } else {
      out.push({ type: "text", text: JSON.stringify(b) });
    }
  }
  return out.length ? out : [{ type: "text", text: "" }];
}

/** pi tool-result content → OMA wire content (fallback when details lack oma_wire). */
export function piContentToWire(content: (TextContent | ImageContent)[] | undefined): string | ContentBlock[] {
  if (!content || content.length === 0) return "";
  if (content.every((c) => c.type === "text")) return content.map((c) => (c as TextContent).text).join("\n");
  return content.map((c): ContentBlock =>
    c.type === "text"
      ? { type: "text", text: c.text }
      : { type: "image", source: { type: "base64", media_type: c.mimeType, data: c.data } },
  );
}

export async function adaptOmaTools(
  omaTools: Record<string, OmaTool>,
  opts: { openAiToolNames?: boolean; messages?: () => ModelMessage[] } = {},
): Promise<AdaptedTools> {
  const wireToOma = new Map<string, string>();
  const toWire = (name: string) => (opts.openAiToolNames ? openAiSafeToolName(name) : name);
  const tools: AgentTool[] = [];

  for (const [omaName, t] of Object.entries(omaTools)) {
    if (!t || typeof t !== "object") continue;
    const wireName = toWire(omaName);
    wireToOma.set(wireName, omaName);
    const schema = asSchema(t.inputSchema ?? t.parameters);
    const parameters = cleanSchema(await schema.jsonSchema);

    tools.push({
      name: wireName,
      label: omaName,
      description: t.description ?? "",
      // Plain JSON Schema: pi-ai validates it via its non-TypeBox path.
      parameters: parameters as never,
      execute: async (toolCallId, params, signal): Promise<AgentToolResult<OmaToolDetails>> => {
        if (typeof t.execute !== "function") {
          return {
            content: [{ type: "text", text: PENDING_TOOL_TEXT }],
            details: { oma_pending: true },
            terminate: true,
          };
        }
        let input: unknown = params;
        if (schema.validate) {
          const parsed = await schema.validate(params);
          if (!parsed.success) throw parsed.error;
          input = parsed.value;
        }
        let output = await t.execute(input, {
          toolCallId,
          messages: opts.messages?.() ?? [],
          abortSignal: signal,
        });
        // AI SDK streaming tools yield preliminary values; the last one is final.
        if (isAsyncIterable(output)) {
          let last: unknown;
          for await (const v of output) last = v;
          output = last;
        }
        const wire = normalizeToolOutputForWire(output);
        return { content: wireToPiContent(wire), details: { oma_wire: wire } };
      },
    });
  }

  return {
    tools,
    toWire,
    toOma: (wireName) => wireToOma.get(wireName) ?? wireName,
    isPending: (omaName) => typeof omaTools[omaName]?.execute !== "function",
  };
}
