import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

/**
 * API compatibility types:
 * - "ant"            — Anthropic official API
 * - "ant-compatible" — Third-party Anthropic-compatible API
 * - "oai"            — OpenAI official API
 * - "oai-compatible" — Third-party OpenAI-compatible API (DeepSeek, Groq, etc.)
 */
export type ApiCompat = "ant" | "ant-compatible" | "oai" | "oai-compatible";

const KNOWN_CLAUDE_PREFIX = "claude-";

function normalizeClaudeModelId(modelId: string): string {
  return modelId.replace(
    /^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/,
    "claude-$1-$2-$3",
  );
}

// Cap for non-Claude models on the Anthropic-compat path. The SDK hard-codes
// max_tokens=4096 for unknown models, which truncates extended thinking
// (MiniMax-M2 thinking alone exceeds that). Earlier code deleted the field
// entirely, but the Anthropic spec marks it required — DeepSeek's strict
// (Rust serde) implementation rejects with `missing field max_tokens` and a
// generic 400 that surfaces as `Bad Request` upstream. Setting a high value
// satisfies the spec and gives every provider room for thinking + tool_use.
const NON_CLAUDE_MAX_TOKENS = 32768;

/**
 * Fetch wrapper that overrides @ai-sdk/anthropic's hard-coded max_tokens=4096
 * with NON_CLAUDE_MAX_TOKENS for non-Claude models on the Anthropic-compat
 * path.
 */
async function setMaxTokensFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const finalInit = (() => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.max_tokens = NON_CLAUDE_MAX_TOKENS;
        return { ...init, body: JSON.stringify(body) };
      } catch {
        return init;
      }
    }
    return init;
  })();
  return observingFetch(url, finalInit);
}

/**
 * Wraps globalThis.fetch with always-on observability for provider rate
 * limiting. Logs (via console) + surfaces:
 *  - HTTP status code (so 429 is visible immediately)
 *  - retry-after header (if present)
 *  - x-ratelimit-* headers (any provider that exposes them)
 *  - response body preview when status >= 400 (truncated)
 *
 * Without this we only see indirect signals (model_first_token + no
 * model_request_end → "stalled stream"), which conflates rate limiting
 * with real model slowness, network issues, or provider hangs.
 */
async function observingFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now();
  const method = init?.method ?? "GET";
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  // 5min hard timeout on the whole HTTP exchange (including streaming body).
  // Without it a silent provider stream hangs the SessionDO indefinitely.
  const TIMEOUT_MS = 5 * 60_000;
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await globalThis.fetch(url, { ...init, signal });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    console.warn(`[provider.fetch] ${method} ${urlStr} → THROW after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  const elapsed = Date.now() - startedAt;
  const status = res.status;
  // Collect rate-limit signals from common header names across providers.
  const retryAfter = res.headers.get("retry-after");
  const limitRemaining =
    res.headers.get("x-ratelimit-remaining-requests") ??
    res.headers.get("x-ratelimit-remaining-tokens") ??
    res.headers.get("x-ratelimit-remaining");
  const limitReset =
    res.headers.get("x-ratelimit-reset-requests") ??
    res.headers.get("x-ratelimit-reset-tokens") ??
    res.headers.get("x-ratelimit-reset");
  const interesting = status >= 400 || retryAfter || (limitRemaining && parseInt(limitRemaining, 10) < 5);
  if (interesting) {
    let bodyPreview = "";
    if (status >= 400) {
      try {
        bodyPreview = (await res.clone().text()).slice(0, 500);
      } catch {}
    }
    console.warn(
      `[provider.fetch] ${method} ${urlStr} → ${status} (${elapsed}ms)` +
        (retryAfter ? ` retry-after=${retryAfter}` : "") +
        (limitRemaining ? ` remaining=${limitRemaining}` : "") +
        (limitReset ? ` reset=${limitReset}` : "") +
        (bodyPreview ? ` body=${JSON.stringify(bodyPreview)}` : ""),
    );
  } else if (status >= 200 && status < 300 && elapsed > 5000) {
    // Slow OK response — useful for diagnosing per-call latency
    console.log(`[provider.fetch] ${method} ${urlStr} → ${status} (${elapsed}ms slow)`);
  }
  return res;
}

function useOpenAI(compat: ApiCompat): boolean {
  return compat === "oai" || compat === "oai-compatible";
}

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string,
  compat?: ApiCompat,
  customHeaders?: Record<string, string>,
): LanguageModel {
  const modelString = typeof model === "string" ? model : model.id;

  // Strip provider prefix if present: "anthropic/claude-sonnet-4-6" → "claude-sonnet-4-6"
  const rawModelId = modelString.includes("/")
    ? modelString.split("/").slice(1).join("/")
    : modelString;

  const effectiveCompat = compat || "ant";
  const modelId = useOpenAI(effectiveCompat)
    ? rawModelId
    : normalizeClaudeModelId(rawModelId);

  if (useOpenAI(effectiveCompat)) {
    const openai = createOpenAI({
      apiKey,
      baseURL: baseURL || undefined,
      headers: customHeaders,
      fetch: observingFetch,
    });
    // Use chat/completions endpoint, not Responses API.
    // Reasons:
    //   - Third-party OpenAI-compat gateways (CF AI Gateway, Groq, DeepSeek,
    //     xAI Grok, etc.) only support /v1/chat/completions
    //   - Responses API requires server-side persistence of function call IDs;
    //     orgs with Zero Data Retention enabled get "Item with id 'fc_...' not
    //     found" errors mid-loop
    //   - chat/completions is the de-facto standard contract for OpenAI-compat
    return openai.chat(modelId);
  }

  // ant / ant-compatible
  const isKnownClaude = modelId.startsWith(KNOWN_CLAUDE_PREFIX);

  const headers: Record<string, string> = {};
  if (baseURL) headers["X-Sub-Module"] = "managed-agents";
  if (customHeaders) Object.assign(headers, customHeaders);

  // @ai-sdk/anthropic appends `/messages` directly to baseURL — no `/v1`
  // segment is added. Real api.anthropic.com endpoints include `/v1`, so
  // auto-append it when the caller supplied a bare host — and NEVER fall
  // back to the SDK default: depending on which peer-variant copy of
  // @ai-sdk/anthropic pnpm loads, the default resolves to
  // https://api.anthropic.com (no /v1) and every request 404s with an
  // empty body. Pin the correct URL explicitly. Empty-string baseURL
  // (model cards store '' for "unset") counts as absent.
  const normalizedBaseURL = baseURL
    ? /\/v\d+(\/)?$/.test(baseURL)
      ? baseURL.replace(/\/$/, "")
      : `${baseURL.replace(/\/$/, "")}/v1`
    : "https://api.anthropic.com/v1";

  const anthropic = createAnthropic({
    apiKey,
    baseURL: normalizedBaseURL,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    // setMaxTokensFetch composes observingFetch internally for non-Claude;
    // Claude path uses observingFetch directly so 429/rate-limit logging
    // applies regardless of which provider/model we're talking to.
    fetch: isKnownClaude ? observingFetch : setMaxTokensFetch,
  });

  return anthropic(modelId);
}

// ─── OpenAI tool-name length cap ─────────────────────────────────────────
//
// OpenAI's chat/completions API rejects function names longer than 64
// characters — both in the `tools` array AND inside replayed history
// (`messages[n].tool_calls[n].function.name`), with a hard 400. MCP tool
// names routinely blow past that (Composio:
// mcp__composio_gmail_googlecalendar_notion__COMPOSIO_MULTI_EXECUTE_TOOL
// is 70 chars), which killed every gpt-* turn that touched such a tool.
// Anthropic has no such limit, so this only applies on the OpenAI path.
//
// The mangle is a pure function of the name (prefix + fnv1a suffix), so
// it is stable across turns: a mangled name logged into the event log
// re-mangles to itself on history replay (already ≤64 → identity).

export const OPENAI_MAX_TOOL_NAME = 64;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministically shorten a tool name to ≤64 chars (identity when it
 *  already fits). Collisions between distinct long names are avoided by
 *  the 7-char base36 fnv1a suffix. */
export function openAiSafeToolName(name: string): string {
  if (name.length <= OPENAI_MAX_TOOL_NAME) return name;
  const suffix = fnv1a(name).toString(36).padStart(7, "0").slice(0, 7);
  return `${name.slice(0, OPENAI_MAX_TOOL_NAME - 8)}_${suffix}`;
}

// ─── OpenAI reasoning-model + tools guard ────────────────────────────────
//
// OpenAI reasoning models (gpt-5*, o-series) reject the DEFAULT
// reasoning_effort on /v1/chat/completions the moment function tools are
// attached:
//   "Function tools with reasoning_effort are not supported for
//    gpt-5.6-sol in /v1/chat/completions. To use function tools, use
//    /v1/responses or set reasoning_effort to 'none'." [400]
// We deliberately stay on chat/completions (gateway + ZDR compat — see
// resolveModel), so the fix is to force reasoning_effort:'none' for these
// models whenever the turn carries tools (agent turns always do). Scoped by
// model-id pattern so non-reasoning models (gpt-4o) and third-party gateways
// serving non-gpt-5/o models are left untouched.
const OPENAI_REASONING_MODEL_RE = /^(o[1-9]|gpt-5)/i;

export function openAiReasoningProviderOptions(
  model: LanguageModel,
  modelId: string,
  hasTools: boolean,
): { openai: { reasoningEffort: "none" } } | undefined {
  if (!hasTools || !isOpenAiCompatModel(model)) return undefined;
  const bare = modelId.includes("/") ? modelId.split("/").slice(1).join("/") : modelId;
  if (!OPENAI_REASONING_MODEL_RE.test(bare)) return undefined;
  return { openai: { reasoningEffort: "none" } };
}

/** True when the resolved LanguageModel talks to an OpenAI-compat API
 *  (createOpenAI providers report provider ids like "openai.chat"). */
export function isOpenAiCompatModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.startsWith("openai");
}

/**
 * Sanitize tool names for the OpenAI path: re-keys the tools dict and
 * rewrites tool-call / tool-result parts in history messages with the
 * same deterministic mangle. Fast no-op (returns the originals) when
 * every name already fits. The AI SDK keys returned tool calls by the
 * dict key, so execution routes to the right tool without a reverse map;
 * events log the mangled name, which re-mangles to itself next turn.
 */
export function sanitizeOpenAiToolNames<M extends { role?: string; content?: unknown }>(input: {
  tools?: Record<string, unknown>;
  messages?: M[];
}): { tools?: Record<string, unknown>; messages?: M[] } {
  const toolKeys = Object.keys(input.tools ?? {});
  const messagesHaveLongNames = (input.messages ?? []).some(
    (m) =>
      Array.isArray(m.content) &&
      m.content.some(
        (p: { type?: string; toolName?: string }) =>
          (p?.type === "tool-call" || p?.type === "tool-result") &&
          typeof p.toolName === "string" &&
          p.toolName.length > OPENAI_MAX_TOOL_NAME,
      ),
  );
  const toolsHaveLongNames = toolKeys.some((k) => k.length > OPENAI_MAX_TOOL_NAME);
  if (!toolsHaveLongNames && !messagesHaveLongNames) return input;

  const tools = input.tools
    ? Object.fromEntries(
        Object.entries(input.tools).map(([k, v]) => [openAiSafeToolName(k), v]),
      )
    : undefined;

  const messages = input.messages?.map((m) => {
    if (!Array.isArray(m.content)) return m;
    let changed = false;
    const content = m.content.map((p: { type?: string; toolName?: string }) => {
      if (
        (p?.type === "tool-call" || p?.type === "tool-result") &&
        typeof p.toolName === "string" &&
        p.toolName.length > OPENAI_MAX_TOOL_NAME
      ) {
        changed = true;
        return { ...p, toolName: openAiSafeToolName(p.toolName) };
      }
      return p;
    });
    return changed ? { ...m, content } : m;
  });

  return { tools, messages };
}
