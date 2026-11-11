import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import {
  claudeReasoning,
  isOpenAiReasoningModel,
  openAiReasoningEffort,
  type ReasoningLevel,
} from "@open-managed-agents/api-types";
import { OPENAI_MAX_TOOL_NAME, openAiSafeToolName } from "@open-managed-agents/shared";

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

/** Rewrites output_config.effort "high" → "xhigh" on the wire (see the
 *  createAnthropic call in resolveModel for why). */
async function xhighEffortFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (init?.body && typeof init.body === "string") {
    try {
      const body = JSON.parse(init.body);
      if (body?.output_config?.effort === "high") {
        body.output_config.effort = "xhigh";
        return observingFetch(url, { ...init, body: JSON.stringify(body) });
      }
    } catch {
      // not JSON — pass through
    }
  }
  return observingFetch(url, init);
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
  reasoningLevel?: ReasoningLevel,
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
    // Default to the chat/completions endpoint, not the Responses API.
    // Reasons:
    //   - Third-party OpenAI-compat gateways (CF AI Gateway, Groq, DeepSeek,
    //     xAI Grok, etc.) only support /v1/chat/completions
    //   - chat/completions is the de-facto standard contract for OpenAI-compat
    //
    // The exception: every OFFICIAL OpenAI reasoning model (o-series and
    // gpt-N for N >= 5 — see isOpenAiReasoningModel) rides /v1/responses.
    // chat/completions hard-400s on any reasoning_effort above 'none' once
    // function tools are attached ("Function tools with reasoning_effort
    // are not supported for gpt-6.1-sol in /v1/chat/completions"), and
    // some models (gpt-6-astra) don't accept 'none' at all. Gateways stay
    // on chat (they don't serve /v1/responses). The ZDR failure mode
    // ("Item with id 'fc_...' not found") is handled by the fallback
    // wrapper: it clamps to chat + reasoning_effort:'none' and retries, so
    // the turn never dies — reasoningProviderOptions also sends
    // store:false, which avoids server-side item references in the first
    // place.
    if (effectiveCompat === "oai" && isOpenAiReasoningModel(modelId)) {
      return withZdrChatFallback(
        openai.responses(modelId),
        openai.chat(modelId),
        `${fnv1a(apiKey).toString(36)}:${modelId}`,
      );
    }
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

  // @ai-sdk/anthropic's `effort` enum predates "xhigh" (low|medium|high|
  // max). reasoningProviderOptions sends "high" for an xhigh turn; this
  // fetch upgrades the wire value for models that accept xhigh (4.7+).
  const xhighEffort =
    isKnownClaude &&
    reasoningLevel !== undefined &&
    (() => {
      const r = claudeReasoning(modelId, reasoningLevel);
      return r?.mode === "adaptive" && r.effort === "xhigh";
    })();

  const anthropic = createAnthropic({
    apiKey,
    baseURL: normalizedBaseURL,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    // setMaxTokensFetch composes observingFetch internally for non-Claude;
    // Claude path uses observingFetch directly so 429/rate-limit logging
    // applies regardless of which provider/model we're talking to.
    fetch: isKnownClaude
      ? xhighEffort
        ? xhighEffortFetch
        : observingFetch
      : setMaxTokensFetch,
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

// openAiSafeToolName lives in @open-managed-agents/shared so the approval
// path (session-runtime) can map a shortened name back to its tool.
export { OPENAI_MAX_TOOL_NAME, openAiSafeToolName };

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}


// ─── Unified reasoning-level → provider knobs ────────────────────────────
//
// The level → knob tables live in @open-managed-agents/api-types
// (reasoning.ts) so every harness, route and the console agree. This
// function only adapts them to AI SDK providerOptions for the resolved
// model:
//
//   - Official OpenAI reasoning model on the Responses API →
//     { reasoningEffort, forceReasoning, store:false }. forceReasoning
//     because the installed SDK's capability table only knows gpt-5/o*
//     (it would drop the effort for gpt-6*/gpt-7); store:false so history
//     replays as full items + encrypted reasoning (ZDR-safe).
//   - Anything still on chat/completions (gateways, the ZDR clamp) that
//     is a reasoning model → the shipped floor: reasoning_effort 'none'
//     whenever tools ride along (the only effort chat accepts with tools).
//   - Known Claude → adaptive thinking + effort (4.6+) or legacy
//     enabled + budgetTokens (≤4.5). xhigh is sent as "high" and
//     upgraded on the wire by resolveModel's fetch (SDK enum lacks it).
//   - Third-party ant-compatible / non-reasoning models → undefined.
//
// `level` unset = "medium" (DEFAULT_REASONING_LEVEL).
//
// `cache.promptCacheKey` (OpenAI Responses only): OpenAI routes requests to
// prompt-cache machines by a hash of the prefix plus this key; the harness
// passes the agent id so every session of one agent (same tools + system
// prefix) lands on the same cache. Only on the Responses path — that model
// is official OpenAI by construction (resolveModel), while chat/completions
// also fronts third-party gateways that may reject unknown fields. The ZDR
// clamp keeps it (clampCallOptions spreads providerOptions.openai) and it is
// still official OpenAI there. promptCacheRetention is deliberately unset:
// the extended ("24h") retention is only documented for specific models.

export function reasoningProviderOptions(
  model: LanguageModel,
  modelId: string,
  level: ReasoningLevel | undefined,
  hasTools: boolean,
  cache?: { promptCacheKey?: string },
):
  | {
      openai: {
        reasoningEffort: "none" | "low" | "medium" | "high" | "xhigh";
        forceReasoning?: boolean;
        store?: boolean;
        promptCacheKey?: string;
      };
    }
  | { anthropic: { thinking: { type: "enabled"; budgetTokens: number } } }
  | { anthropic: { thinking: { type: "adaptive" }; effort: "low" | "medium" | "high" | "max" } }
  | undefined {
  // Prefer the resolved model's wire-level id — the `modelId` arg is the
  // agent's model-card HANDLE, which usually matches the wire model but
  // isn't required to.
  const wireId =
    typeof model !== "string" && typeof model.modelId === "string"
      ? model.modelId
      : modelId;
  const bare = wireId.includes("/") ? wireId.split("/").slice(1).join("/") : wireId;

  if (isOpenAiCompatModel(model)) {
    if (!isOpenAiReasoningModel(bare)) return undefined;
    if (isOpenAiResponsesModel(model)) {
      return {
        openai: {
          reasoningEffort: openAiReasoningEffort(bare, level),
          forceReasoning: true,
          store: false,
          // Defensive length cap; agent ids are far shorter.
          ...(cache?.promptCacheKey ? { promptCacheKey: cache.promptCacheKey.slice(0, 64) } : {}),
        },
      };
    }
    // Still on chat/completions (gateway or ZDR clamp) → the shipped
    // floor: force 'none' whenever tools are present.
    return hasTools ? { openai: { reasoningEffort: "none" } } : undefined;
  }

  if (isAnthropicModel(model) && bare.startsWith(KNOWN_CLAUDE_PREFIX)) {
    const r = claudeReasoning(bare, level);
    if (!r || r.mode === "off") return undefined;
    if (r.mode === "adaptive") {
      return {
        anthropic: {
          thinking: { type: "adaptive" },
          effort: r.effort === "xhigh" ? "high" : r.effort,
        },
      };
    }
    return {
      anthropic: { thinking: { type: "enabled", budgetTokens: r.budgetTokens } },
    };
  }

  return undefined;
}

/** True when the resolved LanguageModel talks to an OpenAI-compat API
 *  (createOpenAI providers report provider ids like "openai.chat"). */
export function isOpenAiCompatModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.startsWith("openai");
}

/** True when the resolved model rides the OpenAI Responses API
 *  ("openai.responses" — see resolveModel's reasoning-level fork). The
 *  ZDR fallback wrapper reports "openai.chat" once clamped, so this
 *  flips false mid-session exactly when the effort floor must return. */
export function isOpenAiResponsesModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  const provider = (model as { provider?: unknown }).provider;
  return (
    typeof provider === "string" &&
    provider.startsWith("openai") &&
    provider.endsWith(".responses")
  );
}

/** True when the resolved LanguageModel talks to an Anthropic-compat API
 *  (createAnthropic providers report "anthropic.messages"). */
export function isAnthropicModel(model: LanguageModel): boolean {
  if (typeof model === "string") return false;
  const provider = (model as { provider?: unknown }).provider;
  return typeof provider === "string" && provider.startsWith("anthropic");
}

// ─── ZDR chat-fallback wrapper (Responses API → chat/completions) ───────
//
// Orgs with Zero Data Retention can't use the Responses API's server-side
// item persistence: replaying history that references function-call items
// 400s with "Item with id 'fc_...' not found". We can't detect ZDR up
// front, so the responses-endpoint model is wrapped: on that specific
// error it clamps to chat/completions + reasoning_effort:'none' (the only
// effort chat accepts with tools) and retries the call in place — the
// turn never dies. The clamp is remembered per (api key, model) for the
// isolate's lifetime so subsequent turns skip the doomed responses call.

const ZDR_ITEM_NOT_FOUND_RE = /item with id 'fc_[^']*' not found/i;
const zdrClampedKeys = new Set<string>();

function isZdrItemNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { message?: unknown; responseBody?: unknown };
  const text = `${typeof e.message === "string" ? e.message : ""} ${
    typeof e.responseBody === "string" ? e.responseBody : ""
  }`;
  return ZDR_ITEM_NOT_FOUND_RE.test(text);
}

// Concrete V3 model type as returned by createOpenAI — the `LanguageModel`
// union from "ai" also admits V2 models, whose call-options don't unify.
type OpenAiLanguageModel = ReturnType<ReturnType<typeof createOpenAI>["chat"]>;
type LanguageModelCallOptions = Parameters<OpenAiLanguageModel["doGenerate"]>[0];

/** Rewrite call options for the chat retry: chat/completions with tools
 *  only accepts reasoning_effort:'none'. */
function clampCallOptions(options: LanguageModelCallOptions): LanguageModelCallOptions {
  return {
    ...options,
    providerOptions: {
      ...options.providerOptions,
      openai: {
        ...(options.providerOptions?.openai ?? {}),
        reasoningEffort: "none",
      },
    },
  };
}

function withZdrChatFallback(
  responses: OpenAiLanguageModel,
  chat: OpenAiLanguageModel,
  clampKey: string,
): OpenAiLanguageModel {
  let clamped = zdrClampedKeys.has(clampKey);

  const trip = (err: unknown): void => {
    if (!isZdrItemNotFoundError(err)) throw err;
    clamped = true;
    zdrClampedKeys.add(clampKey);
    console.warn(
      `[provider.zdr] ${responses.modelId}: Responses API rejected function-call item replay (ZDR org?) — clamping to chat/completions + reasoning_effort:'none'`,
    );
  };

  return {
    specificationVersion: responses.specificationVersion,
    get provider() {
      return (clamped ? chat : responses).provider;
    },
    get modelId() {
      return responses.modelId;
    },
    get supportedUrls() {
      return (clamped ? chat : responses).supportedUrls;
    },
    async doGenerate(options: LanguageModelCallOptions) {
      if (clamped) return chat.doGenerate(clampCallOptions(options));
      try {
        return await responses.doGenerate(options);
      } catch (err) {
        trip(err);
        return chat.doGenerate(clampCallOptions(options));
      }
    },
    async doStream(options: LanguageModelCallOptions) {
      if (clamped) return chat.doStream(clampCallOptions(options));
      try {
        return await responses.doStream(options);
      } catch (err) {
        trip(err);
        return chat.doStream(clampCallOptions(options));
      }
    },
  } as OpenAiLanguageModel;
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
