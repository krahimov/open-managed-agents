---
name: openma
description: >
  Use the openma platform to build, deploy, and manage AI agents. Trigger when
  users want to create agents, start sessions, manage environments, configure
  model cards, handle vaults/credentials, install skills, connect MCP servers,
  set up ambient (scheduled/event-driven) agents, control agent permissions,
  configure outbound webhooks, choose a harness, or interact with the openma
  HTTP API. Also trigger when users mention "oma", "openma", "managed agents",
  "ambient rules", "agent permissions", or ask how to deploy/run/manage an
  agent on openma.
---

# openma

openma is an open-source platform for building, deploying, and managing AI agents.
You define an agent (model + system prompt + tools), the platform handles sandboxed
execution, credential management, session state, standing ambient rules, and
access control.

## Setup

```bash
npx open-managed-agents            # or: npm i -g open-managed-agents
export OMA_BASE_URL=https://your-instance.example.com
export OMA_API_KEY=oma_xxxxxx      # generate at Console → API Keys
```

Run `oma --help` for all commands. The HTTP API is the source of truth — newer
features (ambient rules, grants, skills store, webhooks) may land there before
the CLI grows a command; call them with any HTTP client using the `x-api-key`
header.

## Core Workflow

```bash
oma agents create "my-agent" --model claude-sonnet-4-6
oma envs list                      # reuse existing, or:
oma envs create default
oma sessions create --agent <agent-id> --env <env-id>
oma sessions message <session-id> "Your task here"
```

The recommended creation flow is now **setup sessions** (below): create a
minimal agent, then let the agent refine its own configuration in a
conversation.

## Resources

| Resource | Surface | Purpose |
|----------|---------|---------|
| Agent | `oma agents ...` / `/v1/agents` | Model + prompt + tools + harness config |
| Environment | `oma envs ...` / `/v1/environments` | Sandbox runtime for sessions |
| Session | `oma sessions ...` / `/v1/sessions` | Conversation with an agent |
| Ambient Rule | `/v1/agents/:id/ambient-rules` | Standing trigger that wakes the agent in the background |
| Access Grant | `/v1/agents/:id/grants` | Versioned permission policy over the agent's tools |
| Model Card | `oma models ...` / `/v1/model_cards` | LLM API key + provider config |
| Vault | `oma vaults ...` / `/v1/vaults` | Secure credential storage |
| Credential | `oma creds list`, `oma secret add` | Secret inside a vault |
| Skill | `/v1/skills` | SKILL.md documents auto-loaded into agent sessions |
| Webhook Endpoint | `/v1/webhook_endpoints` | Signed session-state notifications to your URL |
| API Key | `oma keys ...` | Auth token for CLI/SDK |
| Linear / Slack / GitHub | `oma linear ...` + console | Publish agent into a third-party tool |

## Setup Sessions — the agent configures itself

Creating an agent no longer means hand-writing the perfect config. Create a
minimal agent, then start a session with `metadata: { "oma_setup": true }`:

```
POST /v1/sessions
{ "agent": "<agent-id>", "environment_id": "<env-id>", "metadata": { "oma_setup": true } }
```

In a setup session the agent runs a focused planning conversation with exactly
one tool, `update_harness` — it interviews the user about what it should do,
then rewrites its own name, description, system prompt, model, MCP servers,
and skills, live. No file/shell/web access in this mode. The console does this
automatically on "Create agent"; from the API it's just the metadata flag.

## Harnesses

The harness is the loop that drives the agent. Set per agent via
`_oma.harness` on create/update, or deployment-wide via `OMA_DEFAULT_HARNESS`.

| Harness | What it is |
|---------|-----------|
| (default) | OMA's own loop: platform tools, MCP wiring, compaction, sub-agents |
| `claude-agent-sdk` | Delegates the loop to headless Claude Code on the host. Subscription billing (CLAUDE_CODE_OAUTH_TOKEN) instead of API credits. Self-host only — gated behind `OMA_ENABLE_CLAUDE_AGENT_SDK=1`; never enable on a shared multi-tenant deploy. |
| `acp-proxy` | Proxies to a user-registered local ACP runtime (`_oma.runtime_binding` required) |

## Ambient Agents — schedules and event triggers

Ambient rules make an agent act without a human starting the session. Each
firing **spawns a fresh session** via the dispatcher.

```
POST /v1/agents/:id/ambient-rules
{
  "name": "daily triage",
  "trigger": { "source": "schedule", "config": { "cron": "0 9 * * 1-5", "timezone": "UTC", "prompt": "Triage the inbox." } },
  "wake_mode": "decide",
  "enabled": true
}
```

- Trigger sources: `schedule`, `webhook`, `slack`, `teams`, `github`, `linear`,
  `email`, `memory`, `file`, `manual`.
- Wake modes: `observe` | `decide` (default) | `act` | `escalate` — how much
  initiative the woken agent takes.
- Schedule rules arm themselves: create/update computes the first
  `next_wake_at` from the cron, so you never need to set it manually.
- Spawned sessions inherit the agent's `default_vault_ids` (MCP credentials
  work in background runs).
- Full CRUD: `GET/POST /v1/agents/:id/ambient-rules`,
  `GET/PATCH/DELETE /v1/agents/:id/ambient-rules/:ruleId`.

**Agents can wire their own crons from chat.** The default toolset includes
`create_ambient_rule` / `list_ambient_rules` / `delete_ambient_rule` — tell an
agent "check this every morning" and it creates the rule itself.

**Same-session wakeups** are different: `schedule` / `cancel_schedule` /
`list_schedules` tools re-wake the *current* session with a prompt at a later
time (one-shot or cron). Use wakeups for "continue this work later", ambient
rules for "standing background job".

## Access Control — agent permissions

Versioned permission grants restrict which tools an agent can use. Rules are
data evaluated by deterministic code — deny/ask/allow with glob selectors over
the tool namespace; most-specific selector wins, `deny > ask > allow` on ties.

```
PUT /v1/agents/:id/grants/baseline
{
  "rules": [
    { "effect": "allow", "selector": "mcp__linear__get_*" },
    { "effect": "deny",  "selector": "mcp__linear__delete_*" },
    { "effect": "deny",  "selector": "bash", "description": "no shell" }
  ],
  "approved_by": "<user-id>"        // taken from auth context when present
}
```

- `deny` removes the tool from the model's world entirely (it can't see it);
  `ask` surfaces the call as pending for confirmation.
- Grants are append-only versions with an approver stamp —
  `GET /v1/agents/:id/grants` returns the active baseline + history.
- The policy is **pinned into the session snapshot at create time**: editing a
  grant affects sessions started afterward, never running ones.
- Enforced on both harnesses (default loop and claude-agent-sdk).

## Skills

Store any SKILL.md and it auto-loads into the agent's sessions (attached via
the agent's `skills` list; on the claude-agent-sdk harness they materialize as
`.claude/skills/`):

```
POST /v1/skills            { "content": "<SKILL.md text>", "name": "optional" }
POST /v1/skills/import     { "source": "owner/repo[/path]" }   # import from GitHub
GET  /v1/skills            /v1/skills/:id                       # list / get
```

## Outbound Webhooks

Signed POST notifications on session state changes — build your own
automation on top of session lifecycles:

```
POST /v1/webhook_endpoints   { "url": "https://your.app/hook", ... }
GET  /v1/webhook_endpoints
DELETE /v1/webhook_endpoints/:id
```

## Model Cards

```bash
oma models create --name "anthropic" --provider ant --model-id claude-sonnet-4-6 --api-key sk-ant-xxx
```

Providers: `ant`, `oai`, `ant-compatible`, `oai-compatible`.

## MCP Server Connections

```bash
oma vaults create "my-vault"
oma connect github --vault <vault-id>
```

Known servers: `airtable`, `amplitude`, `apollo`, `asana`, `atlassian`, `clickup`,
`github`, `intercom`, `linear`, `notion`, `sentry`, `slack`.

Hundreds more apps are available through **Composio**: add a tenant Composio
key (Console → agent form → Connect Composio) and pick toolkits per agent.
Agents can also spawn stdio MCP servers inside their sandbox via the
`mcp_servers[].stdio` config — no separate gateway needed.

**Agents ask for access themselves.** When an agent hits a service it can't
reach mid-task, it calls its `request_access(service, reason)` tool — a
connect card appears in the session view, the user one-clicks through the
provider OAuth popup, and the agent gets a message when the account is
connected. No secrets ever transit the chat; don't paste API keys to an agent
that asks — it shouldn't, and the card flow is the supported path.

## HTTP API Reference

Run `oma api` for the full endpoint reference, or `oma api <resource>` for a
specific resource (agents, sessions, environments, models, vaults, oauth,
skills, files, memory, keys, evals, clawhub).

All `/v1/*` endpoints require the `x-api-key` header. Use SSE streaming via
`GET /v1/sessions/:id/stream` for real-time agent responses. Self-host deploys
expose `/health` for rollout gating.

## Tips

- Check `oma agents list` / `oma envs list` before creating — reuse existing
  resources; never mint a duplicate agent per session.
- Sessions are stateful — send multiple messages to continue the conversation.
- The `agent_toolset_20260401` tool type gives agents file ops, bash, web
  access, schedule tools, and ambient-rule tools by default; `browser` is
  opt-in via `{ "name": "browser", "enabled": true }` in the toolset configs.
- Sub-agents: set `enable_general_subagent: true` for a built-in
  `general_subagent(task)` delegation tool, or list `callable_agents` for a
  fixed roster.
- Agent + environment snapshots are frozen per session — config edits apply to
  new sessions, not running ones. Same for permission grants.

## Integrations

Publish an agent into a third-party tool so it acts as a teammate there:

- [`integrations-linear.md`](integrations-linear.md) — Linear: OAuth-app
  handshake, the two moments a human is genuinely needed, verify/unpublish.
- [`integrations-slack.md`](integrations-slack.md) — Slack: app install,
  publication, and the reply bridge (guaranteed delivery for slack-originated
  turns).
- [`integrations-github.md`](integrations-github.md) — GitHub: app install,
  repo bindings, webhook-driven ambient wakes.
