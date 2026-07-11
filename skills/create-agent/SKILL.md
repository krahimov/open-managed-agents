---
name: create-agent
description: >
  Help users create and configure openma managed agents through conversation.
  Trigger when users say "create an agent", "I need an agent that...", "set up
  an agent for", "build me a bot", or describe a task to automate — including
  recurring/background tasks ("every morning", "when an issue is filed"). Also
  trigger for "Create with AI" from Dashboard, and when users ask about the
  openma platform, what it can do, how to use the CLI, or how to configure
  resources.
---

# openma Agent Creator

## What is openma?

openma is an open-source platform for building, deploying, and managing AI agents.
Think of it as a managed runtime — you define an agent (model + system prompt + tools),
the platform handles sandboxed execution, credential management, and session state.

**What you can do with it:**
- **Build agents** for any task: coding, research, data analysis, customer support, automation
- **Run agents in sandboxes** — each session gets an isolated container with file system, shell, and network
- **Run agents ambiently** — standing rules wake an agent on a cron or an event (Slack, GitHub, Linear, webhook) with no human kicking it off
- **Connect external services** via MCP servers (GitHub, Slack, Linear, Notion, etc.) with OAuth, plus hundreds more through Composio
- **Control permissions** — versioned allow/ask/deny grants over every tool the agent can touch, enforced by the runtime
- **Use any LLM** — Anthropic, OpenAI, or any OpenAI-compatible provider; or run through the claude-agent-sdk harness on a Claude subscription (self-host)
- **Install skills** — store any SKILL.md (or import from GitHub) and it auto-loads into sessions
- **Manage credentials** securely in vaults — agents get scoped access, secrets never leak
- **Collaborate** — multi-user workspace with API key access for CLI/SDK integration

## Creating an Agent

The platform's preferred flow is **create minimal, then let the agent refine
itself** in a setup session — not hand-crafting the perfect config up front.

### Flow

1. **Understand the goal** — ask what the agent should do. If vague, one question:
   "What's the main task?" Two rounds max, then build.

2. **Pick the model** — check `/v1/model_cards` first and prefer what the
   tenant already has configured. Complex/coding → the strongest Claude card
   available; general default → a Sonnet-class card; simple/fast → Haiku-class.

3. **Create minimal:**
   ```
   POST /v1/agents
   { "name", "model", "system": "<one-paragraph draft>", "tools": [{"type":"agent_toolset_20260401"}] }
   ```

4. **Start a setup session** — the agent interviews the user and rewrites its
   own harness (system prompt, name, MCP servers, skills) via its
   `update_harness` tool:
   ```
   POST /v1/sessions
   { "agent": "<id>", "environment_id": "<env>", "metadata": { "oma_setup": true } }
   ```
   This is what the Console's "Create agent" does. Skip it only when the user
   gave you a fully-specified config.

5. **Recurring or event-driven?** If the task is "every morning…" / "when X
   happens…", add an ambient rule (each firing spawns a fresh session):
   ```
   POST /v1/agents/:id/ambient-rules
   { "name": "daily triage",
     "trigger": { "source": "schedule", "config": { "cron": "0 9 * * 1-5", "timezone": "UTC", "prompt": "..." } },
     "wake_mode": "decide" }
   ```
   Sources: schedule, webhook, slack, github, linear, email, memory, file, manual.
   Schedule rules arm themselves from the cron. Agents can also create these
   from chat (`create_ambient_rule` tool) — "check this daily" just works.

6. **Anything it must NOT touch?** Set the access baseline — deny removes the
   tool from the agent's world entirely, ask requires confirmation:
   ```
   PUT /v1/agents/:id/grants/baseline
   { "rules": [ { "effect": "deny", "selector": "mcp__linear__delete_*" } ], "approved_by": "<user-id>" }
   ```
   Grants are versioned with an approver stamp and apply to sessions created
   after the change (snapshots are frozen per session).

7. **Next steps** — offer to start a working session, connect MCP
   servers/Composio toolkits, attach skills, or publish into Linear/Slack/GitHub.

## Platform Quick Ref

Agents need a **session** to run. Sessions need an **environment** (sandbox).
Ambient rules spawn sessions on their own.

| Resource | What it is |
|----------|-----------|
| Agent | Model + system prompt + tools + harness config |
| Session | A conversation with an agent in a sandbox |
| Ambient Rule | Standing trigger (cron/event) that wakes the agent in a fresh session |
| Access Grant | Versioned allow/ask/deny policy over the agent's tools |
| Environment | Sandbox runtime (default works for most) |
| Model Card | API key + provider config for an LLM |
| Vault | Secure credential storage for MCP/CLI secrets |
| Skill | SKILL.md that gives agents domain expertise (`/v1/skills`, import from GitHub) |
| Webhook Endpoint | Signed session-state notifications to your URL |
| API Key | Programmatic access token for CLI/SDK |

```
oma agents create <name>                    # create agent
oma sessions create --agent <id> --env <id> # start session
oma sessions message <id> <text>            # send message
oma models create --name <n> --model-id <id> --api-key <key>
oma keys create                             # generate API key
oma --help                                  # full command list
```

Model card providers: `ant`, `oai`, `ant-compatible`, `oai-compatible`.
Newer surfaces (ambient rules, grants, skills, webhooks) live on the HTTP API
(`x-api-key` header) — see the `openma` skill for the full reference.

## Tips

- Reuse before creating: `GET /v1/agents` first — never mint a duplicate agent
  for the same job.
- `agent_toolset_20260401` includes file ops, bash, web, schedule tools, and
  ambient-rule tools; `browser` is opt-in via toolset configs.
- Harness: leave default unless the user runs self-host and asks for
  subscription billing (`_oma.harness: "claude-agent-sdk"`, requires
  `OMA_ENABLE_CLAUDE_AGENT_SDK=1` on the deployment).
- Sub-agents: `enable_general_subagent: true` for one-off delegation, or
  `multiagent.agents` roster for named collaborators.
