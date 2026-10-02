import { describe, expect, it, vi } from "vitest";
import { tool, jsonSchema } from "ai";
import { z } from "zod";
import {
  createFauxCore,
  fauxAssistantMessage,
  fauxText,
  fauxThinking,
  fauxToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  PiHarness,
  adaptOmaTools,
  credentialsFromLanguageModel,
  ensureContinuableTail,
  modelMessagesToPi,
  normalizeToolOutputForWire,
  PENDING_TOOL_TEXT,
  providerOptionsFromThinking,
  resolvePiModel,
  thinkingFromProviderOptions,
  type ResolvedPiModel,
} from "../../agent/src/harness/pi/index";
import { eventsToMessages } from "../../agent/src/runtime/history";
import { resolveModel } from "../../agent/src/harness/provider";
import { resetInflightToolCallsForTest } from "../../agent/src/harness/durable-tools";
import type { HarnessContext } from "../../agent/src/harness/interface";
import type { SessionEvent } from "@open-managed-agents/shared";

const PI_MODEL = resolvePiModel({ model: "claude-sonnet-4-6", apiKey: "k", apiCompat: "ant" }).model;

// ─── message conversion ──────────────────────────────────────────────────

describe("pi harness: OMA history → pi messages", () => {
  const events = [
    { type: "user.message", content: [{ type: "text", text: "list files" }] },
    { type: "agent.thinking", text: "I should run ls", providerOptions: { anthropic: { signature: "sig-1" } } },
    { type: "agent.message", content: [{ type: "text", text: "Running ls" }] },
    { type: "agent.tool_use", id: "tc1", name: "bash", input: { command: "ls" } },
    { type: "agent.tool_use", id: "tc2", name: "read", input: { file_path: "/x.png" } },
    { type: "agent.tool_result", tool_use_id: "tc1", content: "a.txt\nb.txt" },
    {
      type: "agent.tool_result",
      tool_use_id: "tc2",
      content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }],
    },
    { type: "agent.message", content: [{ type: "text", text: "Done" }] },
    { type: "user.message", content: [{ type: "text", text: "" }] },
    { type: "user.message", content: [{ type: "text", text: "thanks" }] },
  ] as unknown as SessionEvent[];

  it("maps user/assistant/tool turns with ids, signatures and images", () => {
    const pi = modelMessagesToPi(eventsToMessages(events), { model: PI_MODEL });
    expect(pi.map((m) => m.role)).toEqual(["user", "assistant", "toolResult", "toolResult", "assistant", "user"]);
    const asst = pi[1] as Extract<(typeof pi)[number], { role: "assistant" }>;
    expect(asst.provider).toBe("anthropic");
    expect(asst.model).toBe("claude-sonnet-4-6");
    expect(asst.content).toEqual([
      { type: "thinking", thinking: "I should run ls", thinkingSignature: "sig-1" },
      { type: "text", text: "Running ls" },
      { type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } },
      { type: "toolCall", id: "tc2", name: "read", arguments: { file_path: "/x.png" } },
    ]);
    expect(asst.stopReason).toBe("toolUse");
    expect(pi[2]).toMatchObject({ toolCallId: "tc1", toolName: "bash", isError: false, content: [{ type: "text", text: "a.txt\nb.txt" }] });
    expect(pi[3]).toMatchObject({ toolCallId: "tc2", content: [{ type: "image", data: "iVBOR", mimeType: "image/png" }] });
    // The empty resume marker is dropped (Anthropic rejects empty text blocks).
    expect(pi[5]).toMatchObject({ role: "user", content: [{ type: "text", text: "thanks" }] });
  });

  it("applies the wire tool-name mapping to calls and results", () => {
    const pi = modelMessagesToPi(eventsToMessages(events.slice(0, 6)), {
      model: PI_MODEL,
      toolName: (n) => `w_${n}`,
    });
    expect((pi[1] as { content: Array<{ type: string; name?: string }> }).content.find((c) => c.type === "toolCall")?.name).toBe("w_bash");
    expect((pi[2] as { toolName: string }).toolName).toBe("w_bash");
  });

  it("round-trips thinking signatures (pi-native and Anthropic AI-SDK shapes)", () => {
    const opts = providerOptionsFromThinking({ type: "thinking", thinking: "t", thinkingSignature: "s" }, "anthropic-messages");
    expect(opts).toEqual({ pi: { thinkingSignature: "s" }, anthropic: { signature: "s" } });
    expect(thinkingFromProviderOptions("t", opts)).toEqual({ type: "thinking", thinking: "t", thinkingSignature: "s" });
    expect(thinkingFromProviderOptions("", { anthropic: { redactedData: "r" } })).toMatchObject({ redacted: true, thinkingSignature: "r" });
  });

  it("guarantees a continuable tail", () => {
    const pi = modelMessagesToPi(eventsToMessages(events.slice(0, 3)), { model: PI_MODEL });
    expect(ensureContinuableTail(pi).at(-1)).toMatchObject({ role: "user" });
    const withUser = modelMessagesToPi(eventsToMessages(events.slice(0, 1)), { model: PI_MODEL });
    expect(ensureContinuableTail(withUser)).toHaveLength(1);
  });
});

// ─── tool adapter ────────────────────────────────────────────────────────

describe("pi harness: tool adapter", () => {
  it("converts zod schemas to plain JSON Schema and executes through OMA execute", async () => {
    const execute = vi.fn(async (input: { command: string; timeout: number }) => `ran ${input.command} (${input.timeout})`);
    const adapted = await adaptOmaTools({
      bash: tool({
        description: "Run a command",
        inputSchema: z.object({ command: z.string(), timeout: z.number().default(120) }),
        execute,
      }),
    });
    const [t] = adapted.tools;
    expect(t.name).toBe("bash");
    expect(t.description).toBe("Run a command");
    const params = t.parameters as unknown as Record<string, unknown>;
    expect(params.$schema).toBeUndefined();
    expect(params).toMatchObject({ type: "object", properties: { command: { type: "string" } }, required: ["command"] });

    const result = await t.execute("tc-1", { command: "ls" } as never);
    // zod defaults still apply (the OMA schema's own validate runs).
    expect(execute).toHaveBeenCalledWith({ command: "ls", timeout: 120 }, expect.objectContaining({ toolCallId: "tc-1" }));
    expect(result.content).toEqual([{ type: "text", text: "ran ls (120)" }]);
    expect(result.details).toEqual({ oma_wire: "ran ls (120)" });
  });

  it("maps multimodal ContentBlock output to pi image content, keeping the wire form", async () => {
    const block = { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
    const adapted = await adaptOmaTools({
      read: tool({ inputSchema: jsonSchema({ type: "object", properties: { p: { type: "string" } } }), execute: async () => block }),
    });
    const r = await adapted.tools[0].execute("tc", { p: "x" } as never);
    expect(r.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
    expect(r.details).toEqual({ oma_wire: [block] });
    expect(normalizeToolOutputForWire({ a: 1 })).toBe('{"a":1}');
  });

  it("returns a pending sentinel (never runs) for tools without execute", async () => {
    const adapted = await adaptOmaTools({ deploy: tool({ inputSchema: z.object({}) }) as never });
    expect(adapted.isPending("deploy")).toBe(true);
    const r = await adapted.tools[0].execute("tc", {} as never);
    expect(r.details).toEqual({ oma_pending: true });
    expect(r.terminate).toBe(true);
    expect(r.content).toEqual([{ type: "text", text: PENDING_TOOL_TEXT }]);
  });

  it("shortens >64-char names for OpenAI and maps them back", async () => {
    const long = `mcp_${"x".repeat(80)}_call`;
    const adapted = await adaptOmaTools({ [long]: tool({ inputSchema: z.object({}), execute: async () => "ok" }) }, { openAiToolNames: true });
    const wire = adapted.tools[0].name;
    expect(wire.length).toBeLessThanOrEqual(64);
    expect(adapted.toOma(wire)).toBe(long);
  });
});

// ─── model resolution ────────────────────────────────────────────────────

describe("pi harness: model resolution", () => {
  it("maps Anthropic cards (strip /v1, catalog metadata, custom headers)", () => {
    const r = resolvePiModel({ model: "claude-sonnet-4.6", apiKey: "k", baseURL: "https://gw.example/v1", apiCompat: "ant", customHeaders: { "x-a": "1" } });
    expect(r.model).toMatchObject({ id: "claude-sonnet-4-6", api: "anthropic-messages", baseUrl: "https://gw.example", headers: { "x-a": "1" } });
    expect(r.model.contextWindow).toBeGreaterThan(100_000);
    expect(r.reasoning).toBeUndefined();
    expect(resolvePiModel({ model: "claude-sonnet-4-6", apiKey: "k", apiCompat: "ant" }, { reasoningLevel: "high" }).reasoning).toBe("high");
  });

  it("maps OpenAI-compatible cards to chat completions with custom base URL", () => {
    const r = resolvePiModel({ model: "deepseek-chat", apiKey: "k", baseURL: "https://api.deepseek.com/v1/", apiCompat: "oai-compatible" });
    expect(r.model).toMatchObject({ api: "openai-completions", baseUrl: "https://api.deepseek.com/v1", provider: "openai-compatible" });
    expect(r.openAiToolNames).toBe(true);
  });

  it("mirrors the OpenAI reasoning endpoint split", () => {
    expect(resolvePiModel({ model: "gpt-5", apiKey: "k", apiCompat: "oai" }, { reasoningLevel: "high", hasTools: true }).model.api).toBe("openai-responses");
    const chat = resolvePiModel({ model: "gpt-5", apiKey: "k", apiCompat: "oai" }, { hasTools: true });
    expect(chat.model.api).toBe("openai-completions");
    expect(chat.samplingParams).toEqual({ reasoning_effort: "none" });
  });

  it("recovers credentials from an AI SDK model (CF path)", async () => {
    const ant = await credentialsFromLanguageModel(resolveModel("claude-haiku-4-5", "sk-ant", undefined, "ant", { "x-t": "1" }));
    expect(ant).toMatchObject({ model: "claude-haiku-4-5", apiKey: "sk-ant", apiCompat: "ant", customHeaders: { "x-t": "1" } });
    const oai = await credentialsFromLanguageModel(resolveModel("m", "sk-o", "https://gw.example/v1", "oai-compatible"));
    expect(oai).toMatchObject({ apiKey: "sk-o", baseURL: "https://gw.example/v1", apiCompat: "oai-compatible" });
  });
});

// ─── harness run against pi-ai's faux provider ───────────────────────────

function makeCtx(opts: { tools: Record<string, unknown>; events?: SessionEvent[]; persist?: boolean }) {
  const log: SessionEvent[] = [...(opts.events ?? [{ type: "user.message", content: [{ type: "text", text: "list files" }] } as SessionEvent])];
  const writes: Array<{ via: "persist" | "broadcast"; event: SessionEvent }> = [];
  const pendingConfirmations: string[] = [];
  const runtime = {
    history: { getEvents: () => log, getMessages: () => [], append: (e: SessionEvent) => log.push(e) },
    broadcast: vi.fn((e: SessionEvent) => { writes.push({ via: "broadcast", event: e }); log.push(e); }),
    ...(opts.persist === false ? {} : {
      persist: vi.fn(async (e: SessionEvent) => { writes.push({ via: "persist", event: e }); log.push(e); }),
    }),
    broadcastStreamStart: vi.fn(async () => {}),
    broadcastChunk: vi.fn(async () => {}),
    broadcastStreamEnd: vi.fn(async () => {}),
    broadcastThinkingStart: vi.fn(async () => {}),
    broadcastThinkingChunk: vi.fn(async () => {}),
    broadcastThinkingEnd: vi.fn(async () => {}),
    broadcastToolInputStart: vi.fn(async () => {}),
    broadcastToolInputChunk: vi.fn(async () => {}),
    broadcastToolInputEnd: vi.fn(async () => {}),
    reportUsage: vi.fn(async () => {}),
    pendingConfirmations,
  };
  const ctx = {
    agent: { id: "agent-1", name: "a", model: "faux-1", system: "", tools: [] },
    userMessage: log[0],
    session_id: "sess-1",
    tenant_id: "t",
    tools: opts.tools,
    model: undefined,
    systemPrompt: "You are a test agent.",
    env: { ANTHROPIC_API_KEY: "" },
    runtime,
  } as unknown as HarnessContext;
  return { ctx, runtime, writes, log, pendingConfirmations };
}

function fauxResolver(responses: Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0]) {
  const faux = createFauxCore({ models: [{ id: "faux-1", reasoning: true }] });
  faux.setResponses(responses);
  const resolved: ResolvedPiModel = {
    model: faux.getModel() as never,
    streamFn: (m, c, o) => faux.streamSimple(m as never, c, o),
    apiKey: "faux",
    openAiToolNames: false,
  };
  return { faux, harness: new PiHarness({ resolveModel: () => resolved }) };
}

describe("pi harness: run() against a faux pi-ai model", () => {
  it("emits default-harness event shapes with write-ahead tool_use and immediate tool_result", async () => {
    resetInflightToolCallsForTest();
    let writesAtExecute: string[] = [];
    let seenContext: TranscriptContext | undefined;
    const { ctx, writes, runtime } = makeCtx({
      tools: {
        bash: tool({
          inputSchema: z.object({ command: z.string() }),
          execute: async ({ command }) => {
            writesAtExecute = writes.map((w) => `${w.via}:${w.event.type}`);
            return `ran ${command}`;
          },
        }),
      },
    });
    const { harness } = fauxResolver([
      fauxAssistantMessage([fauxThinking("plan"), fauxText("Listing."), fauxToolCall("bash", { command: "ls" }, { id: "tc1" })], { stopReason: "toolUse" }),
      (context) => {
        seenContext = { ...context, messages: [...context.messages] } as TranscriptContext;
        return fauxAssistantMessage("Found a.txt");
      },
    ]);

    await harness.run(ctx);

    const types = writes.map((w) => w.event.type);
    expect(types).toEqual([
      "span.model_request_start",
      "span.model_first_token",
      "agent.thinking",
      "agent.message",
      "agent.tool_use",
      "span.model_request_end",
      "agent.tool_result",
      "span.model_request_start",
      "span.model_first_token",
      "agent.message",
      "span.model_request_end",
    ]);
    // Write-ahead: the durable tool_use landed before execute ran.
    expect(writesAtExecute).toContain("persist:agent.tool_use");
    expect(writesAtExecute).not.toContain("persist:agent.tool_result");

    const toolUse = writes.find((w) => w.event.type === "agent.tool_use")!;
    expect(toolUse.via).toBe("persist");
    const spanStart = writes.find((w) => w.event.type === "span.model_request_start")!.event as { id: string };
    expect(toolUse.event).toMatchObject({
      id: "tc1",
      name: "bash",
      input: { command: "ls" },
      idempotency_key: "sess-1:tc1",
      execution_class: expect.any(String),
      model_request_start_id: spanStart.id,
    });
    expect(writes.find((w) => w.event.type === "agent.tool_result")).toMatchObject({
      via: "persist",
      event: { tool_use_id: "tc1", content: "ran ls", parent_event_id: "tc1" },
    });
    expect(writes.filter((w) => w.event.type === "agent.message").map((w) => (w.event as { content: unknown }).content)).toEqual([
      [{ type: "text", text: "Listing." }],
      [{ type: "text", text: "Found a.txt" }],
    ]);
    // Only the loop-ending reply is step_final (PR #30 QA round 3, R1).
    expect(writes.filter((w) => w.event.type === "agent.message").map((w) => (w.event as { step_final?: boolean }).step_final === true)).toEqual([false, true]);
    const spanEnd = writes.find((w) => w.event.type === "span.model_request_end")!.event as Record<string, unknown>;
    expect(spanEnd).toMatchObject({ model_request_start_id: spanStart.id, finish_reason: "tool-calls", is_error: false });
    expect((spanEnd.model_usage as { input_tokens: number }).input_tokens).toBeGreaterThan(0);

    // The second request saw system prompt, tool declaration and the tool result.
    const sys = seenContext!.messages[0] as { role: string; content: unknown; toolsAdded?: Array<{ name: string }> };
    expect(sys).toMatchObject({ role: "system", content: "You are a test agent." });
    expect(sys.toolsAdded?.map((t) => t.name)).toEqual(["bash"]);
    expect(seenContext!.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "ran ls" }] });

    // Live streaming + usage reporting.
    expect(runtime.broadcastStreamStart).toHaveBeenCalled();
    expect(runtime.broadcastChunk).toHaveBeenCalled();
    expect(runtime.reportUsage).toHaveBeenCalled();
  });

  it("surfaces tools without execute as requires_action and stops the loop", async () => {
    resetInflightToolCallsForTest();
    const bash = vi.fn(async () => "ok");
    const { ctx, writes, pendingConfirmations } = makeCtx({
      tools: {
        bash: tool({ inputSchema: z.object({}), execute: bash }),
        // always_ask built-in: platform strips execute
        write: tool({ inputSchema: z.object({ path: z.string() }) }) as never,
      },
    });
    const { harness, faux } = fauxResolver([
      fauxAssistantMessage([fauxToolCall("bash", {}, { id: "a" }), fauxToolCall("write", { path: "/x" }, { id: "b" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("should not be requested"),
    ]);

    await harness.run(ctx);

    expect(faux.state.callCount).toBe(1);
    expect(bash).toHaveBeenCalledOnce();
    expect(pendingConfirmations).toEqual(["b"]);
    expect(writes.find((w) => w.event.type === "agent.tool_use" && (w.event as { id: string }).id === "b")?.event)
      .toMatchObject({ evaluated_permission: "ask", idempotency_key: "sess-1:b" });
    const results = writes.filter((w) => w.event.type === "agent.tool_result").map((w) => (w.event as { tool_use_id: string }).tool_use_id);
    expect(results).toEqual(["a"]);
  });

  it("classifies MCP and custom tools like the default harness", async () => {
    resetInflightToolCallsForTest();
    const { ctx, writes, pendingConfirmations } = makeCtx({
      tools: {
        mcp_github_call: tool({ inputSchema: z.object({}), execute: async () => ({ ok: true }) }),
        send_email: tool({ inputSchema: z.object({ to: z.string() }) }) as never,
      },
    });
    const { harness } = fauxResolver([
      fauxAssistantMessage([fauxToolCall("mcp_github_call", {}, { id: "m1" }), fauxToolCall("send_email", { to: "a@b" }, { id: "c1" })], { stopReason: "toolUse" }),
    ]);
    await harness.run(ctx);
    expect(writes.find((w) => w.event.type === "agent.mcp_tool_use")?.event).toMatchObject({ id: "m1", mcp_server_name: "github" });
    expect(writes.find((w) => w.event.type === "agent.mcp_tool_result")?.event).toMatchObject({ mcp_tool_use_id: "m1", content: '{"ok":true}' });
    expect(writes.find((w) => w.event.type === "agent.custom_tool_use")?.event).toMatchObject({ id: "c1", name: "send_email" });
    expect(pendingConfirmations).toEqual(["c1"]);
  });

  it("reports schema-validation failures as tool results without executing", async () => {
    resetInflightToolCallsForTest();
    const execute = vi.fn(async () => "never");
    const { ctx, writes } = makeCtx({ tools: { bash: tool({ inputSchema: z.object({ command: z.string() }), execute }) } });
    const { harness } = fauxResolver([
      fauxAssistantMessage([fauxToolCall("bash", { wrong: 1 }, { id: "v1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("ok"),
    ]);
    await harness.run(ctx);
    expect(execute).not.toHaveBeenCalled();
    const result = writes.find((w) => w.event.type === "agent.tool_result")!.event as { content: string };
    expect(result.content).toMatch(/Validation failed/);
  });

  it("rejects the turn on a provider error and closes the span", async () => {
    resetInflightToolCallsForTest();
    const { ctx, writes } = makeCtx({ tools: {} });
    const { harness } = fauxResolver([
      fauxAssistantMessage([], { stopReason: "error", errorMessage: "Your credit balance is too low" }),
    ]);
    await expect(harness.run(ctx)).rejects.toThrow(/credit balance/);
    expect(writes.find((w) => w.event.type === "span.model_request_end")?.event).toMatchObject({ is_error: true, finish_reason: "error" });
  });

  it("throws silent_stop when the model ships nothing", async () => {
    resetInflightToolCallsForTest();
    const { ctx } = makeCtx({ tools: {} });
    const { harness } = fauxResolver([fauxAssistantMessage("   ")]);
    await expect(harness.run(ctx)).rejects.toThrow(/silent_stop/);
  });

  it("falls back to broadcast when the runtime has no durable persist", async () => {
    resetInflightToolCallsForTest();
    const { ctx, writes } = makeCtx({ tools: { bash: tool({ inputSchema: z.object({}), execute: async () => "ok" }) }, persist: false });
    const { harness } = fauxResolver([
      fauxAssistantMessage([fauxToolCall("bash", {}, { id: "x" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done"),
    ]);
    await harness.run(ctx);
    expect(writes.every((w) => w.via === "broadcast")).toBe(true);
    expect(writes.map((w) => w.event.type)).toContain("agent.tool_result");
  });
});
