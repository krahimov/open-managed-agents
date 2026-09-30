/**
 * OMA history → pi-ai messages.
 *
 * The Pi harness stays stateless: every turn it re-derives the transcript
 * from the OMA event log through the SAME projection the default harness
 * uses (`eventsToMessagesAsync` in runtime/history.ts — compaction
 * boundaries, cancelled inputs, file_id resolution), then converts the
 * resulting AI SDK ModelMessage[] into pi-ai's Message[] shape here.
 * Reusing the projection keeps one source of truth for "what the model
 * sees" and lets an agent switch between `default` and `pi` mid-session.
 *
 * Known lossy spots (pi-ai content model is text + image only):
 *   - document / file parts become a text placeholder (text/* files are
 *     inlined as text);
 *   - image URLs become a text placeholder (pi-ai wants inline base64).
 */

import type { ModelMessage } from "ai";
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@earendil-works/pi-ai";

const ZERO_USAGE: Usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface ToPiOptions {
  /** Model the transcript is sent to; replayed assistant turns are stamped
   *  with it so pi-ai keeps thinking signatures (same-model replay). */
  model: Model<Api>;
  /** OMA tool name → wire tool name (identity unless OpenAI's 64-char cap applies). */
  toolName?: (omaName: string) => string;
}

// ─── bytes helpers ──────────────────────────────────────────────────────

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function base64ToText(b64: string): string | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

/** AI SDK DataContent | URL → { base64 } | { url } */
function dataOf(value: unknown): { base64: string } | { url: string } | null {
  if (value instanceof URL) return { url: value.toString() };
  if (typeof value === "string") {
    const m = /^data:[^;,]+;base64,(.*)$/s.exec(value);
    if (m) return { base64: m[1] };
    if (/^https?:\/\//i.test(value)) return { url: value };
    return { base64: value };
  }
  if (value instanceof Uint8Array) return { base64: bytesToBase64(value) };
  if (value instanceof ArrayBuffer) return { base64: bytesToBase64(new Uint8Array(value)) };
  return null;
}

function imagePart(data: unknown, mediaType: string | undefined): TextContent | ImageContent {
  const d = dataOf(data);
  if (d && "base64" in d && d.base64) {
    return { type: "image", data: d.base64, mimeType: mediaType ?? "image/png" };
  }
  if (d && "url" in d) return { type: "text", text: `[image: ${d.url}]` };
  return { type: "text", text: "[image unavailable]" };
}

function filePart(data: unknown, mediaType: string | undefined, filename?: string): TextContent | ImageContent {
  const mt = mediaType ?? "application/octet-stream";
  if (mt.startsWith("image/")) return imagePart(data, mt);
  const d = dataOf(data);
  const label = filename ? `${filename} (${mt})` : mt;
  if (d && "base64" in d && mt.startsWith("text/")) {
    const text = base64ToText(d.base64);
    if (text != null) return { type: "text", text: filename ? `[${filename}]\n${text}` : text };
  }
  if (d && "url" in d) return { type: "text", text: `[document ${label}: ${d.url}]` };
  return { type: "text", text: `[document ${label} attached — not viewable by this harness]` };
}

// ─── thinking signature round-trip ──────────────────────────────────────

/**
 * agent.thinking.providerOptions → pi ThinkingContent signature fields.
 * Reads the Pi-native record first (written by this harness), then the
 * AI SDK Anthropic shape the default harness persists
 * ({anthropic:{signature}} / {anthropic:{redactedData}}).
 */
export function thinkingFromProviderOptions(
  text: string,
  providerOptions: Record<string, unknown> | undefined,
): ThinkingContent {
  const pi = providerOptions?.pi as { thinkingSignature?: string; redacted?: boolean } | undefined;
  if (pi?.thinkingSignature) {
    return {
      type: "thinking",
      thinking: text,
      thinkingSignature: pi.thinkingSignature,
      ...(pi.redacted ? { redacted: true } : {}),
    };
  }
  const ant = providerOptions?.anthropic as { signature?: string; redactedData?: string } | undefined;
  if (ant?.redactedData) {
    return { type: "thinking", thinking: text, thinkingSignature: ant.redactedData, redacted: true };
  }
  if (ant?.signature) return { type: "thinking", thinking: text, thinkingSignature: ant.signature };
  return { type: "thinking", thinking: text };
}

/**
 * pi ThinkingContent → agent.thinking.providerOptions. Writes both the
 * Pi-native record and, for Anthropic, the AI SDK shape so the default
 * harness can replay Pi-produced thinking blocks too.
 */
export function providerOptionsFromThinking(
  block: ThinkingContent,
  api: Api,
): Record<string, unknown> | undefined {
  if (!block.thinkingSignature) return undefined;
  const out: Record<string, unknown> = {
    pi: { thinkingSignature: block.thinkingSignature, ...(block.redacted ? { redacted: true } : {}) },
  };
  if (api === "anthropic-messages") {
    out.anthropic = block.redacted
      ? { redactedData: block.thinkingSignature }
      : { signature: block.thinkingSignature };
  }
  return out;
}

// ─── tool-result output ─────────────────────────────────────────────────

/** AI SDK ToolResultOutput (as produced by history.ts) → pi content + error flag. */
function toolOutputToPi(output: unknown): { content: (TextContent | ImageContent)[]; isError: boolean } {
  if (output == null) return { content: [{ type: "text", text: "" }], isError: false };
  if (typeof output === "string") return { content: [{ type: "text", text: output }], isError: false };
  const o = output as { type?: string; value?: unknown; reason?: string };
  switch (o.type) {
    case "text":
      return { content: [{ type: "text", text: String(o.value ?? "") }], isError: false };
    case "error-text":
      return { content: [{ type: "text", text: String(o.value ?? "") }], isError: true };
    case "json":
      return { content: [{ type: "text", text: JSON.stringify(o.value) }], isError: false };
    case "error-json":
      return { content: [{ type: "text", text: JSON.stringify(o.value) }], isError: true };
    case "execution-denied":
      return { content: [{ type: "text", text: JSON.stringify({ denied: true, reason: o.reason }) }], isError: true };
    case "content": {
      const parts = Array.isArray(o.value) ? (o.value as Array<Record<string, unknown>>) : [];
      const content = parts.map((p): TextContent | ImageContent => {
        switch (p.type) {
          case "text":
            return { type: "text", text: String(p.text ?? "") };
          case "image-data":
          case "media":
            return imagePart(p.data, p.mediaType as string | undefined);
          case "image-url":
            return { type: "text", text: `[image: ${String(p.url ?? "")}]` };
          case "file-data":
            return filePart(p.data, p.mediaType as string | undefined, p.filename as string | undefined);
          case "file-url":
            return { type: "text", text: `[document: ${String(p.url ?? "")}]` };
          default:
            return { type: "text", text: JSON.stringify(p) };
        }
      });
      return { content: content.length ? content : [{ type: "text", text: "" }], isError: false };
    }
    default:
      return { content: [{ type: "text", text: JSON.stringify(output) }], isError: false };
  }
}

// ─── main conversion ────────────────────────────────────────────────────

export function modelMessagesToPi(messages: ModelMessage[], opts: ToPiOptions): Message[] {
  const { model } = opts;
  const mapName = opts.toolName ?? ((n: string) => n);
  const out: Message[] = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "system": {
        // The platform system prompt is installed separately as the leading
        // pi SystemMessage; a stray system message in history is appended as
        // additional instructions (pi's mid-conversation system message).
        const text = typeof msg.content === "string" ? msg.content : "";
        if (text.trim()) out.push({ role: "system", content: text, timestamp: 0 });
        break;
      }
      case "user": {
        const parts: (TextContent | ImageContent)[] = [];
        if (typeof msg.content === "string") {
          if (msg.content.trim()) parts.push({ type: "text", text: msg.content });
        } else {
          for (const p of msg.content as unknown as Array<Record<string, unknown>>) {
            if (p.type === "text") {
              const text = String(p.text ?? "");
              // Anthropic rejects empty text blocks; resume markers are "".
              if (text.trim()) parts.push({ type: "text", text });
            } else if (p.type === "image") {
              parts.push(imagePart(p.image, p.mediaType as string | undefined));
            } else if (p.type === "file") {
              parts.push(filePart(p.data, p.mediaType as string | undefined, p.filename as string | undefined));
            }
          }
        }
        if (parts.length > 0) out.push({ role: "user", content: parts, timestamp: 0 });
        break;
      }
      case "assistant": {
        const content: AssistantMessage["content"] = [];
        const parts = typeof msg.content === "string"
          ? [{ type: "text", text: msg.content } as Record<string, unknown>]
          : (msg.content as unknown as Array<Record<string, unknown>>);
        for (const p of parts) {
          if (p.type === "text") {
            const text = String(p.text ?? "");
            if (text) content.push({ type: "text", text });
          } else if (p.type === "reasoning") {
            content.push(
              thinkingFromProviderOptions(
                String(p.text ?? ""),
                p.providerOptions as Record<string, unknown> | undefined,
              ),
            );
          } else if (p.type === "tool-call") {
            const input = p.input;
            const args = input && typeof input === "object" && !Array.isArray(input)
              ? (input as ToolCall["arguments"])
              : {};
            content.push({
              type: "toolCall",
              id: String(p.toolCallId),
              name: mapName(String(p.toolName)),
              arguments: args,
            });
          }
        }
        if (content.length === 0) break;
        out.push({
          role: "assistant",
          content,
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: ZERO_USAGE,
          stopReason: content.some((c) => c.type === "toolCall") ? "toolUse" : "stop",
          timestamp: 0,
        });
        break;
      }
      case "tool": {
        for (const p of msg.content as unknown as Array<Record<string, unknown>>) {
          if (p.type !== "tool-result") continue;
          const { content, isError } = toolOutputToPi(p.output);
          const result: ToolResultMessage = {
            role: "toolResult",
            toolCallId: String(p.toolCallId),
            toolName: mapName(String(p.toolName ?? "unknown")),
            content,
            isError,
            timestamp: 0,
          };
          out.push(result);
        }
        break;
      }
    }
  }
  return out;
}

/**
 * pi-agent-core's continue entry point requires a user / toolResult tail.
 * A transcript that ends on an assistant turn (e.g. a resumed session whose
 * last turn stopped cleanly) gets a minimal user nudge so the request is
 * valid on every provider.
 */
export function ensureContinuableTail(messages: Message[]): Message[] {
  const last = messages[messages.length - 1];
  if (!last || last.role === "assistant" || last.role === "system") {
    return [...messages, { role: "user", content: [{ type: "text", text: "Continue." }], timestamp: 0 }];
  }
  return messages;
}
