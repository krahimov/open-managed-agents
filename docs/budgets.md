# Budgets and model usage

Budgets cap what an agent can spend: tokens, estimated cost, wall-clock
time and model calls. Every model call's token usage is also stored
durably, so you can read it per session or per agent. Both runtimes
(Cloudflare `SessionDO` and Node `apps/main-node`) and both loop harnesses
(default AI-SDK loop and Pi) support this.

## Configure

Budgets live at `agent.metadata.budget`. They are versioned with the agent,
and a session keeps the budget of the agent version it started with.

```json
{
  "name": "Researcher",
  "model": "claude-sonnet-4-6",
  "metadata": {
    "budget": {
      "max_tokens_per_turn": 200000,
      "max_tokens_per_session": 2000000,
      "max_cost_usd_per_session": 5,
      "max_turn_wall_clock_seconds": 900,
      "max_steps_per_turn": 40
    }
  }
}
```

| Field | Limit |
|---|---|
| `max_tokens_per_turn` | Tokens across the model calls of one turn |
| `max_tokens_per_session` | Tokens across all turns and threads of the session |
| `max_cost_usd_per_session` | Estimated USD cost of the session |
| `max_turn_wall_clock_seconds` | Time a turn may run before it is aborted (at most 604800, 7 days) |
| `max_steps_per_turn` | Model calls per turn. Replaces the built-in cap of 100 |

- Every field is optional. Leave a field out for no limit.
- A call's token count is `input_tokens + output_tokens`. Input includes
  cached input.
- A turn starts at a client input: `user.message`, `user.tool_confirmation`
  or `user.custom_tool_result`.
- `POST`/`PUT /v1/agents` validate the object. Unknown keys and
  non-positive values are rejected with a 400. Token and step counts must
  be integers. `max_turn_wall_clock_seconds` above 604800 (7 days) is
  rejected.
- To remove a budget on update, send `metadata: { budget: null }`.
- The console agent form has a **Budget (usage limits)** section. An empty
  field means no limit. Anything that isn't a positive number (for example
  `e`) shows an inline error and blocks the save, so a typo can't remove an
  existing limit.

### Tenant daily caps (self-host, Node)

| Env var | Meaning |
|---|---|
| `OMA_TENANT_DAILY_TOKEN_LIMIT` | Tokens per tenant per UTC day |
| `OMA_TENANT_DAILY_COST_USD_LIMIT` | Estimated USD per tenant per UTC day |
| `OMA_MODEL_PRICING` | JSON price overrides, e.g. `{"my-model":{"input_per_mtok":1,"output_per_mtok":2}}` |

Today's usage is read at the start of every harness run. Concurrent
sessions can overshoot a daily cap by about one turn each.

## Enforcement

The harness checks budgets **before every model call**. The default loop
does this before the first call and in `stopWhen`. Pi does it before the
loop and in `finishTurn`.

A call doesn't start when either of these is true:

- The limit has already been reached.
- The projected next call would cross the limit. The projection is the
  previous call's input plus output tokens, which is the least the next
  prompt sends again.

**Compaction.** A compaction summarize call is a model call too. It is
checked against the budget before it starts, its usage is recorded (one
usage row, see below) and it counts toward the token and cost limits. If
it uses up the budget, the turn stops with `budget_exhausted` before the
main model call. It doesn't count toward `max_steps_per_turn`: that limit
caps the agent loop, and counting compaction would leave an agent with
`max_steps_per_turn: 1` unable to answer on a turn that compacts. It also
doesn't change the next-call projection, because the compacted prompt is
smaller.

**Output cap.** When a token limit applies, every model call is sent with
an output cap: `min(configured max output, limit - used - projected
input)` over the per-turn, per-session and tenant-daily token limits. The
default loop sets the AI SDK `maxOutputTokens` per call; Pi sets
`maxTokens`. When the agent configures no max output, the cap is only set
for Anthropic models (the provider clamps it to the model limit) or when
it is at most 4096 tokens, so other providers never get a value above
their model limit. Compaction summaries are capped the same way.

Limits are still predictive, not hard ceilings: input tokens can't be
capped. A call's prompt can be larger than the projection (the previous
call's input + output), for example after a large tool result, and the
first call of a session has no projection. Such a call can cross a limit
by however much its prompt grew; output can't push it further.

The loop only takes another step after tool calls, and those tool calls
already have their results. So a budget stop never leaves a tool call
unresolved. If calls are still waiting on the client, `requires_action`
takes precedence.

The harness then persists a `session.warning`:

```json
{ "type": "session.warning", "source": "budget_exhausted",
  "message": "Budget exhausted: max_tokens_per_turn (used 2,200 of 3,000 tokens). …",
  "details": { "budget": "max_tokens_per_turn", "limit": 3000, "used": 2200 } }
```

The runtime turns that marker into the turn's terminal idle:

```json
{ "type": "session.status_idle",
  "stop_reason": { "type": "budget_exhausted", "budget": "max_tokens_per_turn",
                   "limit": 3000, "used": 2200 } }
```

`budget` can be any field in the table above, `tenant_daily_tokens` or
`tenant_daily_cost_usd`. `used` is the actual usage when the turn stopped.

**Wall-clock.** The runtime arms a timer when the turn starts. Delays
above the platform timer limit (2^31-1 ms, about 24.8 days) are re-armed
in chunks, so an older agent version saved with a longer limit doesn't
fire immediately. When it
fires, the turn is aborted the same way as `user.interrupt`: the Node
`SessionStateMachine` abort, or the thread `AbortController` on CF. The abort
reason carries the budget. Tool calls the abort cut off get an error
result, `(stopped: the turn's wall-clock budget was exhausted)`. The turn
then ends with the warning and `budget_exhausted`, and no `session.error`
is written. On Node, a resumed turn keeps its original start time.

**Crash safety.** Usage comes from the event log: one
`span.model_request_end.model_usage` per call, keyed by
`model_request_start_id`. A resumed turn rebuilds the same totals, so a
crash can't reset a budget.

A call's usage span is made durable as soon as the provider response is
complete, not when the step ends:

- **Default loop.** A middleware on the provider stream persists the span
  when the provider's finish part arrives. The step's tools are gated on
  it, so they only start once the span is durable, and the step's final
  reply (`step_final`) is written after it.
- **Pi.** When an assistant message ends, its span is persisted before the
  message's thinking, text and tool calls, so before any tool runs.

An abort during a tool (wall-clock budget, `user.interrupt`) or a crash
right after the final reply can't lose a call that completed. A step whose
response completed gets exactly one end span. The abort and error paths
don't write a second one without usage. The stop marker is durable, so a crash between
the marker and the idle still ends the turn with `budget_exhausted`.
Only the model loop ends; step checkpoints and write-ahead tool execution
work as described in [durable-execution.md](durable-execution.md).

Wall-clock is enforced by the runtime, so it works with every harness.
The token, cost and step budgets are enforced by the default and Pi
harnesses. Delegating harnesses (`claude-agent-sdk`, `codex-sdk`,
`acp-proxy`) don't enforce them.

## Usage recording

There's one durable row per model call in `model_usage_events`:

| Column | Content |
|---|---|
| keys | tenant, session, agent, thread, turn (the turn input's event id), `model_request_start_id`, model |
| usage | input, output, cache-read and cache-write tokens |
| `cost_usd` | Estimated cost |
| `billed_at` | For a hosted reconcile, same pattern as `usage_events` |

Rows are unique on `(session_id, model_request_start_id)`. Writes use
`INSERT … ON CONFLICT DO NOTHING`, and every run first backfills rows the
log implies but the table is missing. A crash between persisting the span
event and inserting the row is repaired and never counted twice. The
backfill also runs when a turn ends without running the harness: on Node
when a reclaimed turn is finalized from the log or was already finished
(`SessionStateMachine` `reconcileUsage`), and on CF when stale-turn
finalization ends a turn.

Metered compaction calls get rows too. Their
`span.compaction_summarize_end` carries `model_request_start_id` (the id
of the matching `span.compaction_summarize_start`), `model_usage` and
`cost_usd`. Compaction spans written before this change have no id and
stay uncounted.

- **Node.** `NodeHarnessRuntime.onPersisted` writes the row after the span
  event is stored (`apps/main-node/src/lib/node-model-usage.ts`). It works
  on SQLite and Postgres through Drizzle migrations: `0006_model_usage_events`
  for SQLite and `0009_model_usage_events` for Postgres.
- **CF.** `SessionDO` writes rows to the tenant's D1 from the span hook,
  through `apps/main/migrations/0020_model_usage_events.sql`.

The resource-seconds `usage_events` table is unchanged.

**Cost.** The harness puts `cost_usd` on every `span.model_request_end`.
The price comes from the provider model it actually called, not a
model-card handle. Prices come from `DEFAULT_MODEL_PRICING` in
`packages/session-runtime/src/budget.ts` (Anthropic first-party list
prices), which you can override with `OMA_MODEL_PRICING`. Unknown models
record tokens with `cost_usd: null` and never trip cost limits. Model
cards have no column for prices yet.

## Read usage

```bash
curl $BASE/v1/sessions/$SID/usage -H "x-api-key: $KEY"
curl "$BASE/v1/agents/$AID/usage?days=7" -H "x-api-key: $KEY"   # or ?since=<ISO|ms>
```

Both endpoints return a `ModelUsageReport`:

| Field | Content |
|---|---|
| `totals` | Model calls, token counts, `cost_usd` and `unpriced_calls` |
| `by_model` | The same totals for each model |
| `budget` | The configured budget |

The console session header shows a usage chip. Click it for the per-model
breakdown and the budget. A budget stop shows as a **Budget exhausted**
notice in the conversation.

`/v1/cost_report` is a separate report of Cloudflare infrastructure cost
from CF analytics. It doesn't include model tokens.
