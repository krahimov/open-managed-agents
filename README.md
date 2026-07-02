<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="logo-dark.svg">
    <img src="logo.svg" alt="orrery" height="64" />
  </picture>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**The open-source platform for running AI agents** — an alternative to Claude Managed Agents that you can self-host on your own hardware or deploy to Cloudflare.

🌐 **[openma.dev](https://openma.dev)** · 📖 **[docs.openma.dev](https://docs.openma.dev)** · 💬 **[github.com/open-ma/open-managed-agents](https://github.com/open-ma/open-managed-agents)**

---

## What is this?

Most agent frameworks give you a loop and leave the hard parts to you. Open Managed Agents (OMA) is the other half: the **platform** that runs agents in production. You define an agent (model, system prompt, tools, skills); OMA gives it everything it needs to actually operate:

- **Sessions** — every conversation is an append-only event log. Stream it live over SSE, reconnect after a crash, and the session resumes exactly where it stopped.
- **Sandboxes** — agents execute code in isolated environments: local subprocess, Firecracker microVMs (LiteBox), Daytona, E2B, BoxRun, or Cloudflare Containers.
- **Built-in tools** — bash, file read/write/edit, glob, grep, web fetch, web search, scheduling, and an opt-in headless browser.
- **Vaults** — credentials are injected into outbound HTTP requests at the network layer. Tokens never enter the sandbox, so a prompt-injected agent has nothing to leak.
- **Model Cards** — per-tenant LLM credentials, encrypted at rest. Point agents at Anthropic, OpenAI, or any compatible endpoint (vLLM, OpenRouter, Bedrock proxies) without redeploying.
- **Memory** — persistent stores mounted into the sandbox as plain files the agent reads and writes with its normal file tools.
- **Skills** — reusable instruction packs (`SKILL.md` + reference files) mounted into the sandbox and inlined into the system prompt. Compatible with [Claude Code skills](https://github.com/anthropics/skills).
- **Integrations** — publish an agent into **Linear**, **GitHub**, or **Slack** as a real teammate: assignable, `@mention`-able, replying under its own bot identity.
- **Console** — a web dashboard for managing agents, sessions, model cards, vaults, and integrations.

The REST API is drop-in compatible with the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents) — same endpoints, same event types.

## How it's built

OMA is a **meta-harness**: the platform prepares *what* an agent has (tools, skills, history, sandbox, credentials), and a pluggable **harness** decides *how* to drive the model (context construction, caching, compaction, retries, stop conditions).

```
┌─────────────────────────────────────────────────────────┐
│  Harness (the agent loop)                               │
│  reads events → builds context → calls model → repeats  │
│  stateless: crash → rebuild from event log → resume     │
├─────────────────────────────────────────────────────────┤
│  Platform (sessions, tools, sandbox, vaults, memory)    │
│  event log, lifecycle, crash recovery, credential       │
│  isolation, usage tracking, real-time streaming         │
├─────────────────────────────────────────────────────────┤
│  Infrastructure (pick one, switch with env vars)        │
│  Node self-host: SQLite/Postgres + local FS + any       │
│  sandbox · Cloudflare: Workers + DO + D1/KV/R2 +        │
│  Containers                                             │
└─────────────────────────────────────────────────────────┘
```

Harnesses are registered by name and selected per agent via the `harness` field:

| Harness | What it does |
|---|---|
| `default` | Native agent loop on the AI SDK — streaming, tool use, compaction, cache breakpoints |
| `claude-agent-sdk` | Runs each turn through the [Claude Agent SDK](https://docs.anthropic.com/en/api/agent-sdk/overview) (Claude Code as the loop), Node self-host only |
| `acp-proxy` | Bridges external ACP-speaking agents into OMA sessions |

## Quick start: self-host (Docker)

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# Two secrets are required before first boot — both generated locally:
#   BETTER_AUTH_SECRET   — signs Console sessions        (openssl rand -hex 32)
#   PLATFORM_ROOT_SECRET — encrypts credentials at rest  (openssl rand -base64 32)
#                          Back it up — losing it makes every encrypted row unreadable.
$EDITOR .env

# SQLite + local subprocess sandbox (default — fastest path)
docker compose up -d

# Or with Postgres:
# docker compose -f docker-compose.postgres.yml up -d

curl localhost:8787/health
open http://localhost:8787        # Console UI on the same port
```

Setting `ANTHROPIC_API_KEY` in `.env` lets your first agent run immediately; for anything beyond a smoke test, add a **Model Card** from the Console instead — it's encrypted, per-tenant, and rotatable without a restart.

Full guide (sandbox providers, Postgres, vault sidecar, operator notes): **[docs.openma.dev/self-host/overview](https://docs.openma.dev/self-host/overview/)**

## Quick start: Cloudflare

Requires a [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) for Durable Objects and Containers.

```bash
git clone https://github.com/open-ma/open-managed-agents.git
cd open-managed-agents
pnpm install

# Local dev (no CF account needed — wrangler simulators)
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars
pnpm dev              # API on http://localhost:8787
pnpm dev:console      # Console on http://localhost:5173

# Deploy
npx wrangler login
npx wrangler kv namespace create CONFIG_KV       # paste the id into wrangler.jsonc
npx wrangler secret put BETTER_AUTH_SECRET
npx wrangler secret put PLATFORM_ROOT_SECRET     # back this up
npx wrangler secret put API_KEY                  # bootstrap key for the REST API
npm run deploy
```

This deploys the API worker (routes, auth, rate limiting), the agent worker (session runtime + harness + sandbox), a KV namespace for config, and an R2 bucket for workspace persistence.

## Your first agent

Works against any deployment — Docker or Cloudflare:

```bash
BASE=http://localhost:8787
KEY=dev-test-key                 # whatever you set as API_KEY

# 1. Create an agent
AGENT=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r .id)

# 2. Start a session
SESSION=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" | jq -r .id)

# 3. Send a message and stream the reply
curl -N -X POST $BASE/v1/sessions/$SESSION/messages \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"content":"Write a Python script that fetches HN top stories"}'
```

For long-lived sessions, `GET /v1/sessions/$SESSION/events/stream` replays history on connect and never closes. The `oma` CLI (`packages/cli`) wraps all of this: `oma models create`, `oma memory write`, `oma slack publish`, and more.

## Core concepts

| Concept | What it is |
|---|---|
| **Agent** | A versioned configuration: model, system prompt, tools, skills, MCP servers, callable sub-agents. Stateless — updates create new versions; running sessions keep the version they started with. |
| **Session** | A running conversation. Owns the append-only event log; the unit of state and crash recovery. |
| **Environment** | A sandbox definition — image, packages, network policy. Reusable across agents and sessions. |
| **Vault** | Credential store. An outbound resolver matches request hostnames, strips any agent-supplied auth headers, and injects the real token at forward time. Supports static bearers, auto-refreshing MCP OAuth, and CLI credentials (`gh`, `aws`, …). |
| **Model Card** | Per-tenant LLM credential (provider, model, key, base URL), AES-GCM encrypted under `PLATFORM_ROOT_SECRET`. Supports Anthropic, OpenAI, and any wire-compatible endpoint. |
| **Skill** | `SKILL.md` + reference files, mounted at `/home/user/.skills/<name>/` and inlined into the system prompt. `xlsx`, `pdf`, `docx`, `pptx` ship built-in. |
| **Memory Store** | Persistent files mounted at `/mnt/memory/<store_name>/` — the agent uses its standard file tools, no bespoke memory API. Versioned with audit history. |

See [AGENTS.md](AGENTS.md) for the full agent configuration reference and lifecycle.

## Built-in tools

Attaching `{"type": "agent_toolset_20260401"}` gives an agent:

| Tool | Description |
|---|---|
| `bash` | Run commands in the sandbox |
| `read` / `write` / `edit` | File operations in the sandbox filesystem |
| `glob` / `grep` | Find files and search contents |
| `web_fetch` | URL → markdown (auto-summarized when `aux_model` is set) |
| `web_search` | Web search (requires `TAVILY_API_KEY`) |
| `schedule` / `cancel_schedule` / `list_schedules` | Cron-style self-wakeups for long-running agents |
| `browser` | Opt-in headless browser — navigate, click, screenshot |

Attached MCP servers surface their tools as `mcp__<server>__<tool>` (HTTP/SSE for hosted servers, stdio spawned inside the sandbox for npm/PyPI packages). Callable agents surface as `call_agent_*` for multi-agent delegation.

## Integrations

Publish an agent into a tool your team already uses. Each publication gets its own bot identity, inbound webhooks become session messages, and replies go out through the provider's API under the agent's name — gated by a per-publication capability allowlist.

- **Linear** — the agent appears in the assignee dropdown, responds to `@mentions` and the Agent panel, and can auto-pick-up issues by label/state/project rules.
- **GitHub** — each agent registers its own GitHub App (manifest flow): assignable on issues, requestable as a PR reviewer, engaged via label or `@<slug>[bot]` mention.
- **Slack** — a dedicated Slack app per agent: channel `@mentions`, DMs, threads, and the AI assistant pane, with one session per channel.

Setup wizards live in the Console under **Integrations**; the `oma` CLI covers the same flows (`oma linear …`, `oma github …`, `oma slack …`).

## Project structure

```
open-managed-agents/
├── apps/
│   ├── main/              # API worker (Cloudflare) — routes, auth, rate limiting
│   ├── main-node/         # API server (Node self-host) — same routes on Hono/Node
│   ├── agent/             # Agent worker — session runtime + harness + sandbox
│   ├── integrations/      # Integrations gateway — Linear / GitHub / Slack
│   ├── oma-vault/         # Vault sidecar — outbound credential injection (self-host)
│   ├── console/           # Web dashboard — React + Vite + Tailwind
│   ├── docs/              # Docs site (Astro Starlight) → docs.openma.dev
│   └── web/               # Marketing site → openma.dev
├── packages/
│   ├── cli/               # `oma` CLI
│   ├── http-routes/       # REST route definitions shared by main + main-node
│   ├── session-runtime/   # Event log, broadcast, crash recovery
│   ├── sandbox/           # Sandbox adapters (subprocess / litebox / daytona / e2b / boxrun)
│   ├── api-types/         # Shared TypeScript types
│   ├── linear/ github/ slack/   # Integration provider logic
│   └── …                  # stores (vaults, model cards, credentials), scheduler, evals, …
├── docs/                  # Internal design RFCs (not the published docs site)
└── skills/                # Agent-facing playbooks
```

## Configuration

The variables that gate boot and at-rest safety:

| Variable | Required | Description |
|---|---|---|
| `PLATFORM_ROOT_SECRET` | **Yes** | AES-GCM key for credentials, model-card keys, and integration tokens. **Back it up** — losing it makes every encrypted row unreadable. |
| `BETTER_AUTH_SECRET` | **Yes** (prod) | Console session signing key. |
| `API_KEY` | Yes | Bootstrap key for the REST API; mint per-tenant keys from the Console after first boot. |
| `ANTHROPIC_API_KEY` | No | Fallback LLM credential when no Model Card is configured. Prefer Model Cards in production. |
| `SANDBOX_PROVIDER` | No | `subprocess` (default), `litebox`, `daytona`, `e2b`, or `boxrun`. Use an isolated backend for untrusted agents. |
| `TAVILY_API_KEY` | No | Backend for the `web_search` tool. |

Full reference: **[docs.openma.dev/reference/configuration](https://docs.openma.dev/reference/configuration/)** and the annotated `.env.example` / `.dev.vars.example`.

## Development

```bash
pnpm install
npm test              # unit + integration suites
npm run typecheck     # tsc across CF + Node targets
pnpm dev              # CF workers locally (wrangler simulators)
pnpm dev:console      # Console UI with hot reload
```

Docs site: `pnpm dev:docs` (local preview), `pnpm deploy:docs` (publish).

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Fork and create a feature branch (`git checkout -b feat/amazing-feature`)
2. Make your change, with tests
3. `npm test && npm run typecheck`
4. Open a pull request

Security reports: see [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE)
