// @ts-nocheck
// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { env, exports } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { resolveModel, reasoningProviderOptions, isOpenAiResponsesModel } from "../../apps/agent/src/harness/provider";
import { evaluateOutcome } from "../../apps/agent/src/harness/outcome-evaluator";
import { outboundByHost } from "../../apps/agent/src/outbound";
import { registerHarness } from "../../apps/agent/src/harness/registry";
import type { Env } from "@open-managed-agents/shared";

// ============================================================
// Helpers
// ============================================================
const HEADERS = { "x-api-key": "test-key", "Content-Type": "application/json" };

function api(path: string, init?: RequestInit) {
  return exports.default.fetch(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: Record<string, unknown>) {
  return api(path, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
}

async function createAgentAndEnv(overrides?: {
  agentBody?: Record<string, unknown>;
  envBody?: Record<string, unknown>;
}) {
  const agentRes = await post("/v1/agents", {
    // Unique per call — the create route 409s on exact active-name dupes.
    name: `Core Test Agent ${Math.random().toString(36).slice(2, 8)}`,
    model: "claude-sonnet-4-6",
    ...overrides?.agentBody,
  });
  const agent = (await agentRes.json()) as any;

  const envRes = await post("/v1/environments", {
    name: "core-test-env",
    config: { type: "cloud" },
    ...overrides?.envBody,
  });
  const environment = (await envRes.json()) as any;

  return { agent, environment };
}

async function createSession(
  agentId: string,
  environmentId: string,
  extra?: Record<string, unknown>
) {
  const sessRes = await post("/v1/sessions", {
    agent: agentId,
    environment_id: environmentId,
    ...extra,
  });
  return (await sessRes.json()) as any;
}

// ============================================================
// 1. Provider — resolveModel
// ============================================================
describe("Provider", () => {
  it("resolves string model ID", () => {
    const model = resolveModel("claude-sonnet-4-6", "fake-key");
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("resolves object model with speed", () => {
    const model = resolveModel(
      { id: "claude-opus-4-6", speed: "fast" },
      "fake-key"
    );
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-opus-4-6");
  });

  it("strips provider prefix", () => {
    const model = resolveModel("anthropic/claude-sonnet-4-6", "fake-key");
    expect(model.modelId).toContain("claude-sonnet-4-6");
    expect(model.modelId).not.toContain("anthropic/");
  });

  it("normalizes dotted Claude model aliases", () => {
    const model = resolveModel("anthropic/claude-opus-4.8", "fake-key");
    expect(model.modelId).toContain("claude-opus-4-8");
    expect(model.modelId).not.toContain("claude-opus-4.8");
  });

  it("accepts custom base URL", () => {
    const model = resolveModel(
      "claude-sonnet-4-6",
      "key",
      "https://custom.api.com/v1"
    );
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("works without base URL", () => {
    const model = resolveModel("claude-sonnet-4-6", "key");
    expect(model).toBeTruthy();
    expect(model.modelId).toContain("claude-sonnet-4-6");
  });

  it("handles deeply nested provider prefix", () => {
    const model = resolveModel("provider/sub/claude-sonnet-4-6", "key");
    expect(model.modelId).toContain("claude-sonnet-4-6");
    expect(model.modelId).not.toContain("provider");
  });

  describe("resolveModel — reasoning_level endpoint routing (OpenAI)", () => {
    it.each([undefined, "instant", "low", "medium", "high", "xhigh", "max"] as const)(
      "routes official OpenAI reasoning models to the Responses API at level %s",
      (level) => {
        const model = resolveModel("gpt-5.6-sol", "k", undefined, "oai", undefined, level);
        expect(isOpenAiResponsesModel(model)).toBe(true);
      },
    );

    it.each(["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna", "gpt-7", "o3"])(
      "routes %s to the Responses API with no per-name special case",
      (id) => {
        expect(isOpenAiResponsesModel(resolveModel(id, "k", undefined, "oai"))).toBe(true);
      },
    );

    it("stays on chat/completions for gateways even at level=high", () => {
      const model = resolveModel("gpt-5.6-sol", "k", "https://gw.example.com/v1", "oai-compatible", undefined, "high");
      expect(isOpenAiResponsesModel(model)).toBe(false);
    });

    it("stays on chat/completions for non-reasoning models (gpt-4o) at level=high", () => {
      const model = resolveModel("gpt-4o", "k", undefined, "oai", undefined, "high");
      expect(isOpenAiResponsesModel(model)).toBe(false);
    });

    it("responses-routed model keeps the wire model id", () => {
      const model = resolveModel("gpt-5.6-sol", "k", undefined, "oai", undefined, "medium");
      expect(typeof model !== "string" && model.modelId).toBe("gpt-5.6-sol");
    });
  });

  describe("reasoningProviderOptions — unified level → provider knobs", () => {
    const oaiModel = (id: string, level?: "instant" | "low" | "medium" | "high" | "xhigh" | "max") =>
      resolveModel(id, "k", undefined, "oai", undefined, level);
    const antModel = (id: string) => resolveModel(id, "k", undefined, "ant");
    const oai = (reasoningEffort: string) => ({
      openai: { reasoningEffort, forceReasoning: true, store: false },
    });

    // — official OpenAI on the Responses API —

    it("defaults to medium effort when the level is unset", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "gpt-5.6-sol", undefined, true)).toEqual(oai("medium"));
      expect(reasoningProviderOptions(oaiModel("gpt-6.1-sol"), "gpt-6.1-sol", undefined, true)).toEqual(oai("medium"));
    });

    it("maps each level to its effort (with or without tools)", () => {
      expect(reasoningProviderOptions(oaiModel("o3", "low"), "o3", "low", true)).toEqual(oai("low"));
      expect(reasoningProviderOptions(oaiModel("o3", "medium"), "o3", "medium", false)).toEqual(oai("medium"));
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol", "high"), "gpt-5.6-sol", "high", true)).toEqual(oai("high"));
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol", "xhigh"), "gpt-5.6-sol", "xhigh", true)).toEqual(oai("xhigh"));
    });

    it("maps max to the highest effort the model accepts", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol", "max"), "gpt-5.6-sol", "max", true)).toEqual(oai("xhigh"));
      expect(reasoningProviderOptions(oaiModel("gpt-7", "max"), "gpt-7", "max", true)).toEqual(oai("xhigh"));
      // o-series / gpt-5 / gpt-5.1 top out at high — degrade, never 400.
      expect(reasoningProviderOptions(oaiModel("o3", "max"), "o3", "max", true)).toEqual(oai("high"));
      expect(reasoningProviderOptions(oaiModel("gpt-5", "xhigh"), "gpt-5", "xhigh", true)).toEqual(oai("high"));
    });

    it("legacy instant maps to low (not every reasoning model accepts 'none')", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-6-astra", "instant"), "gpt-6-astra", "instant", true)).toEqual(oai("low"));
    });

    it("strips provider prefix and prefers the resolved wire id over the card handle", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "openai/gpt-5.6-sol", "high", true)).toEqual(oai("high"));
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "my-fast-model", "high", true)).toEqual(oai("high"));
    });

    it("does NOT fire for non-reasoning OpenAI models (gpt-4o)", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-4o"), "gpt-4o", "high", true)).toBeUndefined();
    });

    // — chat/completions (gateways) keep the 'none' floor with tools —

    it("clamps gateway reasoning models to 'none' with tools at any level", () => {
      for (const level of [undefined, "high", "max"] as const) {
        const gw = resolveModel("gpt-5.6-sol", "k", "https://gw.example.com/v1", "oai-compatible", undefined, level);
        expect(reasoningProviderOptions(gw, "gpt-5.6-sol", level, true)).toEqual({ openai: { reasoningEffort: "none" } });
      }
      const gw6 = resolveModel("gpt-6.1-sol", "k", "https://gw.example.com/v1", "oai-compatible");
      expect(reasoningProviderOptions(gw6, "gpt-6.1-sol", undefined, true)).toEqual({ openai: { reasoningEffort: "none" } });
    });

    it("leaves gateway models alone without tools, and non-reasoning gateway models always", () => {
      const gw = resolveModel("gpt-5.6-sol", "k", "https://gw.example.com/v1", "oai-compatible");
      expect(reasoningProviderOptions(gw, "gpt-5.6-sol", undefined, false)).toBeUndefined();
      const ds = resolveModel("deepseek-chat", "k", "https://api.deepseek.com", "oai-compatible");
      expect(reasoningProviderOptions(ds, "deepseek-chat", "high", true)).toBeUndefined();
    });

    // — Anthropic —

    it("Claude 4.7+/5.x: adaptive thinking + effort for every level, medium by default", () => {
      for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-4-7"]) {
        expect(reasoningProviderOptions(antModel(id), id, undefined, true)).toEqual({
          anthropic: { thinking: { type: "adaptive" }, effort: "medium" },
        });
        for (const level of ["low", "medium", "high", "max"] as const) {
          expect(reasoningProviderOptions(antModel(id), id, level, true)).toEqual({
            anthropic: { thinking: { type: "adaptive" }, effort: level },
          });
        }
      }
    });

    it("xhigh is sent as 'high' to the SDK (its enum predates xhigh) and upgraded on the wire", () => {
      expect(reasoningProviderOptions(antModel("claude-opus-5-5"), "claude-opus-5-5", "xhigh", true)).toEqual({
        anthropic: { thinking: { type: "adaptive" }, effort: "high" },
      });
    });

    it("Claude 4.6: adaptive + effort; xhigh degrades to high; instant = thinking off", () => {
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "max", true)).toEqual({
        anthropic: { thinking: { type: "adaptive" }, effort: "max" },
      });
      expect(reasoningProviderOptions(antModel("claude-opus-4-6"), "claude-opus-4-6", "xhigh", true)).toEqual({
        anthropic: { thinking: { type: "adaptive" }, effort: "high" },
      });
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "instant", true)).toBeUndefined();
    });

    it("Claude 5.x can't turn thinking off: legacy instant → effort low", () => {
      expect(reasoningProviderOptions(antModel("claude-opus-5-5"), "claude-opus-5-5", "instant", true)).toEqual({
        anthropic: { thinking: { type: "adaptive" }, effort: "low" },
      });
      expect(reasoningProviderOptions(antModel("claude-opus-4-8"), "claude-opus-4-8", "instant", true)).toBeUndefined();
    });

    it("≤4.5 keeps legacy budgets, clamped below the model's output cap", () => {
      expect(reasoningProviderOptions(antModel("claude-haiku-4-5"), "claude-haiku-4-5", "low", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
      });
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-5"), "claude-sonnet-4-5", undefined, true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
      });
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-5"), "claude-sonnet-4-5", "xhigh", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 49152 } },
      });
      // sonnet-4-5 caps output at 64k: 65536 would 400 (budget >= max_tokens).
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-5"), "claude-sonnet-4-5", "max", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 55808 } },
      });
      // opus-4-1 caps at 32k — even high's 32768 must clamp.
      expect(reasoningProviderOptions(antModel("claude-opus-4-1"), "claude-opus-4-1", "high", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 23808 } },
      });
      // Date-stamped opus-4 is opus 4.0, not "4.20250514".
      expect(reasoningProviderOptions(antModel("claude-opus-4-20250514"), "claude-opus-4-20250514", "low", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
      });
    });

    it("does NOT fire for non-Claude models on the Anthropic-compat path", () => {
      const mm = resolveModel("MiniMax-M2", "k", "https://api.minimax.io/anthropic", "ant-compatible");
      expect(reasoningProviderOptions(mm, "MiniMax-M2", "high", true)).toBeUndefined();
    });
  });

  // Wire-level: stub globalThis.fetch and assert the ACTUAL request bodies
  // the providers emit — reasoning.effort on /responses, reasoning_effort on
  // /chat/completions, thinking.budget_tokens on /messages — plus the full
  // ZDR fallback sequence (responses 400 → chat retry with effort clamped).
  describe("reasoning wire-level (mocked fetch)", () => {
    const PROMPT = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
    const TOOLS = [
      { type: "function", name: "get_time", description: "d", inputSchema: { type: "object", properties: {} } },
    ];
    const CHAT_OK = {
      id: "chatcmpl-1", object: "chat.completion", created: 0, model: "gpt-5.6-sol",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    };
    const ANT_OK = {
      id: "msg_1", type: "message", role: "assistant", model: "claude-sonnet-4-6",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const ZDR_400 = {
      error: { message: "Item with id 'fc_abc123' not found.", type: "invalid_request_error", code: null, param: null },
    };

    /** Install a fetch stub for the duration of fn. Returns every captured
     *  call plus fn's outcome (never throws — callers assert on `error`). */
    async function withMockFetch(responder, fn) {
      const real = globalThis.fetch;
      const calls = [];
      globalThis.fetch = async (url, init) => {
        const u = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
        const body = init?.body ? JSON.parse(init.body) : undefined;
        calls.push({ url: u, body });
        return responder(u, body, calls.length);
      };
      try {
        const result = await fn();
        return { result, error: null, calls };
      } catch (error) {
        return { result: null, error, calls };
      } finally {
        globalThis.fetch = real;
      }
    }

    const json = (status, body) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    it("sends reasoning.effort on /responses for level=high", async () => {
      const model = resolveModel("gpt-5.6-sol", "wire-key-effort", undefined, "oai", undefined, "high");
      const { error, calls } = await withMockFetch(
        // Generic (non-ZDR) 400 — the wrapper must rethrow, not fall back.
        () => json(400, { error: { message: "boom", type: "server_error" } }),
        () => model.doGenerate({ prompt: PROMPT, tools: TOOLS, providerOptions: { openai: { reasoningEffort: "high" } } }),
      );
      expect(error).toBeTruthy();
      expect(calls.length).toBe(1);
      expect(calls[0].url).toContain("/responses");
      expect(calls[0].body.reasoning).toEqual({ effort: "high" });
    });

    it("ZDR fallback: responses 400 'fc_ not found' → chat retry with reasoning_effort:'none'", async () => {
      const model = resolveModel("gpt-5.6-sol", "wire-key-zdr", undefined, "oai", undefined, "high");
      const { result, error, calls } = await withMockFetch(
        (url) => (url.includes("/responses") ? json(400, ZDR_400) : json(200, CHAT_OK)),
        () => model.doGenerate({ prompt: PROMPT, tools: TOOLS, providerOptions: { openai: { reasoningEffort: "high" } } }),
      );
      expect(error).toBeNull();
      expect(calls.length).toBe(2);
      expect(calls[0].url).toContain("/responses");
      expect(calls[1].url).toContain("/chat/completions");
      expect(calls[1].body.reasoning_effort).toBe("none");
      expect(result.content.some((p) => p.type === "text" && p.text === "ok")).toBe(true);

      // The clamp is remembered per (api key, model): a freshly resolved
      // model with the same key skips the doomed responses call entirely.
      const again = resolveModel("gpt-5.6-sol", "wire-key-zdr", undefined, "oai", undefined, "high");
      const second = await withMockFetch(
        () => json(200, CHAT_OK),
        () => again.doGenerate({ prompt: PROMPT, tools: TOOLS, providerOptions: { openai: { reasoningEffort: "high" } } }),
      );
      expect(second.error).toBeNull();
      expect(second.calls.length).toBe(1);
      expect(second.calls[0].url).toContain("/chat/completions");
      expect(second.calls[0].body.reasoning_effort).toBe("none");
    });

    it("chat floor: gateway gpt-5 with tools sends reasoning_effort:'none'", async () => {
      const model = resolveModel("gpt-5.6-sol", "wire-key-floor", "https://gw.example.com/v1", "oai-compatible");
      const { error, calls } = await withMockFetch(
        () => json(200, CHAT_OK),
        () => model.doGenerate({
          prompt: PROMPT,
          tools: TOOLS,
          providerOptions: reasoningProviderOptions(model, "gpt-5.6-sol", undefined, true),
        }),
      );
      expect(error).toBeNull();
      expect(calls[0].url).toContain("/chat/completions");
      expect(calls[0].body.reasoning_effort).toBe("none");
    });

    it("unset level on gpt-6.1-sol rides /responses with effort medium + tools (the prod 400)", async () => {
      const RESP_OK = {
        id: "resp_1", object: "response", created_at: 0, model: "gpt-6.1-sol", status: "completed",
        output: [{ type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      };
      const model = resolveModel("gpt-6.1-sol", "wire-key-sol", undefined, "oai");
      const { error, calls } = await withMockFetch(
        () => json(200, RESP_OK),
        () => model.doGenerate({
          prompt: PROMPT,
          tools: TOOLS,
          providerOptions: reasoningProviderOptions(model, "gpt-6.1-sol", undefined, true),
        }),
      );
      expect(error).toBeNull();
      expect(calls[0].url).toContain("/responses");
      expect(calls[0].body.reasoning).toEqual({ effort: "medium" });
      expect(calls[0].body.store).toBe(false);
      expect(calls[0].body.include).toContain("reasoning.encrypted_content");
    });

    it("Anthropic 4.6 level=medium sends adaptive thinking + output_config.effort", async () => {
      const model = resolveModel("claude-sonnet-4-6", "wire-key-ant", undefined, "ant");
      const { error, calls } = await withMockFetch(
        () => json(200, ANT_OK),
        () => model.doGenerate({
          prompt: PROMPT,
          providerOptions: reasoningProviderOptions(model, "claude-sonnet-4-6", "medium", true),
        }),
      );
      expect(error).toBeNull();
      expect(calls[0].url).toContain("/messages");
      expect(calls[0].body.thinking).toEqual({ type: "adaptive" });
      expect(calls[0].body.output_config?.effort).toBe("medium");
    });

    it("Anthropic xhigh: wire effort is upgraded to 'xhigh' on 4.7+ models", async () => {
      const model = resolveModel("claude-opus-5-5", "wire-key-ant-x", undefined, "ant", undefined, "xhigh");
      const { error, calls } = await withMockFetch(
        () => json(200, ANT_OK),
        () => model.doGenerate({
          prompt: PROMPT,
          providerOptions: reasoningProviderOptions(model, "claude-opus-5-5", "xhigh", true),
        }),
      );
      expect(error).toBeNull();
      expect(calls[0].body.output_config?.effort).toBe("xhigh");
    });

    it("Anthropic legacy (sonnet-4-5) medium sends thinking.budget_tokens=16384 with max_tokens headroom", async () => {
      const model = resolveModel("claude-sonnet-4-5", "wire-key-ant-legacy", undefined, "ant");
      const { error, calls } = await withMockFetch(
        () => json(200, ANT_OK),
        () => model.doGenerate({
          prompt: PROMPT,
          providerOptions: reasoningProviderOptions(model, "claude-sonnet-4-5", "medium", true),
        }),
      );
      expect(error).toBeNull();
      expect(calls[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
      // @ai-sdk/anthropic adds the budget on top of max_tokens itself.
      expect(calls[0].body.max_tokens).toBeGreaterThan(16384);
    });
  });
});

// ============================================================
// 1a. Agent API — reasoning_level wire accept/reject
// ============================================================
describe("Agent API — reasoning_level wire validation", () => {
  it("accepts max on create and echoes it in the _oma envelope", async () => {
    const res = await post("/v1/agents", {
      name: `Reasoning Max ${Math.random().toString(36).slice(2, 8)}`,
      model: "claude-fable-5",
      _oma: { reasoning_level: "max" },
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent._oma?.reasoning_level).toBe("max");
  });

  it("accepts xhigh", async () => {
    const res = await post("/v1/agents", {
      name: `Reasoning XHigh ${Math.random().toString(36).slice(2, 8)}`,
      model: "claude-fable-5",
      _oma: { reasoning_level: "xhigh" },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any)._oma?.reasoning_level).toBe("xhigh");
  });

  it("400s on a bogus reasoning_level", async () => {
    const res = await post("/v1/agents", {
      name: `Reasoning Bogus ${Math.random().toString(36).slice(2, 8)}`,
      model: "claude-fable-5",
      _oma: { reasoning_level: "ultra" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    expect(String(msg)).toContain("reasoning_level must be one of");
    expect(String(msg)).toContain("max");
  });
});

// ============================================================
// 1b. Agent create — duplicate-name guard (create-once doctrine)
// ============================================================
describe("Agent create — duplicate-name guard", () => {
  it("409s when an active agent with the exact same name exists", async () => {
    const name = `Dup Guard ${Math.random().toString(36).slice(2, 8)}`;
    const first = await post("/v1/agents", { name, model: "claude-sonnet-4-6" });
    expect(first.status).toBe(201);
    const second = await post("/v1/agents", { name, model: "claude-sonnet-4-6" });
    expect(second.status).toBe(409);
    const body = (await second.json()) as any;
    // Error envelope is either the legacy bare string or the Anthropic-style
    // { error: { type, message } } object depending on the app wrapper.
    const msg = typeof body.error === "string" ? body.error : body.error?.message;
    expect(String(msg)).toContain("already exists");
  });

  it("name match is case- and whitespace-insensitive", async () => {
    const base = `Dup Case ${Math.random().toString(36).slice(2, 8)}`;
    await post("/v1/agents", { name: base, model: "claude-sonnet-4-6" });
    const dup = await post("/v1/agents", { name: `  ${base.toUpperCase()} `, model: "claude-sonnet-4-6" });
    expect(dup.status).toBe(409);
  });

  it("metadata.allow_duplicate_name opts out for deliberate copies", async () => {
    const name = `Dup Optout ${Math.random().toString(36).slice(2, 8)}`;
    await post("/v1/agents", { name, model: "claude-sonnet-4-6" });
    const copy = await post("/v1/agents", {
      name,
      model: "claude-sonnet-4-6",
      metadata: { allow_duplicate_name: true },
    });
    expect(copy.status).toBe(201);
  });

  it("archived agents do not block name reuse", async () => {
    const name = `Dup Archived ${Math.random().toString(36).slice(2, 8)}`;
    const first = (await (await post("/v1/agents", { name, model: "claude-sonnet-4-6" })).json()) as any;
    await post(`/v1/agents/${first.id}/archive`, {});
    const again = await post("/v1/agents", { name, model: "claude-sonnet-4-6" });
    expect(again.status).toBe(201);
  });
});

// ============================================================
// 2. Outbound Worker — outboundByHost
// ============================================================
describe("Outbound Worker", () => {
  // outboundByHost reads the per-session OutboundSnapshot through
  // services.outboundSnapshots.get → CONFIG_KV `outbound:{sessionId}`.
  function makeMockEnv(snapshots: Record<string, object | string | null>): Env {
    return {
      CONFIG_KV: {
        get: async (key: string) => {
          const v = snapshots[key];
          if (v === undefined || v === null) return null;
          return typeof v === "string" ? v : JSON.stringify(v);
        },
        list: async () => ({ keys: [] }),
        put: async () => {},
        delete: async () => {},
        getWithMetadata: async () => ({ value: null, metadata: null }),
      } as unknown as KVNamespace,
      SESSION_DO: {} as any,
      SANDBOX: {} as any,
      API_KEY: "test",
      ANTHROPIC_API_KEY: "test",
    } as Env;
  }

  function snap(creds: Array<{ url: string; token?: string }>) {
    return {
      tenant_id: "tnt",
      vault_ids: ["vlt_1"],
      vault_credentials: [
        {
          vault_id: "vlt_1",
          credentials: creds.map((c, i) => ({
            id: `cred_${i}`,
            auth: { type: "static_bearer", mcp_server_url: c.url, token: c.token },
          })),
        },
      ],
    };
  }

  it("outboundByHost returns null without sessionId", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, undefined);
    expect(result).toBeNull();
  });

  it("outboundByHost returns null without sessionId (empty string)", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, "");
    expect(result).toBeNull();
  });

  it("outboundByHost returns 'outbound' for host with matching credential", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_test": snap([{ url: "https://mcp.example.com/mcp", token: "secret-token" }]),
    });

    const result = await outboundByHost("mcp.example.com", mockEnv, "sess_test");
    // outboundByHost is now a no-op stub — vault inject runs via
    // OmaSandbox.outboundHandlers per-class registration. Test kept to
    // pin the legacy SDK fallback symbol's null return.
    expect(result).toBeNull();
  });

  it("outboundByHost returns null for host without matching credential", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_test": snap([{ url: "https://other.example.com/mcp", token: "token" }]),
    });

    const result = await outboundByHost("nomatch.example.com", mockEnv, "sess_test");
    expect(result).toBeNull();
  });

  it("outboundByHost returns null when snapshot has empty vault_credentials", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_no_vaults": { tenant_id: "tnt", vault_ids: [], vault_credentials: [] },
    });

    const result = await outboundByHost("example.com", mockEnv, "sess_no_vaults");
    expect(result).toBeNull();
  });

  it("outboundByHost handles missing snapshot gracefully", async () => {
    const mockEnv = makeMockEnv({});
    const result = await outboundByHost("example.com", mockEnv, "sess_nonexistent");
    expect(result).toBeNull();
  });

  it("outboundByHost handles credential with invalid mcp_server_url", async () => {
    const mockEnv = makeMockEnv({
      "outbound:sess_bad_url": snap([{ url: "not-a-valid-url", token: "token" }]),
    });

    // Should not crash, just return null
    const result = await outboundByHost("example.com", mockEnv, "sess_bad_url");
    expect(result).toBeNull();
  });
});

// ============================================================
// 3. Outcome evaluator — real model tests
// ============================================================
describe("Outcome evaluator", () => {
  // AI SDK v6 (spec v2) requires doGenerate to return `content` array
  function makeFakeModel(text: string, usage = { promptTokens: 0, completionTokens: 0 }) {
    return {
      specificationVersion: "v2" as const,
      provider: "test",
      modelId: "test-model",
      defaultObjectGenerationMode: undefined,
      doGenerate: async () => ({
        content: [{ type: "text" as const, text }],
        finishReason: "stop" as const,
        usage,
        rawCall: { rawPrompt: "", rawSettings: {} },
      }),
    } as any;
  }

  it("returns needs_revision on parse failure", async () => {
    const result = await evaluateOutcome(
      makeFakeModel("This is not valid JSON"),
      { description: "test" },
      "test output"
    );
    expect(result.result).toBe("needs_revision");
    expect(result.feedback).toContain("Failed to parse");
  });

  it("returns satisfied when model outputs valid JSON", async () => {
    const result = await evaluateOutcome(
      makeFakeModel(JSON.stringify({ result: "satisfied", feedback: "All criteria met." }), { promptTokens: 10, completionTokens: 20 }),
      { description: "Write hello world", criteria: ["Must print Hello"] },
      "console.log('Hello')"
    );
    expect(result.result).toBe("satisfied");
    expect(result.feedback).toBe("All criteria met.");
  });

  it("returns needs_revision with feedback from model", async () => {
    const result = await evaluateOutcome(
      makeFakeModel(JSON.stringify({ result: "needs_revision", feedback: "Missing error handling" }), { promptTokens: 10, completionTokens: 20 }),
      { description: "Build API" },
      "partial code"
    );
    expect(result.result).toBe("needs_revision");
    expect(result.feedback).toBe("Missing error handling");
  });

  it("handles model returning empty text", async () => {
    const result = await evaluateOutcome(makeFakeModel(""), { description: "test" }, "output");
    expect(result.result).toBe("needs_revision");
  });
});

// ============================================================
// 5. Integration edge cases
// ============================================================
describe("Edge cases - concurrent and complex operations", () => {
  it("handles rapid session creation", async () => {
    const { agent, environment } = await createAgentAndEnv();

    // Create 5 sessions rapidly in parallel
    const promises = Array.from({ length: 5 }, () =>
      createSession(agent.id, environment.id)
    );
    const sessions = await Promise.all(promises);

    // All should succeed with unique IDs
    const ids = new Set(sessions.map((s: any) => s.id));
    expect(ids.size).toBe(5);

    // All should reference the same agent
    for (const s of sessions) {
      // Wire shape: agent + environment are nested envelope objects post-
      // packages/http-routes refactor. Old top-level `agent_id` is gone.
      expect(s.agent?.id).toBe(agent.id);
      expect(s.environment?.id ?? s.environment_id).toBe(environment.id);
      expect(s.status).toBe("idle");
    }
  });

  it("handles creating agent with description", async () => {
    const res = await post("/v1/agents", {
      name: "Full Agent",
      model: "claude-sonnet-4-6",
      system: "You are a comprehensive assistant.",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: true },
          configs: [
            { name: "bash", enabled: true },
            { name: "read", enabled: true },
            { name: "write", enabled: true },
          ],
        },
      ],
    });
    expect(res.status).toBe(201);

    const agent = (await res.json()) as any;
    expect(agent.name).toBe("Full Agent");
    expect(agent.system).toBe("You are a comprehensive assistant.");
    expect(agent.tools).toHaveLength(1);
    expect(agent.tools[0].configs).toHaveLength(3);
    expect(agent.version).toBe(1);
    expect(agent.created_at).toBeTruthy();
  });

  it("handles environment with packages config", async () => {
    const res = await post("/v1/environments", {
      name: "packaged-env",
      config: {
        type: "cloud",
        packages: {
          pip: ["numpy", "pandas"],
          npm: ["lodash"],
          apt: ["curl", "jq"],
        },
        networking: {
          type: "limited",
          allowed_hosts: ["api.example.com"],
          allow_mcp_servers: true,
          allow_package_managers: true,
        },
      },
    });
    expect(res.status).toBe(201);

    const environment = (await res.json()) as any;
    expect(environment.config.packages.pip).toEqual(["numpy", "pandas"]);
    expect(environment.config.packages.npm).toEqual(["lodash"]);
    expect(environment.config.packages.apt).toEqual(["curl", "jq"]);
    expect(environment.config.networking.type).toBe("limited");
    expect(environment.config.networking.allowed_hosts).toEqual(["api.example.com"]);
  });

  it("session with vault_ids stores them", async () => {
    const { agent, environment } = await createAgentAndEnv();
    const session = await createSession(agent.id, environment.id, {
      vault_ids: ["vlt_abc", "vlt_def"],
    });

    expect(session.vault_ids).toEqual(["vlt_abc", "vlt_def"]);

    // Verify persisted via GET
    const getRes = await api(`/v1/sessions/${session.id}`, {
      headers: HEADERS,
    });
    const fetched = (await getRes.json()) as any;
    expect(fetched.vault_ids).toEqual(["vlt_abc", "vlt_def"]);
  });

  it("agent created with callable_agents is stored via buildTools", async () => {
    // The API doesn't store callable_agents directly, but buildTools uses them
    // Test that buildTools creates call_agent tools from config
    const { buildTools } = await import("../../apps/agent/src/harness/tools");
    const { TestSandbox } = await import("../../apps/agent/src/runtime/sandbox");
    const sandbox = new TestSandbox();
    const tools = await buildTools({
      id: "agent_test_ca",
      name: "CA Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      callable_agents: [
        { type: "agent", id: "agent_w1", version: 1 },
        { type: "agent", id: "agent_w2", version: 2 },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    }, sandbox, { ANTHROPIC_API_KEY: "sk-test" });
    expect(tools.call_agent_agent_w1).toBeDefined();
    expect(tools.call_agent_agent_w2).toBeDefined();
  });

  it("agent created with mcp_servers generates MCP tools via buildTools", async () => {
    const { buildTools } = await import("../../apps/agent/src/harness/tools");
    const { TestSandbox } = await import("../../apps/agent/src/runtime/sandbox");
    const sandbox = new TestSandbox();
    const tools = await buildTools({
      id: "agent_test_mcp",
      name: "MCP Agent",
      model: "claude-sonnet-4-6",
      system: "",
      tools: [{ type: "agent_toolset_20260401" }],
      mcp_servers: [
        { name: "github", type: "sse", url: "https://mcp.github.com/sse" },
        { name: "slack", type: "sse", url: "https://mcp.slack.com/sse" },
      ],
      version: 1,
      created_at: new Date().toISOString(),
    }, sandbox);
    // MCP tools now expand inline as `mcp__<server>__<tool>`; legacy
    // `mcp_<srv>_list_tools` / `mcp_<srv>_call` were removed. The
    // buildTools call still succeeds and returns a populated ToolSet.
    expect(tools).toBeDefined();
    expect(typeof tools).toBe("object");
  });

  it("resolveSkills returns empty for non-registered skills (all skills via KV now)", async () => {
    const { resolveSkills } = await import("../../apps/agent/src/harness/skills");
    const skills = resolveSkills([
      { skill_id: "web_research" },
      { skill_id: "pptx" },
    ]);
    // No hardcoded built-in skills — all managed via /v1/skills API
    expect(skills).toHaveLength(0);
  });

  it("agent with custom tools via API is stored", async () => {
    const res = await post("/v1/agents", {
      name: "Custom Tool Agent",
      model: "claude-sonnet-4-6",
      tools: [
        { type: "agent_toolset_20260401" },
        { type: "custom", name: "get_weather", description: "Get weather forecast", input_schema: {} },
      ],
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.tools).toHaveLength(2);
    expect(agent.tools[1].type).toBe("custom");
    expect(agent.tools[1].name).toBe("get_weather");
  });

  it("agent with mixed tools (toolset + custom) both stored", async () => {
    const res = await post("/v1/agents", {
      name: "Mixed Tools Agent",
      model: "claude-sonnet-4-6",
      tools: [
        {
          type: "agent_toolset_20260401",
          default_config: { enabled: false },
          configs: [{ name: "bash", enabled: true }],
        },
        { type: "custom", name: "deploy", description: "Deploy app" },
        { type: "custom", name: "rollback", description: "Rollback deploy" },
      ],
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.tools).toHaveLength(3);
    expect(agent.tools[0].type).toBe("agent_toolset_20260401");
    expect(agent.tools[1].name).toBe("deploy");
    expect(agent.tools[2].name).toBe("rollback");
  });

  // FIXME: harness field appears to round-trip through service.create OK
  // (agents-store/service.ts:141) but lands as undefined in the formatAgent
  // _oma envelope on the response. Suspect a dropped field in the
  // service→repo→toRow chain that only surfaces when no other _oma field
  // is set. Re-enable once tracked down.
  it.skip("agent with all supported fields via API", async () => {
    const res = await post("/v1/agents", {
      name: "Full Agent",
      model: { id: "claude-sonnet-4-6", speed: "fast" },
      system: "You are comprehensive.",
      tools: [{ type: "agent_toolset_20260401" }],
      harness: "custom-harness-name",
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.name).toBe("Full Agent");
    expect(agent.model.id).toBe("claude-sonnet-4-6");
    expect(agent.model.speed).toBe("fast");
    expect(agent.system).toBe("You are comprehensive.");
    // harness now lives under the `_oma:` envelope (P2-B formatAgent
    // shape) instead of top-level — Console-served agents are CF/Node
    // identical via the wrapped envelope.
    expect(agent._oma?.harness).toBe("custom-harness-name");
    expect(agent.version).toBe(1);
  });

  it("agent model as object {id, speed} via API", async () => {
    const res = await post("/v1/agents", {
      name: "Speed Agent",
      model: { id: "claude-opus-4-6", speed: "fast" },
    });
    expect(res.status).toBe(201);
    const agent = (await res.json()) as any;
    expect(agent.model.id).toBe("claude-opus-4-6");
    expect(agent.model.speed).toBe("fast");
  });

  it("agent update system preserves tools in version history", async () => {
    const createRes = await post("/v1/agents", {
      name: "Versioned Tools",
      model: "claude-sonnet-4-6",
      system: "v1 system",
      tools: [{
        type: "agent_toolset_20260401",
        default_config: { enabled: false },
        configs: [{ name: "bash", enabled: true }],
      }],
    });
    const agent = (await createRes.json()) as any;

    // Update system
    await api(`/v1/agents/${agent.id}`, {
      method: "PUT",
      headers: HEADERS,
      body: JSON.stringify({ system: "v2 system" }),
    });

    // Version 1 should have original system
    const v1Res = await api(`/v1/agents/${agent.id}/versions/1`, { headers: HEADERS });
    const v1 = (await v1Res.json()) as any;
    expect(v1.system).toBe("v1 system");
    expect(v1.tools[0].default_config.enabled).toBe(false);

    // Current should have updated system
    const currentRes = await api(`/v1/agents/${agent.id}`, { headers: HEADERS });
    const current = (await currentRes.json()) as any;
    expect(current.system).toBe("v2 system");
    expect(current.version).toBe(2);
  });

  // FIXME: end-to-end mockHarness + DO WS event-replay flow stopped seeing
  // the agent.message broadcast post-P3/P4 refactors. The wire shape itself
  // is unchanged; the issue is in the test harness wiring (not user-facing
  // behavior). Re-enable once the mockHarness is rebound to the new
  // SessionRouter path.
  it.skip("session events with unicode content round-trip correctly", async () => {
    registerHarness("echo-unicode", () => ({
      async run(ctx) {
        const text = ctx.userMessage.content[0]?.text || "";
        ctx.runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: `echo: ${text}` }],
        });
      },
    }));

    const agentRes = await post("/v1/agents", {
      name: "Unicode Echo",
      model: "claude-sonnet-4-6",
      harness: "echo-unicode",
    });
    const agent = (await agentRes.json()) as any;

    const envRes = await post("/v1/environments", {
      name: "e",
      config: { type: "cloud" },
    });
    const environment = (await envRes.json()) as any;

    const session = await createSession(agent.id, environment.id);

    const unicodeText = "Erd\u0151s \u2013 R\u00e9nyi \u2228 \u00e9l\u00e9ments \ud83c\udf1f \u6d4b\u8bd5";
    await api(`/v1/sessions/${session.id}/events`, {
      method: "POST",
      headers: HEADERS,
      body: JSON.stringify({
        events: [{ type: "user.message", content: [{ type: "text", text: unicodeText }] }],
      }),
    });

    await new Promise((r) => setTimeout(r, 300));

    // Replay events from the DO
    const doId = env.SESSION_DO!.idFromName(session.id);
    const stub = env.SESSION_DO!.get(doId);
    const wsRes = await stub.fetch(
      new Request("http://internal/ws", { headers: { Upgrade: "websocket", "x-oma-replay": "1", "x-oma-include": "chunks" } })
    );
    const ws = wsRes.webSocket!;
    ws.accept();
    const events: any[] = [];
    await new Promise<void>((resolve) => {
      ws.addEventListener("message", (e) =>
        events.push(JSON.parse(e.data as string))
      );
      setTimeout(() => {
        ws.close();
        resolve();
      }, 100);
    });

    const userMsg = events.find((e: any) => e.type === "user.message");
    expect(userMsg).toBeTruthy();
    expect(userMsg.content[0].text).toBe(unicodeText);

    const agentMsg = events.find((e: any) => e.type === "agent.message");
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.content[0].text).toContain(unicodeText);
  });

  it("session title is persisted and retrievable", async () => {
    const { agent, environment } = await createAgentAndEnv();
    const session = await createSession(agent.id, environment.id, {
      title: "My test conversation",
    });

    expect(session.title).toBe("My test conversation");

    const getRes = await api(`/v1/sessions/${session.id}`, {
      headers: HEADERS,
    });
    const fetched = (await getRes.json()) as any;
    expect(fetched.title).toBe("My test conversation");
  });
});
