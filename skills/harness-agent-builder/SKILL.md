---
name: harness-agent-builder
description: >
  Build, deploy, update, and verify Harness Studio/openma agents from a coding
  agent such as Codex or PlotCode. Use when the user asks to create an agent,
  design an agent from a natural-language job, connect apps such as Gmail,
  Slack, GitHub, Linear, Notion, or MCP servers, manage tools/skills/system
  prompts/environments/vaults, or operate agents mostly from code instead of
  the Console.
---

# Harness Agent Builder

Use this skill to turn a user's requested workflow into a concrete Harness
Studio/openma agent. Your job is to produce a reviewable local agent project,
apply it through `oma`, handle the human-only auth steps, and verify the agent
with a smoke session.

Harness Studio is the product surface. `oma` is the CLI/API implementation.

## Workflow

1. Clarify only the missing high-risk details.
   - Ask at most one question before drafting if the request is vague.
   - Do not ask for secrets in chat.
   - If the user names apps that need OAuth or admin approval, continue the
     build and surface the auth handoff later.

2. Ensure Harness Studio platform sign-in.

   ```bash
   oma auth ensure
   ```

   This is the first platform command to run in Codex, Claude Code, or any
   other coding agent. If no local Harness Studio credentials are stored, `oma`
   opens the browser sign-in handoff and waits for the local callback. Do not
   ask the user for an API key or paste tokens into chat.

   If the user is targeting a non-default deployment, use the exact base URL
   before any other platform call:

   ```bash
   oma auth ensure --base-url https://app.openma.dev
   ```

   For multiple saved environments, set `OMA_PROFILE=<name>` or pass
   `--profile <name>` consistently; credentials are stored per profile.

3. Inspect current state.

   ```bash
   oma whoami
   oma agents list
   oma envs list
   oma vaults list
   oma skills list
   ```

4. Create an agent project in the user's repo.
   - `harness.agent.json` is the applied manifest.
   - `system.md` contains the full system prompt.
   - Custom skills live under `skills/<name>/SKILL.md`.
   - Notes for human auth live in `AUTH_STEPS.md` if needed.

5. Route integrations.
   - Use native publications for Slack, GitHub, and Linear when the agent
     should appear as a teammate inside those products.
   - Use Composio for app/toolkit access such as Gmail, Google Calendar,
     Google Drive, Notion, HubSpot, and other SaaS tools when available.
   - Use a generic MCP server when the user gives a specific MCP URL.
   - Use custom tools only when the platform or MCP catalog cannot cover the
     action.

6. Apply the agent.

   ```bash
   oma agents apply -f harness.agent.json
   ```

   If `apps` contains Composio toolkits, `oma` opens a browser auth window
   for each toolkit during apply, waits for the local callback, creates the
   Composio tool-router credential, and attaches the vault to the agent. Use
   `--no-auth` only for dry CI/mocked tests.

   If the installed CLI does not have `agents apply`, use:

   ```bash
   oma agents create -f harness.agent.json
   ```

7. Complete human-required auth steps.
   - For Slack, run `oma slack publish <agent-id> --env <env-id>`.
   - For GitHub, run `oma github bind <agent-id> --env <env-id>`.
   - For Linear, run `oma linear publish <agent-id> --env <env-id>`, or
     `oma linear install-pat` only when the user explicitly accepts PAT auth.
   - For Composio, prefer the manifest `apps` flow so the CLI opens the
     provider OAuth window and attaches the resulting vault automatically.

8. Verify.
   - Create a session using the default environment/vaults stored on the agent
     when possible.
   - Ask the agent to list available tools and perform a harmless dry run.
   - For code review/private repo work, attach the repository as a
     `github_repository` session resource. GitHub MCP/API access alone does
     not mount a local checkout for bash-based review.
   - For publication integrations, verify the publication status is `live`.

## Session Smoke Tests

General tool inventory smoke:

```bash
oma sessions create --agent <agent-id> --env <env-id> --title "agent-smoke"
oma sessions chat <session-id> "List the tools you can access and what each is for. Do not send, delete, post, or modify anything."
```

Private GitHub PR/code review smoke:

```bash
oma sessions create \
  --agent <agent-id> \
  --env <env-id> \
  --title "pr-review-smoke" \
  --github-repo https://github.com/<owner>/<repo> \
  --checkout-pr <number> \
  --github-auth
oma sessions chat <session-id> "Review the checked-out PR locally. Run relevant read-only commands and summarize findings without posting to GitHub."
```

If the repo is public, or the platform has a native GitHub App installation
bound for that repo, omit `--github-auth`. If browser/device auth is not
available, set `GITHUB_TOKEN` locally and use `--github-token-env GITHUB_TOKEN`.
If the clone fails for a private repo, the session is missing either a GitHub
App binding or an inline session resource token; do not assume a
Composio/GitHub MCP credential creates a git checkout.

## Manifest Contract

Use `references/manifest-schema.md` for the project schema. The current CLI
accepts JSON directly. YAML is acceptable for design discussion, but convert to
JSON before applying unless `oma agents apply` explicitly supports YAML in the
installed version.

Minimal applied manifest:

```json
{
  "apiVersion": "harness.studio/v1alpha1",
  "kind": "AgentProject",
  "agent": {
    "name": "Email Manager",
    "model": "claude-sonnet-4-6",
    "system_file": "./system.md",
    "tools": [{ "type": "agent_toolset_20260401" }],
    "mcpServers": [
      {
        "name": "composio",
        "type": "url",
        "url": "https://app.composio.dev/tool_router/v3/session/mcp"
      }
    ]
  }
}
```

## System Prompt Rules

Write the agent system prompt as a production operating contract:

- Define the job, scope, success criteria, and refusal boundaries.
- Name each integration and what it is allowed to do.
- Make destructive actions confirmation-gated.
- Include data-handling rules for email, docs, tickets, code, and customer data.
- Tell the agent how to verify before acting.
- Keep product-specific auth or token instructions out of the prompt.

## Security Rules

Follow `references/security-rules.md`.

Never put API keys, OAuth tokens, webhook secrets, private keys, or PATs in:

- `harness.agent.json`
- `system.md`
- `AUTH_STEPS.md`
- shell history
- chat messages

Use vaults, OAuth links, browser handoff, or secure CLI prompts/env vars.

## Human Handoff

When a browser/admin step is required, do not stop with a vague instruction.
Give the exact command, exact link or fields, and exact verification command.
If browser automation is available and the user approves, drive the browser.
Otherwise, write a concise `AUTH_STEPS.md` and continue everything else.

## References

- `references/manifest-schema.md` - project manifest shape.
- `references/integration-routing.md` - choosing native, Composio, MCP, or custom tools.
- `references/security-rules.md` - credential and action-safety rules.
- `recipes/email-manager.md` - Gmail plus Slack example workflow.
- `recipes/native-publications.md` - Slack/GitHub/Linear teammate publishing.
