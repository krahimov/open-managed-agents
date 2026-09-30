# Pi as a harness primitive

This doc evaluates Mario Zechner's **Pi** agent SDK for OMA and describes the
`pi` harness that ships with this change. Findings were checked against the
published packages (`npm view`, installed `dist/*.d.ts`, READMEs, and the
compiled sources). They were not written from memory. Snapshot date: 2026-09-30.

## 1. What Pi is (as of 0.99.1)

**The name has moved.** The project started as `badlogic/pi-mono` with the
`@mariozechner/*` npm scope. Those packages are now **deprecated**
(`npm view @mariozechner/pi-agent-core deprecated` says "please use
@earendil-works/pi-agent-core instead"), and their last release was 0.73.1 in
May 2026. Development continues at `github.com/earendil-works/pi` under the
`@earendil-works/*` scope. Maintainers are badlogic, mitsuhiko and rwachtler.
Every package is **MIT**. The packages require `node >= 22.19`. OMA's
Dockerfile uses `node:22-slim`, which satisfies that.

| Package | Role | Relevant to OMA? |
|---|---|---|
| `@earendil-works/pi-ai` | Unified multi-provider LLM streaming API. Supports Anthropic Messages, OpenAI Completions and Responses, Azure, Codex, Google Gemini and Vertex, Bedrock, Mistral, and Workers AI. Also provides a model catalog, auth/OAuth, a faux test provider, and TypeBox tool schemas. | **Yes.** It is the provider layer. |
| `@earendil-works/pi-agent-core` | Agent loop (`agentLoop` / `runAgentLoop*`), a stateful `Agent` class, tool execution, hooks, compaction helpers, and session/harness abstractions. | **Yes.** It is the loop. |
| `@earendil-works/pi-coding-agent` | The `pi` coding-agent CLI/TUI, plus an SDK mode. Pulls in TUI, MCP, codemode (quickjs), jiti extensions, and photon image processing. | No. It is a product, not a primitive. It overlaps with OMA's own tools and sandbox. |
| `pi-tui`, `pi-web-ui`, `pi-mcp`, `pi-codemode`, `pi-server`, `pi-client`, `pi-protocol`, `pi-storage-sqlite-node`, `pi-session-backend-sqlite-node`, `pi-telemetry`, `chord` | UI, MCP client, JS code-mode tool, a server/client protocol, SQLite session storage, telemetry, and facet services. | Not now. `pi-mcp` and `pi-codemode` are worth a look later. |

**Maturity.** Pi is still pre-1.0 and moves fast: 51 releases from 0.74.0
(2026-05-07) to 0.99.1 (2026-09-29). Breaking changes land often. Examples
in 0.99 alone: the system prompt and tool declarations moved into the
transcript as `SystemMessage`s, and `shouldStopAfterTurn` was removed in
favour of `finishTurn`. Pin exact versions. This change pins `0.99.1`.

## 2. API surface (what we actually use)

- **Messages** (`pi-ai`): `SystemMessage | UserMessage | AssistantMessage | ToolResultMessage`.
  - Content blocks are `text`, `thinking` (with `thinkingSignature` and `redacted`), `image` (base64 only) and `toolCall {id, name, arguments}`.
  - There is **no document/PDF block** and no URL images.
  - The system prompt and tool declarations are transcript entries: the leading `SystemMessage` holds the prompt and `toolsAdded`, and later system messages patch it.
  - `AssistantMessage` carries `api/provider/model`, `usage {input, output, cacheRead, cacheWrite, cost}`, `stopReason` (`stop|length|toolUse|error|aborted|…`) and `errorMessage`.
- **Streaming**: every provider returns an `AssistantMessageEventStream`.
  - Events: `start`, `text_*`, `thinking_*`, `toolcall_*` (each with `contentIndex` and the live `partial`), then `done` or `error`.
  - Providers **never throw**. Failures are encoded as a final message with `stopReason: "error"`.
- **Tools**: `Tool { name, description, parameters: TSchema }`.
  - TypeBox is preferred, but **plain JSON Schema works too**. `validateToolArguments` has a non-TypeBox path with primitive coercion.
  - TypeBox's compiled validators fall back to interpreted checking when `eval` is unavailable, which is the case on Workers.
- **Agent loop** (`pi-agent-core`): `runAgentLoop(prompts, ctx, config, emit, signal, streamFn)` and `runAgentLoopContinue(...)`.
  - The `emit` sink is **awaited**. This is what makes write-ahead possible.
  - Hooks: `convertToLlm`, `transformContext`, `prepareRequest`, `prepareNextTurn`, `beforeToolCall`, `afterToolCall`, `finishTurn` (`{action:"end"|"continue"}`), steering and follow-up queues.
  - Tool execution can be `parallel` or `sequential`. Tool results may return `terminate: true`.
  - Custom message roles are added through declaration merging.
- **Abort**: an `AbortSignal` passes through the loop to providers and tools. The result is an `aborted` stop reason.
- **Context and compaction**: `pi-agent-core` exports `compact`, `shouldCompact`, `prepareCompaction`, `estimateContextTokens`, and branch summarization.
- **Session persistence**: `harness/session` provides an append-only session tree with pluggable storage. SQLite ships as a separate package.
- **Testing**: `createFauxCore()` / `fauxProvider()` give a scripted provider with streaming deltas, usage estimation and prompt-cache simulation. We use it in tests.

### Runtime compatibility (Node vs Workers)

I grepped `dist/` for Node builtins:

- **pi-ai**: static `node:` imports appear only in `cli.js` and the OAuth callback-server modules. None of these are used here.
- **pi-agent-core**: static `node:` imports appear only in `harness/env/nodejs`, `pico3`, and the session test conformance suites. These are separate export paths.
- A browser-platform esbuild bundle of `agentLoop` plus the Anthropic and OpenAI API modules builds cleanly. Its three remaining builtin references (`node:os`, `node:fs`, `node:util`) are guarded behind `process.getBuiltinModule` or Bun checks.
- `wrangler deploy --dry-run` of `apps/agent`, with the `pi` harness registered, bundles successfully: 9.9 MB upload, 1.79 MB gzip. The only error is the unrelated Docker container build step.

**Conclusion:** the loop and the provider modules are Workers-compatible. The
cost is bundle size, because pi-ai hard-depends on the `openai` and
`@anthropic-ai/sdk` SDKs and the AI SDK does not use either. pi-ai also
declares `@google/genai` and `@aws-sdk/client-bedrock-runtime` as hard
dependencies. These are installed but not bundled unless imported.

## 3. Pi vs the Vercel AI SDK for OMA

| Concern | Vercel AI SDK (today) | Pi |
|---|---|---|
| Loop control | `streamText` + `stopWhen`. Hooks are partly `experimental_*`. Tools auto-execute inside the SDK, so write-ahead needed a stream transform plus execute gates (`durable-tools.ts`). | An explicit, small loop with an **awaited event sink** and first-class `beforeToolCall`, `afterToolCall`, `finishTurn` and `prepareRequest`. Write-ahead falls out naturally. |
| Messages | `ModelMessage` with provider-specific `providerOptions` side channels. | A normalized transcript. Thinking signatures, tool-call id normalization and cross-model replay (thinking downgraded to text, orphan tool results synthesized) are built in. |
| Providers | Many via `@ai-sdk/*`, and it is OMA's existing investment (ZDR fallback, `observingFetch`, LLM R2 logging middleware, cache-control strategy). | Many, plus a generated model catalog (context window, max tokens, cost, compat flags). Automatic prompt caching (`cacheRetention`). OAuth for subscription providers. |
| Multimodal | Documents/PDFs and URL images supported. | Text and base64 images only. **Documents are lossy.** |
| Stability | 1.x-grade semver. | Pre-1.0 with frequent breaking changes. The package scope has already been renamed once. |
| Footprint | Modular per-provider packages. | pi-ai pulls official vendor SDKs, which makes the Worker bundle heavy. |
| Testing | `MockLanguageModelV3`. | A faux provider with realistic streaming and usage. |

## 4. Recommendation

1. **(a) Ship `pi` as an additional harness. Done here, low risk.** Keep
   `default` on the AI SDK. The Pi harness reuses every platform primitive:
   history projection, tools, the durable-execution helpers, compaction,
   policy and vault. That makes it a real A/B surface for loop behaviour, and
   it lets agents opt in per agent.
2. **(b) pi-ai as OMA's provider layer: not yet.** The AI SDK path carries
   OMA-specific hardening that pi-ai would have to re-implement:
   - `observingFetch`, rate-limit logging and 5-minute stream timeouts;
   - LLM body logging to R2;
   - the ZDR Responses→chat fallback;
   - Astra overrides;
   - `max_tokens` fixes for Anthropic-compatible third parties;
   - document inputs.

   pi-ai's catalog, OAuth providers and cross-provider replay are genuinely
   better, so revisit it once Pi reaches 1.0 or its API holds steady for a
   few releases. A reasonable intermediate step is to use pi-ai's catalog
   only, for context windows. That would replace default-loop's hard-coded
   `resolveContextWindowTokens`.
3. **(c) A future harness-SDK contract on Pi's agent-core types: partially.**
   Pi's loop hooks are a better shape than today's `HarnessInterface`
   (`prepareRequest`, `finishTurn`, `before`/`afterToolCall`, an awaited
   event sink). Borrow the **shape** and keep OMA-owned types. Binding OMA's
   public contract to a pre-1.0 third-party type surface would pass its
   churn straight to harness authors.

## 5. The `pi` harness (implementation)

Code lives in `apps/agent/src/harness/pi/` and is exported as
`@open-managed-agents/agent/harness/pi`:

- `model.ts`: maps OMA credentials to a pi-ai `Model` and stream function.
  - `ant` / `ant-compatible` map to `anthropic-messages`. The `/v1` suffix on the base URL is stripped because the Anthropic SDK appends it.
  - `oai-compatible` maps to `openai-completions`.
  - `oai` maps to `openai-completions`, or to `openai-responses` for a reasoning level above `instant` on gpt-5 or o-series models. This mirrors `resolveModel`.
  - The chat/completions `reasoning_effort: "none"` floor is sent through `samplingParams`.
  - Catalog metadata (context window, max tokens, reasoning, compat) is used when the model id is known.
  - Custom headers are passed through.
  - `credentialsFromLanguageModel()` recovers the key, base URL and headers from an AI SDK model. CF only hands the harness `ctx.model`.
- `messages.ts`: converts `eventsToMessagesAsync` output to pi messages.
  - The projection is shared with `default`, so compaction boundaries, cancelled inputs and `file_id` resolution behave the same. Switching harness mid-session works.
  - Thinking signatures round-trip. `agent.thinking.providerOptions` stores both `pi.thinkingSignature` and the AI SDK `anthropic.signature` / `redactedData` shape.
- `tools.ts`: adapts `ctx.tools` (AI SDK tools) to pi `AgentTool`s.
  - `asSchema()` produces plain JSON Schema. After pi validates, the OMA schema's own `validate` also runs, so zod defaults still apply.
  - Execution always goes through OMA's `execute`, which keeps sandbox, vault proxy, MCP and policy wrappers intact.
  - Output is normalized to OMA wire content exactly like `default`, then to pi text/image blocks.
  - Tools without `execute` (always_ask, custom) return a pending sentinel and never run.
  - OpenAI tool names are capped at 64 characters with `openAiSafeToolName` and mapped back on emit.
- `harness.ts` (`PiHarness`):
  - Reconciles orphaned tool calls, compacts through the platform strategies, and applies the OpenAI 128-tool budget.
  - Rebuilds the transcript, then runs `runAgentLoopContinue` with a leading `SystemMessage` that holds `ctx.systemPrompt` and the tool declarations.
  - Event mapping:
    - Deltas go to `broadcastStreamStart`/`Chunk`/`End`, the Thinking equivalents, and the ToolInput equivalents.
    - When an assistant message completes, the harness persists `agent.thinking` and `agent.message` (with the stream `message_id`) and the tool_use events. It uses default-loop's own `toolCallEvents` / `toolResultEvents` with `idempotency_key`, `execution_class` and `model_request_start_id`.
    - Every provider request gets a `span.model_request_start` / `span.model_first_token` / `span.model_request_end` span with usage. `input_tokens` includes cache reads and writes, the same as default.
  - **Durable execution** reuses `durable-tools.ts`:
    - `reconcileOrphanedToolCalls` and `mergePersistedResults` run before the first model call.
    - `wrapToolsWriteAhead` gates each execute on its tool_use being persisted with `runtime.persist`, and persists the result the moment the tool settles.
    - Validation failures and unknown tools are persisted from `tool_execution_end`.
    - Without `runtime.persist`, the harness falls back to `broadcast`.
  - Pending tools are pushed to `runtime.pendingConfirmations`, and `finishTurn` ends the loop after that turn. This gives the same `requires_action` idle as `default`.
  - Error handling:
    - An abort signal is forwarded and re-thrown.
    - Provider errors become `classifyExternalError` or `ModelError`.
    - An empty turn raises `silent_stop`.
  - The run is capped at 100 steps by default. `keepAliveWhile` is honoured on CF.
- **Registration**:
  - Node: `agent.harness === "pi"` in `apps/main-node/src/index.ts`, using `resolveNodeModelCredentials` for credentials. It needs no host gate, because it runs the same sandboxed platform tools as `default`.
  - CF: `registerHarness("pi", …)` in `apps/agent/src/index.ts`.
  - Console: the harness dropdown in the agent form.

### Known gaps / stubs

- Document/PDF and URL-image inputs, and document tool outputs, become text placeholders. Text-typed documents are inlined. This is a pi-ai content-model limitation.
- LLM request/response body logging to R2 (`env.llmLog`) is not wired. pi-ai's `onPayload` and `onResponse` hooks could implement it.
- The `observingFetch` rate-limit logging and 5-minute stream timeout are not applied. pi-ai's own SDK timeouts and retries (`maxRetries`, `timeoutMs`) apply instead.
- The ZDR Responses→chat fallback and Astra-specific overrides are not ported.
- Compaction uses OMA's AI SDK strategies through `ctx.model`, not Pi's `compact()`.
- Credentials on CF are recovered by introspecting AI SDK model internals. This is defensive but depends on @ai-sdk internals. A cleaner route is an optional `modelCredentials` field on `HarnessContext`.
- The harness has not been smoke-tested against a real provider in this environment (no API key). The CF path was verified only as a bundle build, not run in workerd.
