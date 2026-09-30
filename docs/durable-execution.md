# Durable tool execution

How the default harness (`apps/agent/src/harness/default-loop.ts`) keeps
agent execution crash-proof: write-ahead tool calls, step checkpoints, and a
class-aware recovery policy. Shared by the Cloudflare (`SessionDO`) and Node
(`apps/main-node`) runtimes.

## Guarantees

1. **Write-ahead intent.** A tool's `execute` never starts before its
   `agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use` event is
   durably in the session event log (`HarnessRuntime.persist`). All of the
   step's reasoning/text that came before the call is persisted first, so the
   log order is the model's output order. If the intent can't be persisted,
   the tool doesn't run.
2. **Immediate result.** The `agent.tool_result` / `agent.mcp_tool_result`
   is persisted as soon as the tool settles (result or throw). It isn't held
   back until the end of the step. `onStepFinish` only emits what the
   write-ahead path didn't (trailing text, SDK-generated tool errors, spans),
   so every event is written exactly once.
3. **Step checkpoints.** Completed steps (assistant content, tool_use and
   tool_result) are durable when they finish. A resumed or retried turn
   rebuilds model context from the log: completed tools are **not** re-run
   and the user message is **not** re-sent.
4. **One result per call.** A process-wide in-flight registry makes sure an
   in-process retry waits for a still-running call and never writes a second
   result for it.

What stays **at-least-once**:

- A tool whose process died while it was running. The side effect may or may
  not have happened. Recovery never repeats it automatically. The model is
  told the outcome is unknown and gets the idempotency key.
- Model calls. An interrupted model step is re-sampled, and streamed text
  that wasn't committed is lost (only a partial `agent.message` from the
  streams table survives).
- Idempotent tools, which are re-executed on recovery by design.
- Sub-agent (`call_agent_*`) runs. The child history is in memory, so a crash
  mid-child loses the child's progress (the call is `side_effect`).

## Execution classes

`packages/session-runtime/src/tool-classification.ts` (`classifyTool`).
The harness stamps the class on the tool_use event as `execution_class`.

| class | tools | on crash |
|---|---|---|
| `idempotent` | `read`, `glob`, `grep`, `web_fetch`, `web_search`, `list_schedules`, `list_ambient_rules`, `find_skill`, `search_mcp_tools`, `browser_screenshot`, `browser_get_text`, MCP tools annotated `readOnlyHint: true` or `idempotentHint: true` | re-executed by the harness, or the model is told it is safe to re-run |
| `side_effect` | `bash`, `write`, `edit`, `schedule`, `cancel_schedule`, `call_agent_*`, `general_subagent`, unannotated MCP tools, everything unknown | `is_error` result: "started, crashed before completion, it MAY have taken effect, verify before retrying", plus the idempotency key |
| `client` | custom tools (no server `execute`), tools parked on `evaluated_permission: "ask"` | untouched. The client or user supplies the result, and the server never invents one |

MCP annotations are read from the server's `tools/list` response
(`buildTools` uses `listTools()` + `toolsFromDefinitions()` so they survive).

## Recovery policy

`recoverInterruptedState(streams, log, { deferIdempotent })`
(`packages/session-runtime/src/recovery.ts`) handles every tool_use that has
no result:

- `side_effect`: appends the outcome-unknown error result.
- `idempotent`: appends a "safe to re-run" error result. With
  `deferIdempotent`, it leaves the call unresolved, lists it in
  `pendingReexecution`, and the default harness re-executes it before the
  next model call.
- `client`: appends nothing and returns a `custom_tool_call_interrupted`
  warning.

Every decision is returned in `report.recoveredToolCalls` and as
`session.warning` entries (`source: "tool_call_interrupted"`, with `action`,
`execution_class` and `idempotency_key` in `details`).

On every run, `DefaultHarness.run` first calls `reconcileOrphanedToolCalls`
(`apps/agent/src/harness/durable-tools.ts`). This is the harness-side half of
recovery and runs on every runtime:

- It waits for calls that are still in flight in this process.
- It re-executes idempotent orphans.
- It writes outcome-unknown results for side-effect orphans.
- It leaves client calls alone.

When it did anything, it emits a `session.warning` (`source: "tool_call_recovered"`).

### Resuming the turn

- **Cloudflare.** Cold-start recovery runs in `ensureSchema`. Stale-turn
  finalization (`_finalizeStaleTurns`, from the first fetch or the alarm) only
  reconciles tool calls when this incarnation has no live turn: with
  write-ahead, a running tool looks exactly like an orphan. Auto-resume is
  **opt-in**: set `OMA_AUTO_RESUME_TURNS=1` or agent
  `metadata.auto_resume_turns: true`. It only applies to the default harness.
  It's opt-in because the resume drains through a path that can run inside
  `alarm()`. When enabled, idempotent orphans are deferred and a
  `system.turn_resume` event is enqueued. The turn is resumed when the
  interrupted turn's tail is a tool result, a non-client orphan, or the bare
  user message. It is not resumed when the tail is assistant text/thinking or
  a client-owned call, and there are at most 3 resumes per user message. The
  drain runs it as a resume turn (`processUserMessage(…, skipAppend)`), so the
  user message isn't re-sent. Otherwise the turn is closed with
  `status_rescheduled` + `status_idle` and the user re-sends.
- **Node.** `SessionStateMachine.onWake` runs the shared recovery, and the
  leased work queue re-runs the interrupted work item. Because the harness
  derives context from the log, that re-run resumes from the last durable
  step.

## Idempotency-key contract (for tool authors)

- Key: `idempotency_key = "${session_id}:${tool_use_id}"`
  (`idempotencyKeyFor`). It's minted once, when the model emits the call, and
  stored on the tool_use event before execution. It stays the same across
  in-process retries, crash recovery, turn resume and confirmation replays.
- **MCP tools:** `tools/call` requests carry
  `params._meta.idempotency_key` and an `Idempotency-Key` HTTP header.
  Servers with side effects should dedupe on it.
- **Sub-agents (`call_agent_*`, `general_subagent`):** the key is recorded on
  `session.thread_created`. Re-invoking the same call returns the finished
  child's answer instead of spawning a new child. An unfinished child is
  re-spawned with `retry_of_thread_id`.
- **bash:** not injected yet. The `SandboxExecutor` has no per-command env,
  and prefixing the command string would break command-secret matching and
  compound commands. This needs an `exec(command, timeout, { env })` port
  extension to export `OMA_IDEMPOTENCY_KEY`.
- **Custom tools:** the key is on the `agent.custom_tool_use` event. Clients
  should dedupe on it when they execute.

## Runtime interface

`HarnessRuntime.persist?(event): Promise<void>` is a durable append that
shares ordering with `broadcast`. It resolves once the event is persisted and
rejects on failure.

- CF: synchronous SQLite append, then `ctx.storage.sync()`.
- Node: `NodeHarnessRuntime.persist` awaits the SqlEventLog write chain.

Without `persist`, the harness falls back to `broadcast`: ordering is kept,
durability isn't guaranteed.

## Event fields (additive, optional)

- On tool_use events: `idempotency_key`, `execution_class`,
  `model_request_start_id`.
- On `agent.message` and `agent.thinking`: `model_request_start_id`.
- On `agent.tool_result`: `is_error`.
- New internal pending-queue event: `system.turn_resume`. It isn't in the
  Anthropic spec set, is hidden from wire-compat SSE, and the console ignores
  it.

The history projection uses `model_request_start_id` to keep one model step
in one assistant message. That matters when results were persisted between
the step's parallel tool calls. Legacy events that don't have the field keep
the old grouping.

In-turn compaction (`prepareStep`) is not implemented. Compaction still runs
only at turn start.
