// Per-call usage observer for the default loop (docs/budgets.md).
//
// The AI SDK only reports a step's usage at `finish-step`, which it holds
// back until the step's tools have settled. A turn aborted (wall-clock
// budget, user.interrupt) or a process killed while a tool runs would then
// lose a provider call that already completed and was billed.
//
// This middleware sits on the provider stream instead. The provider's
// `finish` part (with usage) arrives as soon as the response is complete,
// independent of tool execution: the SDK's tool runner reads the provider
// stream eagerly. `onFinish` runs there and is awaited, so the harness can
// make the call's usage durable before anything downstream of the finish
// happens, including the step's final reply.
//
// It also applies the token-budget output cap (`maxOutputTokens`) to every
// provider call, per step.

import type { LanguageModelMiddleware } from "ai";
import type { ModelCallUsage } from "@open-managed-agents/session-runtime";

export interface CallUsageInfo {
  /** Undefined when the provider reported none. */
  usage: ModelCallUsage | undefined;
  finishReason?: string;
  providerResponseId?: string;
  /** Characters of text the call produced (span.model_request_end.final_text_length). */
  finalTextLength: number;
}

export interface UsageObserverOptions {
  /** The span id of the call being made (minted in experimental_onStepStart). */
  spanIdResolver: () => string | null;
  /** The provider response completed. Awaited before the finish part flows on. */
  onFinish: (spanId: string, info: CallUsageInfo) => Promise<void>;
  /** The provider stream ended. `err` is set when it errored or was cancelled
   *  (no finish part will follow). Called after onFinish when there was one. */
  onEnd?: (spanId: string, err?: unknown) => void;
  /** Output-token allowance under the token budgets (null: no cap). */
  outputTokenRoom?: () => number | null;
  /** The provider clamps an over-large maxOutputTokens to the model's limit
   *  (e.g. @ai-sdk/anthropic for known models), so an uncapped call can be
   *  given the full allowance. */
  providerClampsMaxOutput?: boolean;
}

/**
 * Below this, an allowance is applied even when the call had no explicit
 * maxOutputTokens and the provider doesn't clamp: every current chat model
 * accepts at least this many output tokens.
 */
export const SAFE_UNCLAMPED_OUTPUT_CAP = 4096;

/**
 * The maxOutputTokens to send: min(configured, room). With no configured
 * value, the room is only applied when the provider clamps it to the model
 * limit or when it is small enough for any model; otherwise the provider
 * default is kept (an over-large value could be rejected).
 */
export function capMaxOutputTokens(
  configured: number | undefined,
  room: number | null | undefined,
  opts: { providerClamps?: boolean } = {},
): number | undefined {
  if (typeof room !== "number" || !Number.isFinite(room)) return configured;
  const r = Math.max(1, Math.floor(room));
  if (typeof configured === "number") return Math.min(configured, r);
  if (opts.providerClamps || r <= SAFE_UNCLAMPED_OUTPUT_CAP) return r;
  return undefined;
}

type V3Usage = {
  inputTokens?: { total?: number; cacheRead?: number; cacheWrite?: number } | number;
  outputTokens?: { total?: number } | number;
};

/** Provider (V3) usage → span.model_request_end.model_usage (input incl. cache). */
export function modelUsageFromV3(u: V3Usage | undefined): ModelCallUsage | undefined {
  if (!u) return undefined;
  const input = typeof u.inputTokens === "number" ? { total: u.inputTokens } : u.inputTokens ?? {};
  const output = typeof u.outputTokens === "number" ? { total: u.outputTokens } : u.outputTokens ?? {};
  return {
    input_tokens: input.total ?? 0,
    output_tokens: output.total ?? 0,
    cache_read_input_tokens: (input as { cacheRead?: number }).cacheRead ?? 0,
    cache_creation_input_tokens: (input as { cacheWrite?: number }).cacheWrite ?? 0,
  };
}

/** Only V3 models can be wrapped (wrapLanguageModel declares V3). */
export function isWrappableModel(model: unknown): boolean {
  return (
    typeof model === "object" &&
    model !== null &&
    (model as { specificationVersion?: unknown }).specificationVersion === "v3" &&
    typeof (model as { doStream?: unknown }).doStream === "function"
  );
}

export function usageObserverMiddleware(opts: UsageObserverOptions): LanguageModelMiddleware {
  return {
    specificationVersion: "v3",
    transformParams: async ({ params, type }) => {
      if (type !== "stream" || !opts.outputTokenRoom) return params;
      const next = capMaxOutputTokens(params.maxOutputTokens, opts.outputTokenRoom(), {
        providerClamps: opts.providerClampsMaxOutput,
      });
      return next === params.maxOutputTokens ? params : { ...params, maxOutputTokens: next };
    },
    wrapStream: async ({ doStream }) => {
      const spanId = opts.spanIdResolver();
      const { stream, ...rest } = await doStream();
      if (!spanId) return { stream, ...rest };
      const reader = stream.getReader();
      let textLength = 0;
      let responseId: string | undefined;
      let ended = false;
      const end = (err?: unknown) => {
        if (ended) return;
        ended = true;
        opts.onEnd?.(spanId, err);
      };
      const observed = new ReadableStream<(typeof stream extends ReadableStream<infer P> ? P : never)>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              end();
              controller.close();
              return;
            }
            const part = value as { type: string; [k: string]: unknown };
            if (part.type === "text-delta") {
              textLength += String(part.delta ?? "").length;
            } else if (part.type === "response-metadata" && typeof part.id === "string") {
              responseId = part.id;
            } else if (part.type === "finish") {
              const reason = part.finishReason as { unified?: string } | string | undefined;
              await opts.onFinish(spanId, {
                usage: modelUsageFromV3(part.usage as V3Usage | undefined),
                finishReason: typeof reason === "string" ? reason : reason?.unified,
                providerResponseId: responseId,
                finalTextLength: textLength,
              });
            }
            controller.enqueue(value);
          } catch (err) {
            end(err);
            controller.error(err);
          }
        },
        async cancel(reason) {
          end(reason ?? new Error("provider stream cancelled"));
          await reader.cancel(reason);
        },
      });
      return { stream: observed, ...rest };
    },
  };
}
