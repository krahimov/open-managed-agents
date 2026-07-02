# OMA vs Anthropic Managed Agents — gap analysis (2026-07-01)

Compared against Anthropic's shipped state as of July 2026: the Managed
Agents API beta (`managed-agents-2026-04-01`), Claude Code cloud sessions +
routines, Claude Tag in Slack, Cowork, memory stores + Dreams, Skills, and
the Agent SDK hosting patterns. Sources: platform.claude.com/docs
(managed-agents overview, scheduled-deployments), anthropic.com/news
(introducing-claude-tag), anthropic.com/engineering/managed-agents,
code.claude.com/docs (routines, slack, github-actions, agent-sdk/hosting).

## Where OMA is strong (parity or ahead)

- **Core API shape** — agents / sessions / events-over-SSE / environments /
  vaults / model cards / memory stores / skills mirror the Managed Agents
  API concepts one-for-one, and the architecture matches Anthropic's own
  published design (stateless harness + append-only session log + sandbox
  as tools + wake-based recovery). Verified live: session turns with bash
  tool calls on the Node runtime; 1644 root tests green on the deployments
  branch.
- **Self-host + sandbox choice** — Anthropic's managed environments are
  their cloud only (plus a self-hosted-sandbox escape hatch). OMA runs the
  whole platform on your infra with five sandbox providers. This is the
  structural differentiator; Anthropic explicitly tells SDK users to use
  Managed Agents when they *don't* need infrastructure control.
- **Pluggable harnesses** — `default` (AI-SDK loop), `claude-agent-sdk`
  (Claude Code as the loop), ACP proxy. Anthropic's harness is closed.
  Nobody else offers "bring your own agent loop" on a managed substrate.
- **Linear as a first-class surface** — Anthropic has NO first-party Linear
  agent (their Linear story is an MCP connector; assignable agents exist
  only via third parties). OMA's Linear publications + dispatch rules +
  event queue are ahead of Anthropic here.
- **Credential isolation** — vault outbound injection (tokens never enter
  the sandbox) is the same design Claude Tag ships ("credentials stay out
  of the sandbox", default-deny egress). OMA had this before Claude Tag
  launched.
- **Slack @mentions** — the pipeline (manifest → per-tenant app → OAuth →
  signed webhooks → thread sessions → bot replies via Slack MCP) exists
  and is tested (104 unit tests). See `docs/slack-agent-mentions.md` for
  the Claude Tag parity table.

## Where OMA is behind (ranked by product impact)

1. **Billing / entitlements (hosted)** — Anthropic bills plans + usage
   credits. OMA's `codex/billing-subscription-plan` branch is a *design
   doc* (all 13 implementation tasks unchecked). Worse, the substrate is
   CF-only: `usage_events` are recorded only by the CF `apps/agent`
   runtime, and the `/v1/internal/usage_events` reconcile API exists only
   in `apps/main` — the Node runtime (Railway production) records nothing
   and exposes no reconcile surface. Any paid hosted launch is blocked on
   this.
2. **Agent-level scheduled deployments** — Anthropic: cron + IANA timezone,
   1,000/org, deployment-run records with typed errors, pause/unpause,
   manual `run` endpoint. OMA: session-level wakeups only (the `schedule`
   tool; Node support just landed on `feat/node-session-wakeups`). Missing:
   "run this AGENT every morning in a FRESH session" as an API/console
   object with run history. This is the exact shape of "check my email
   every day" and the natural next step on top of the new wakeup pump.
3. **Routine-style event triggers + fire API** — Anthropic routines fire on
   GitHub PR/release events with rich filters, and every routine has a
   `POST …/fire` endpoint with a bearer token for arbitrary external
   triggering. OMA has provider-specific queues (Linear/GitHub/Slack) but
   no generic "fire this agent with this payload" endpoint — closest is
   POST /v1/sessions + POST events, which is two authenticated calls and
   no per-trigger token.
4. **Claude Tag polish on Slack** — live-updating checklist first reply
   (`chat.update`), "open session" deep link back to the console,
   channel-scoped memory, per-channel spend caps + audit. Core mention flow
   exists; the collaboration UX layer doesn't.
5. **Memory consolidation** — Anthropic's memory stores ship with "Dreams"
   consolidation (research preview). OMA has stores + retention sweeps but
   no consolidation pass.
6. **Multi-replica scale-out** — the Node session work queue is
   single-instance by design (croner in-process, SQLite single-writer;
   Postgres mode shares the queue but there's no coordinator). Anthropic's
   engineering post describes horizontal harness scaling. Fine for alpha;
   a ceiling for growth.
7. **Ops robustness debt (small but real)** — current branch has test-env
   drift (`schedule-wakeup` integration tests need the billing branch's
   `wrangler.test.jsonc` MAIN_DB binding; `core.test.ts` has 9 pre-existing
   failures here while the billing branch is green); the SDK harness's
   in-child `ScheduleWakeup`/CronCreate tools accept calls that can never
   fire (per-turn child exits — should be disallowed or bridged to the
   platform wakeup store); console duplicate-agent-per-session bug.

## Recommendations (order of attack)

1. Ship Node usage recording + reconcile API (unblocks the billing plan;
   the doc's architecture is sound — Stripe hosted overlay, OSS emits
   usage + checks entitlements).
2. Build `agent_schedules` (cron → fresh session per run + run records +
   pause) on top of the new wakeup pump; expose in console. This is
   Anthropic's scheduled-deployments shape and closes the ambient story.
3. Add per-agent `POST /v1/agents/:id/fire` with per-trigger bearer tokens
   (routines-API parity; also gives Zapier/n8n-style integrators a
   one-call hook).
4. Slack polish: session deep link, checklist via `chat.update`,
   channel-scoped memory binding.
5. Fix the SDK-harness false-promise scheduling tools (map them onto the
   platform wakeup store via an in-process MCP, or strip them from the
   child's toolset).
