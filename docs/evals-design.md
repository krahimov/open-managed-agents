# Evals v2 — Outcome-Based Evaluation Design

Status: **accepted** (2026-07-24). Owner: platform. Supersedes nothing — extends the
existing eval-core / evals-runner / evals-store stack.

## 1. Philosophy

General agents cannot be meaningfully verified by deterministic assertions: agents
regularly find valid approaches the eval author didn't anticipate, and over-specified
checks punish them for it. OMA evals are therefore **outcome-based and LLM-judged**,
with three commitments:

1. **The trace is the deterministic backbone.** Every agent step is already logged
   (session events: `agent.message`, tool_use/tool_result pairs, `span.model_request_*`
   with token usage, errors). The eval system never re-instruments — it consumes the
   event log, mechanically extracts **trace facts**, and shows the full trace inside
   the eval view.
2. **An LLM judge produces the verdict.** The judge is switchable across models AND
   reasoning levels, independent of the agent under test. Default judges are top-tier:
   e.g. `gpt-5.6-sol` at `max`, `claude-opus-4-8` at `max`, Claude Fable 5 at
   `high`/`max` — whichever cards the tenant has. Cross-family judging (Claude judges
   GPT agents and vice versa) is preferred: it measurably reduces self-preference bias.
3. **Authored deterministic checks stay minimal.** Exit codes, tool-was-called,
   file-exists — fine as cheap *hard gates* that short-circuit before spending judge
   tokens. Nothing beyond that. Machine-*extracted* trace facts, by contrast, are
   maximal: they're free, objective, and double as judge evidence and UI content.

### 1.1 Comparison with Anthropic Managed Agents (researched 2026-07-24)

AMA ships a runtime self-verification loop ("outcomes": `user.define_outcome` +
rubric + grade-and-revise, grader in a separate context window) but **no offline eval
system** — no suites, no regression runs, no version/model comparison, no pass@k
aggregation. Their grader is **locked to the writer's model** and **sees only the
artifact, never the transcript** (deliberate: avoids the judge anchoring on the
agent's self-narrative, keeps grading outcome-based).

What we adopt from them:

- **Rubric contract** (their cookbook): per-criterion, independently checkable,
  evidence demanded, "anticipate shortcuts" and "tell the grader what to ignore"
  clauses. This becomes our rubric template (§4.3).
- **pass@k vs pass^k** as the two aggregate metrics over trials (their engineering
  guidance, unimplemented in their product).
- **Anti-anchoring**: the judge does NOT read the agent's prose/reasoning.

Where we deliberately diverge:

- **Judge configurability**: judge = any `{model_card, reasoning_level}`, not the
  writer's model. Their own guidance says judge model choice matters (Opus-class
  judges hit r≈0.93–0.96 agreement with humans); their product ignores it.
- **Artifact + trace facts, not artifact-only**: the judge's primary input is the
  artifact/final output + rubric (their model), but it *additionally* receives
  code-extracted trace facts (tools called, exit codes, errors, cost, files touched).
  Facts extracted by code can't anchor the judge the way agent narrative can, and
  they catch "right artifact, destructive process" — the failure mode artifact-only
  grading misses.
- **Offline suites, regression, matrix runs exist here** (evals-runner) — AMA only
  blogs about them.

Note: our runtime revise-loop (missions/outcome-supervisor, `LlmJudgeVerifier`) is
the AMA-outcomes analog. The same judge machinery (§4) backs both consumers.

## 2. Existing machinery (inventory — do not rebuild)

| Piece | Where | State |
|---|---|---|
| Trajectory v1 envelope (events + summary + outcome + reward) | `packages/eval-core/src/trajectory/`, spec `docs/trajectory-v1-spec.md` | shipped |
| `TrajectorySummary` (num_turns, tool_calls, tool_errors, duration, token_usage) | trajectory builder | shipped — seed of trace facts |
| Verifier framework: `RewardSpec` = `script \| reward_model \| composite \| verifiable`; `verifierForSpec()` registry | `packages/eval-core/src/verifier/` | shipped |
| Scorers: `bashExit`, `bashSuccess`, `fileWritten`, `toolUsed`, `toolNotUsed`, `idleNoError`, `regex`, `agentMessageContains`, `all/any/weighted`, `judge(rubric, {apiUrl,apiKey,model})` | `packages/eval-core/src/scorers/scorers.ts` | shipped |
| `LlmJudgeVerifier` (in-process JudgeFn, satisfied/needs_revision, usage propagation) | `packages/eval-core/src/verifier/builtins/llm_judge.ts` | shipped — used by outcome-supervisor; **not reachable from serialized RewardSpec** |
| Eval runner: task = fresh session, setup_files/setup_script via /exec, multi-message, trials, timeout, trajectory→KV, verifier→reward, cron tick both runtimes | `packages/evals-runner/src/tick.ts` | shipped, **never exercised on prod** |
| Routes `POST/GET/DELETE /v1/evals/runs` | `packages/http-routes/src/evals/` | shipped |
| Console Eval Runs page; eval sessions tagged `metadata.eval={run_id,task_id}` | `apps/console` | shipped (list-level only) |
| Per-agent `reasoning_level` `instant\|low\|medium\|high` + `reasoningProviderOptions()` + Responses-API routing + adaptive-thinking gate | `apps/agent/src/harness/provider.ts` | shipped 2026-07 |

Gaps this design closes: no serializable LLM-judge spec; judge model/level not
configurable; judge input is agent-message text only (anchoring risk, no artifact
focus, no trace facts); no evidence citations; no per-criterion verdicts; no
`max` reasoning tier; no pass@k/pass^k; console shows runs but not traces/verdicts.

## 3. Reasoning tier `max` (Phase 1)

Add `max` to `REASONING_LEVELS`: `instant | low | medium | high | max`.

- OpenAI Responses models: `max → reasoning_effort: "xhigh"` (SDK supports it).
- Anthropic ≥4.8/5.x (adaptive gate): `max → effort: "max"`.
- Anthropic ≤4.7 (budget shape): `max → budgetTokens: 65536` (high stays 32768).
- Console selector, wire validation, YAML round-trip, session override: mechanical
  extensions of the existing enum. Agents may use `max` too — not judge-only.

## 4. The judge (Phase 2)

### 4.1 Serializable spec

New `RewardSpec` branch (registry gains one case):

```jsonc
{
  "type": "llm_judge",
  "rubric": "## Criteria\n- ...",            // markdown, per-criterion (see 4.3)
  "judge": {
    "model_card_id": "card-...",              // tenant model card; default: resolver picks
    "reasoning_level": "max",                 // default "max"
    "cross_family": true                      // default true: prefer a judge from a
  },                                          //   different provider than the agent
  "include_transcript": false                 // escape hatch; default false (see 4.4)
}
```

`LanguageModel` handles aren't serializable, so resolution happens at the consumer:
the runner (and outcome-supervisor) resolve `judge` → a `JudgeFn` via the existing
`resolveModel(...)` + `reasoningProviderOptions(...)` and pass it into a new
`LlmJudgeVerifier` v2 constructor. eval-core stays a leaf package (no `ai` import).

Default judge resolution order (when `model_card_id` omitted): highest-tier card of
a *different* provider family than the agent's model, at `max`; else same-family
highest tier. Resolution is recorded in the verdict (`judge_model_id`,
`judge_reasoning_level`) so runs are reproducible/comparable. **Pin per suite**: a
suite stores its resolved judge config on first run; changing it is a deliberate
re-baseline, not a silent drift.

### 4.2 Judge input = artifact + rubric + trace facts

The judge prompt contains, in order:

1. **Task description** (the eval task's messages).
2. **Rubric** (verbatim).
3. **Artifact**: the agent's final message(s) + contents/listings of files the agent
   wrote in the workspace (from trace facts; fetched via /exec `cat`/`ls` with a
   size budget, binary files listed not inlined).
4. **Trace facts** (§5): machine-extracted, formatted as a terse table. Explicitly
   labeled "extracted by code, not by the agent".
5. **NOT included**: the agent's thinking, its intermediate prose, its
   self-assessment. (`include_transcript: true` overrides for tasks where the
   conversation itself is the artifact, e.g. tone evals.)

### 4.3 Verdict schema (structured output, per-criterion, evidence-cited)

```jsonc
{
  "criteria": [
    { "id": "revenue-5yr", "pass": true,
      "evidence": ["sevt_abc123", "file:/workspace/model.xlsx"],  // event ids / artifact refs
      "reasoning": "..." }
  ],
  "pass": true,                 // all criteria pass
  "score": 0.92,                // weighted fraction of criteria passed
  "summary": "..."
}
```

Maps to the existing `Score` shape: `value = score`, `metadata.criteria =
{<id>: 0|1}` (the runner already persists per-criterion `raw_rewards`),
`metadata.verdict = <full object>`, `metadata.usage = <judge tokens>`. Evidence ids
become clickable links in the console (→ timeline event). A criterion without
evidence is rendered as unverified in the UI — rubrics must demand evidence.

Rubric template (enforced by docs + console helper, not by code): per-criterion
`id`, independently checkable, concrete proof required, an "ignore" section, an
"anticipated shortcuts" section.

### 4.4 Hard gates before the judge

`composite` already supports this: `{type:"composite", components:[{verifier:
{type:"verifiable",scorer:"idleNoError"},weight:0,name:"gate:no-error"},
{verifier:{type:"llm_judge",...},weight:1,name:"judge"}]}`. Add one behavior:
a component named `gate:*` scoring 0 **short-circuits** — remaining components are
skipped (no judge tokens on a crashed trial) and the trial scores 0 with the gate
as reason. This is the entire sanctioned surface for authored deterministic checks.

## 5. Trace facts (Phase 3)

Pure function `extractTraceFacts(trajectory): TraceFacts` in eval-core, superset of
`TrajectorySummary`:

```ts
interface TraceFacts {
  outcome: TrajectoryOutcome;               // success/failure/timeout/interrupted
  turns: number; duration_ms: number;
  token_usage: {...}; est_cost_usd?: number;
  tools: Array<{ name: string; calls: number; errors: number }>;
  exec_commands: Array<{ command_head: string; exit_code: number; event_id: string }>;
  files_written: Array<{ path: string; event_id: string }>;
  errors: Array<{ event_id: string; message_head: string }>;
  repeated_call_loops: Array<{ tool: string; count: number }>;  // same tool+args ≥3×
}
```

Stored on the trajectory (`trajectory.trace_facts`), rendered in the eval UI,
serialized into the judge prompt. Every entry carries the source `event_id` so both
the judge's citations and the UI deep-link into the timeline.

## 6. Metrics: pass@k and pass^k (Phase 3)

A trial **passes** iff `final_reward >= pass_threshold` (task-level, default 1.0 —
judge `pass` maps to 1). Per task, over k trials, report both:

- `pass@k` — ≥1 trial passed (capability view),
- `pass^k` — all trials passed (reliability view),
- mean reward ± std.

Run-level rollups aggregate across tasks. Runner already tracks
`trial_pass_count/trial_total`; this adds the two derived numbers to
`EvalTaskResult` and the run record. (Today a task with any failed trial is marked
`failed` — keep the status but the metrics make partial success visible.)

## 7. Console (Phase 4)

- **Run detail**: per task × trial grid (reward, pass@k/pass^k chips, duration,
  cost). Trial click →
- **Trial detail**: embedded session **Timeline** (reuse SessionDetail components —
  eval sessions are ordinary sessions, already tagged) + **verdict card**:
  per-criterion pass/fail with evidence links that scroll the timeline to the cited
  event, judge model/level badge, judge token cost + **trace-facts panel**.
- **Run create / suite editor**: judge selector (model card × reasoning level,
  defaulting per §4.1), rubric editor with the template pre-filled.
- **Re-grade** button: re-run only the verifier on stored trajectories with a
  different judge config (the `verifier_id`-on-reward design was built for this) —
  cheap judge-comparison without re-executing agents.

## 8. Later (designed, not in this build)

- **Save-as-eval**: snapshot a live session (first user message + workspace inputs)
  into an `EvalTaskSpec`; author a rubric from what "good" looked like.
- **Regression binding**: suites attached to an agent; version bump → run → compare
  to the pinned baseline run.
- **Matrix runs**: same suite × {model_card × reasoning_level} grid over the agent
  under test (judge pinned), rendered as a comparison table.
- **Judge calibration set**: ~20 human-labeled trajectories per tenant; report
  judge-human agreement when the judge config changes.

## 9. Build order

| Phase | Scope | Touches |
|---|---|---|
| 0 | End-to-end validation of the existing runner on prod (2-task suite, sol-smoke-agent) — fix what breaks | none (or bugfixes) |
| 1 | `max` reasoning tier | api-types, provider.ts, http-routes, console, tests |
| 2 | `llm_judge` RewardSpec + judge resolution + verdict schema + gate short-circuit | eval-core, evals-runner, main-node/session-do (judge resolver), http-routes validation |
| 3 | `extractTraceFacts` + judge-prompt assembly + pass@k/pass^k | eval-core, evals-runner |
| 4 | Console: trial detail w/ timeline + verdict card + judge selector; re-grade | console, http-routes |

Non-goals: new tracing infrastructure (the event log is the trace); rich authored
assertion DSLs; judging from the agent's self-narrative.
