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

---

## Choose your path

| Goal | Start here |
|---|---|
| Evaluate the open-source project locally | **[Docker quickstart](#quick-start-docker-local-recommended)** — the primary path for this repository |
| Use the managed product | [Hosted quickstart](#hosted-quickstart) |
| Develop the platform | [Development](#development) |
| Deploy on Cloudflare | [Cloudflare deployment](#cloudflare-deployment-advanced) |

The product is managed-first, but the repository is optimized for an OSS evaluator's first success with Docker.

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

## Quick start: Docker local (recommended)

### Prerequisites

- Git
- Docker Engine or Docker Desktop with Docker Compose v2
- `curl`, `jq`, and OpenSSL
- An OpenAI or Anthropic API key. For evaluation, use a disposable key with a low spending limit and revoke it afterward.

```bash
git clone https://github.com/krahimov/open-managed-agents.git
cd open-managed-agents
cp .env.example .env

# Generate both secrets locally and paste the values into .env.
openssl rand -hex 32       # BETTER_AUTH_SECRET
openssl rand -base64 32    # PLATFORM_ROOT_SECRET — back this up
```

For the shortest local-only smoke test, edit `.env` and set:

```dotenv
BETTER_AUTH_SECRET=<first generated value>
PLATFORM_ROOT_SECRET=<second generated value>
AUTH_DISABLED=1

# Pick one provider. The commands below use OpenAI.
OPENAI_API_KEY=<disposable OpenAI key>
OPENAI_MODEL=gpt-5.4-mini
# Or: ANTHROPIC_API_KEY=<key> and ANTHROPIC_MODEL=claude-sonnet-4-6
```

> [!WARNING]
> `AUTH_DISABLED=1` makes every request the `default` tenant. Use it only for a local, single-user evaluation. For a shared or persistent deployment, leave it unset, sign in through the Console, and create a tenant API key.

Start the SQLite stack and verify it:

```bash
docker compose up -d --build
curl --fail --silent http://localhost:8787/health | jq
```

A successful response contains `"status": "ok"`, `"runtime": "node"`, and a SQLite database backend. Open <http://localhost:8787> for the Console.

### Run your first agent

These commands assume the local-only `AUTH_DISABLED=1` setting above:

```bash
BASE=http://localhost:8787
MODEL=gpt-5.4-mini

AGENT=$(curl --fail --silent -X POST "$BASE/v1/agents" \
  -H 'content-type: application/json' \
  -d "{\"name\":\"hello-agent\",\"model\":\"$MODEL\",\"system\":\"Reply in one short sentence.\",\"tools\":[]}" \
  | jq -r .id)

test -n "$AGENT" && test "$AGENT" != null

SESSION=$(curl --fail --silent -X POST "$BASE/v1/sessions" \
  -H 'content-type: application/json' \
  -d "{\"agent\":\"$AGENT\",\"title\":\"quickstart\"}" \
  | jq -r .id)

test -n "$SESSION" && test "$SESSION" != null

curl --fail-with-body -N -X POST "$BASE/v1/sessions/$SESSION/messages" \
  -H 'content-type: application/json' \
  -d '{"content":"Reply with exactly: openma is running"}'
```

The stream should end with a `session.status_idle` event. For long-lived sessions, `GET /v1/sessions/$SESSION/events/stream` replays history on connect and remains open.

If you use Anthropic instead, set `MODEL=claude-sonnet-4-6`. When finished, run `docker compose down`; persisted data remains under `./data`. Revoke the disposable provider key after validation.

### Common first-run failures

| Symptom | Check |
|---|---|
| `401 Unauthorized` | Set `AUTH_DISABLED=1` for this local smoke test, or authenticate through the Console and send a real `x-api-key`. |
| Turn fails with “No model card” or provider authentication error | Set one provider key and use the matching model ID. Recreate the container after changing `.env`: `docker compose up -d --force-recreate oma-server`. |
| Port `8787` is already in use | Set `OMA_PORT` in `.env`, then use that port in `BASE`. |
| Docker cannot start the stack | Confirm Docker is running and `docker compose version` reports Compose v2. |
| Remote sandbox turns using memory stores stall or fail | Daytona, E2B, and BoxRun require shared `MEMORY_S3_*` storage for memory mounts; local subprocess mode uses `./data/memory-blobs`. |
| Encrypted credentials become unreadable | Restore the original `PLATFORM_ROOT_SECRET`. Changing or losing it makes encrypted rows unrecoverable. |

The default `subprocess` sandbox has **no isolation from the host process**. Use it only for trusted local evaluation; choose an isolated sandbox provider for untrusted agents.

## Hosted quickstart

The managed Console remains the main product surface. Go to [app.openma.dev](https://app.openma.dev), create an account and API key, then follow the [hosted tab in the full quickstart](https://docs.openma.dev/quickstart/).

## Cloudflare deployment (advanced)

Cloudflare deployment requires a Workers Paid plan for Durable Objects and Containers. It is an operator path, not the repository's first-run path. See the [Cloudflare deployment guide](https://docs.openma.dev/self-host/deploy/) and the repository's `scripts/deploy.sh`.

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
│   ├── docs/              # Docs site (Astro Starlight)
│   └── web/               # Marketing site (Astro)
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
| `API_KEY` | Cloudflare bootstrap only | Bootstrap key for the Cloudflare REST API. Node self-host uses Console sessions or stored tenant API keys. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` | One provider or a Model Card | Fallback LLM credential when no Model Card is configured. Prefer Model Cards in production. |
| `SANDBOX_PROVIDER` | No | `subprocess` (default), `litebox`, `daytona`, `e2b`, or `boxrun`. Use an isolated backend for untrusted agents. |
| `TAVILY_API_KEY` | No | Backend for the `web_search` tool. |

Full reference: the annotated `.env.example` / `.dev.vars.example`.

## Development

```bash
pnpm install
pnpm test             # unit + integration suites
pnpm run typecheck    # tsc across CF + Node targets
pnpm dev              # CF workers locally (wrangler simulators)
pnpm dev:console      # Console UI with hot reload
```

Docs site: `pnpm dev:docs` for local preview and `pnpm build:docs` for local HTML in the ignored `apps/docs/dist/` directory.

## Contributing

Contributions welcome — see [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

1. Fork and create a feature branch (`git checkout -b feat/amazing-feature`)
2. Make your change, with tests
3. `pnpm test && pnpm run typecheck`
4. Open a pull request

Security reports: see [SECURITY.md](SECURITY.md).

## License

[Apache 2.0](LICENSE)
