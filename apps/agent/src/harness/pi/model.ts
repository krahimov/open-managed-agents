/**
 * OMA model config → pi-ai Model + stream function.
 *
 * OMA resolves a model card to (model id, api key, base url, api compat,
 * custom headers). The Vercel AI SDK path turns that into a LanguageModel
 * (provider.ts resolveModel); this module does the same for pi-ai: build a
 * `Model<Api>` object (borrowing context window / max tokens / reasoning
 * capability / compat flags from pi-ai's generated catalog when the id is
 * known) and pick the matching pi-ai API implementation module.
 *
 * API mapping mirrors resolveModel so behavior matches across harnesses:
 *   ant / ant-compatible → "anthropic-messages"
 *   oai-compatible       → "openai-completions" (gateways only speak chat)
 *   oai                  → "openai-completions", or "openai-responses" when
 *                          a reasoning level above instant is requested on
 *                          an OpenAI reasoning model (chat/completions 400s
 *                          on reasoning_effort + function tools).
 */

import type { LanguageModel } from "ai";
import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@earendil-works/pi-ai";
import { clampThinkingLevel, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { streamSimple as anthropicStreamSimple } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as openaiCompletionsStreamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as openaiResponsesStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { ReasoningLevel } from "@open-managed-agents/shared";
import type { ApiCompat } from "../provider";

/** Raw model credentials, same shape main-node's resolveNodeModelCredentials returns. */
export interface PiModelCredentials {
  model: string | { id: string; speed?: "standard" | "fast" };
  apiKey: string;
  baseURL?: string;
  apiCompat: ApiCompat;
  customHeaders?: Record<string, string>;
}

export interface ResolvedPiModel {
  model: Model<Api>;
  /** Stream function handed to pi-agent-core's loop. */
  streamFn: StreamFn;
  apiKey: string;
  /** Pi thinking level for this turn (undefined = reasoning off). */
  reasoning?: ThinkingLevel;
  /** Extra request-body params (OpenAI-compatible adapters only). */
  samplingParams?: Record<string, unknown>;
  /** True when the wire API caps function names at 64 chars. */
  openAiToolNames: boolean;
}

const OPENAI_REASONING_MODEL_RE = /^(o[1-9]|gpt-5)/i;
/** Same cap provider.ts applies to non-Claude models on the Anthropic path. */
const DEFAULT_MAX_TOKENS = 32_768;
const DEFAULT_CONTEXT_WINDOW = 200_000;

// Catalog lookups are cheap (static JSON) — build once per process.
let catalog: Map<string, Model<Api>> | null = null;
function catalogModel(id: string): Model<Api> | undefined {
  if (!catalog) {
    catalog = new Map();
    for (const p of [anthropicProvider(), openaiProvider()]) {
      for (const m of p.getModels()) catalog.set(m.id, m as Model<Api>);
    }
  }
  return catalog.get(id);
}

function bareModelId(model: PiModelCredentials["model"]): string {
  const s = typeof model === "string" ? model : model.id;
  const raw = s.includes("/") ? s.split("/").slice(1).join("/") : s;
  // claude-sonnet-4.6 → claude-sonnet-4-6 (same normalization as provider.ts)
  return raw.replace(/^claude-(opus|sonnet|haiku)-(\d+)\.(\d+)$/, "claude-$1-$2-$3");
}

/**
 * Anthropic SDK appends `/v1/messages` itself, so pi-ai expects the bare
 * host. OMA model cards may carry `https://host/v1` (what @ai-sdk/anthropic
 * needs) — strip the version segment.
 */
function anthropicBaseUrl(baseURL?: string): string {
  if (!baseURL) return "https://api.anthropic.com";
  return baseURL.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** OpenAI SDK appends `/chat/completions` to baseURL, which includes `/v1`. */
function openaiBaseUrl(baseURL?: string): string {
  if (!baseURL) return "https://api.openai.com/v1";
  return baseURL.replace(/\/+$/, "");
}

/** OMA reasoning_level → pi ThinkingLevel (before per-model clamping). */
function reasoningToThinking(level: ReasoningLevel | undefined): ThinkingLevel | undefined {
  switch (level) {
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "max":
      return "max";
    default:
      return undefined; // "instant" / unset → no reasoning
  }
}

/**
 * StreamFn must never throw (pi-agent-core contract: failures are encoded as
 * a final assistant message with stopReason "error"). pi-ai's direct API
 * entry points throw synchronously when auth is missing, so convert any
 * synchronous throw into a one-event error stream.
 */
function safeStream(
  impl: (model: Model<Api>, context: Parameters<StreamFn>[1], options?: SimpleStreamOptions) => AssistantMessageEventStream,
): StreamFn {
  return (model, context, options) => {
    try {
      return impl(model, context, options);
    } catch (err) {
      return errorStream(model, err instanceof Error ? err.message : String(err));
    }
  };
}

export function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const error: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "error",
    errorMessage: message,
    timestamp: Date.now(),
  };
  queueMicrotask(() => {
    stream.push({ type: "error", reason: "error", error });
    stream.end(error);
  });
  return stream;
}

export function resolvePiModel(
  creds: PiModelCredentials,
  opts: { reasoningLevel?: ReasoningLevel; hasTools?: boolean } = {},
): ResolvedPiModel {
  const id = bareModelId(creds.model);
  const known = catalogModel(id);
  const requested = reasoningToThinking(opts.reasoningLevel);

  if (creds.apiCompat === "ant" || creds.apiCompat === "ant-compatible") {
    const official = creds.apiCompat === "ant";
    const base: Model<"anthropic-messages"> = {
      id,
      name: known?.name ?? id,
      api: "anthropic-messages",
      // Keep "anthropic" for the official API so catalog compat detection and
      // cross-turn thinking-signature replay (isSameModel) behave normally.
      provider: official ? "anthropic" : "anthropic-compatible",
      baseUrl: anthropicBaseUrl(creds.baseURL),
      reasoning: known?.reasoning ?? false,
      input: known?.input ?? ["text", "image"],
      cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
      ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
      ...(known?.api === "anthropic-messages" && known.compat ? { compat: known.compat as Model<"anthropic-messages">["compat"] } : {}),
      ...(creds.customHeaders ? { headers: creds.customHeaders } : {}),
    };
    // Mirror provider.ts: third-party Anthropic-compatible endpoints don't
    // take the thinking parameter; only known Claude models get reasoning.
    const reasoning = requested && id.startsWith("claude-") && base.reasoning
      ? clampToOn(base, requested)
      : undefined;
    return {
      model: base as Model<Api>,
      streamFn: safeStream(anthropicStreamSimple as never),
      apiKey: creds.apiKey,
      reasoning,
      openAiToolNames: false,
    };
  }

  // OpenAI / OpenAI-compatible.
  const useResponses =
    creds.apiCompat === "oai" &&
    requested !== undefined &&
    OPENAI_REASONING_MODEL_RE.test(id);
  const api = useResponses ? "openai-responses" : "openai-completions";
  const model: Model<Api> = {
    id,
    name: known?.name ?? id,
    api,
    provider: creds.apiCompat === "oai" ? "openai" : "openai-compatible",
    baseUrl: openaiBaseUrl(creds.baseURL),
    reasoning: known?.reasoning ?? OPENAI_REASONING_MODEL_RE.test(id),
    input: known?.input ?? ["text", "image"],
    cost: known?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: known?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: known?.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(known?.thinkingLevelMap ? { thinkingLevelMap: known.thinkingLevelMap } : {}),
    // Responses compat flags from the catalog only apply to the Responses API.
    ...(useResponses && known?.api === "openai-responses" && known.compat ? { compat: known.compat } : {}),
    ...(creds.customHeaders ? { headers: creds.customHeaders } : {}),
  };
  // Shipped floor from provider.ts: OpenAI reasoning models on
  // chat/completions 400 when function tools are present unless
  // reasoning_effort is 'none'. pi-ai's simple options can't express
  // 'none', so send it as a raw body param.
  const samplingParams =
    !useResponses && OPENAI_REASONING_MODEL_RE.test(id) && opts.hasTools
      ? { reasoning_effort: "none" }
      : undefined;
  return {
    model,
    streamFn: safeStream((useResponses ? openaiResponsesStreamSimple : openaiCompletionsStreamSimple) as never),
    apiKey: creds.apiKey,
    reasoning: useResponses && requested ? clampToOn(model, requested) : undefined,
    samplingParams,
    openAiToolNames: true,
  };
}

function clampToOn(model: Model<Api>, level: ThinkingLevel): ThinkingLevel | undefined {
  const clamped = clampThinkingLevel(model, level);
  return clamped === "off" ? undefined : clamped;
}

/**
 * Best-effort credential recovery from an AI SDK LanguageModel built by
 * provider.ts resolveModel. Used when the runtime hands the harness only
 * `ctx.model` (CF SessionDO today). Reads @ai-sdk provider internals
 * (`provider`, `modelId`, `config.baseURL|url`, `config.headers()`), so it
 * is deliberately defensive: returns null on any unexpected shape.
 */
export async function credentialsFromLanguageModel(model: LanguageModel): Promise<PiModelCredentials | null> {
  if (!model || typeof model === "string") return null;
  const m = model as unknown as {
    provider?: string;
    modelId?: string;
    config?: {
      baseURL?: string;
      url?: (o: { path: string; modelId: string }) => string;
      headers?: () => Record<string, string | undefined> | Promise<Record<string, string | undefined>>;
    };
  };
  if (typeof m.provider !== "string" || typeof m.modelId !== "string" || !m.config?.headers) return null;
  let headers: Record<string, string | undefined>;
  try {
    headers = await m.config.headers();
  } catch {
    return null;
  }
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) if (typeof v === "string") lower[k.toLowerCase()] = v;
  const passthrough = (drop: string[]): Record<string, string> | undefined => {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(lower)) {
      if (!drop.includes(k)) out[k] = v;
    }
    return Object.keys(out).length ? out : undefined;
  };

  if (m.provider.startsWith("anthropic")) {
    const apiKey = lower["x-api-key"] ?? lower["authorization"]?.replace(/^Bearer\s+/i, "");
    if (!apiKey) return null;
    const baseURL = m.config.baseURL;
    return {
      model: m.modelId,
      apiKey,
      baseURL,
      apiCompat: baseURL && !/api\.anthropic\.com/.test(baseURL) ? "ant-compatible" : "ant",
      customHeaders: passthrough(["x-api-key", "authorization", "anthropic-version", "user-agent", "x-sub-module"]),
    };
  }
  if (m.provider.startsWith("openai")) {
    const apiKey = lower["authorization"]?.replace(/^Bearer\s+/i, "");
    if (!apiKey) return null;
    let baseURL: string | undefined;
    try {
      baseURL = m.config.url?.({ path: "", modelId: m.modelId })?.replace(/\/+$/, "");
    } catch {
      baseURL = undefined;
    }
    return {
      model: m.modelId,
      apiKey,
      baseURL,
      apiCompat: baseURL && !/api\.openai\.com/.test(baseURL) ? "oai-compatible" : "oai",
      customHeaders: passthrough(["authorization", "user-agent", "openai-organization", "openai-project"]),
    };
  }
  return null;
}
