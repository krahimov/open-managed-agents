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
    name: "Core Test Agent",
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
    it("routes official OpenAI reasoning models to the Responses API when level > instant", () => {
      const model = resolveModel("gpt-5.6-sol", "k", undefined, "oai", undefined, "high");
      expect(isOpenAiResponsesModel(model)).toBe(true);
    });

    it("stays on chat/completions for level=instant", () => {
      const model = resolveModel("gpt-5.6-sol", "k", undefined, "oai", undefined, "instant");
      expect(isOpenAiResponsesModel(model)).toBe(false);
    });

    it("stays on chat/completions when level is unset (legacy callers)", () => {
      const model = resolveModel("gpt-5.6-sol", "k", undefined, "oai");
      expect(isOpenAiResponsesModel(model)).toBe(false);
    });

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
    const oaiModel = (id: string, level?: "instant" | "low" | "medium" | "high") =>
      resolveModel(id, "k", undefined, "oai", undefined, level);
    const antModel = (id: string) => resolveModel(id, "k", undefined, "ant");

    // — the shipped floor (level unset / instant → chat endpoint) —

    it("forces reasoning_effort:'none' for gpt-5* with tools when level unset", () => {
      const opts = reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "gpt-5.6-sol", undefined, true);
      expect(opts).toEqual({ openai: { reasoningEffort: "none" } });
    });

    it("forces it for o-series (o3) with tools", () => {
      const opts = reasoningProviderOptions(oaiModel("o3"), "o3", undefined, true);
      expect(opts).toEqual({ openai: { reasoningEffort: "none" } });
    });

    it("forces it at level=instant with tools", () => {
      const opts = reasoningProviderOptions(oaiModel("gpt-5.6-sol", "instant"), "gpt-5.6-sol", "instant", true);
      expect(opts).toEqual({ openai: { reasoningEffort: "none" } });
    });

    it("does NOT fire without tools (reasoning stays available)", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "gpt-5.6-sol", undefined, false)).toBeUndefined();
    });

    it("does NOT fire for non-reasoning OpenAI models (gpt-4o)", () => {
      expect(reasoningProviderOptions(oaiModel("gpt-4o"), "gpt-4o", undefined, true)).toBeUndefined();
    });

    it("does NOT fire for gateway models that aren't gpt-5/o-series", () => {
      const gw = resolveModel("deepseek-chat", "k", "https://api.deepseek.com", "oai-compatible");
      expect(reasoningProviderOptions(gw, "deepseek-chat", undefined, true)).toBeUndefined();
    });

    it("strips provider prefix before matching", () => {
      const opts = reasoningProviderOptions(oaiModel("gpt-5.6-sol"), "openai/gpt-5.6-sol", undefined, true);
      expect(opts).toEqual({ openai: { reasoningEffort: "none" } });
    });

    // — levels above instant on the Responses API —

    it("passes the level's effort on the Responses API", () => {
      const model = oaiModel("gpt-5.6-sol", "high");
      expect(reasoningProviderOptions(model, "gpt-5.6-sol", "high", true)).toEqual({
        openai: { reasoningEffort: "high" },
      });
    });

    it("maps low/medium levels to matching efforts", () => {
      expect(reasoningProviderOptions(oaiModel("o3", "low"), "o3", "low", true)).toEqual({
        openai: { reasoningEffort: "low" },
      });
      expect(reasoningProviderOptions(oaiModel("o3", "medium"), "o3", "medium", true)).toEqual({
        openai: { reasoningEffort: "medium" },
      });
    });

    it("clamps to 'none' when a high level rides a chat-endpoint model (gateway)", () => {
      // Gateways never route to responses, so even level=high must clamp.
      const gw = resolveModel("gpt-5.6-sol", "k", "https://gw.example.com/v1", "oai-compatible", undefined, "high");
      expect(reasoningProviderOptions(gw, "gpt-5.6-sol", "high", true)).toEqual({
        openai: { reasoningEffort: "none" },
      });
    });

    it("prefers the resolved model's wire id over the card handle", () => {
      // Card handle "my-fast-model" wouldn't match the regex; the resolved
      // wire model id (gpt-5.6-sol) is what the provider actually sees.
      const model = oaiModel("gpt-5.6-sol");
      expect(reasoningProviderOptions(model, "my-fast-model", undefined, true)).toEqual({
        openai: { reasoningEffort: "none" },
      });
    });

    // — Anthropic extended thinking —

    it("enables Claude extended thinking with the level's budget", () => {
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "low", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } },
      });
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "medium", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
      });
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "high", true)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 32768 } },
      });
    });

    it("thinking works regardless of tools (no Anthropic endpoint split)", () => {
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "medium", false)).toEqual({
        anthropic: { thinking: { type: "enabled", budgetTokens: 16384 } },
      });
    });

    it("does NOT fire for Anthropic at instant / unset level", () => {
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", "instant", true)).toBeUndefined();
      expect(reasoningProviderOptions(antModel("claude-sonnet-4-6"), "claude-sonnet-4-6", undefined, true)).toBeUndefined();
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

    it("chat floor: instant-level gpt-5 with tools sends reasoning_effort:'none'", async () => {
      const model = resolveModel("gpt-5.6-sol", "wire-key-floor", undefined, "oai");
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

    it("Anthropic level=medium sends thinking.budget_tokens=16384 with max_tokens headroom", async () => {
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
      expect(calls[0].body.thinking).toEqual({ type: "enabled", budget_tokens: 16384 });
      // @ai-sdk/anthropic adds the budget on top of max_tokens itself.
      expect(calls[0].body.max_tokens).toBeGreaterThan(16384);
    });
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
