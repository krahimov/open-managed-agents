# Integration Routing

Choose the least surprising integration path that gives the agent the needed
authority without overexposing credentials.

## Platform Sign-In vs App OAuth

There are two separate auth handoffs:

1. Harness Studio platform auth lets the coding agent's `oma` CLI call the
   user's Harness Studio control plane. Bootstrap it with `oma auth ensure`.
   The CLI opens `/cli/login`, stores the resulting tenant-scoped token in the
   local `oma` credentials file, and future Codex/Claude Code skill runs can use
   that token without asking for secrets in chat.
2. App OAuth gives the managed agent access to a downstream app such as Gmail,
   Slack, GitHub, or Linear. Trigger those only after platform auth is ready.

## Native Publications

Use native publication flows when the agent should be a visible teammate in the
third-party product.

| Product | Command | Use When |
|---|---|---|
| Slack | `oma slack publish <agent-id> --env <env-id>` | Agent should be mentionable, reply in threads, or live in Slack. |
| GitHub | `oma github bind <agent-id> --env <env-id>` | Agent should be assigned issues/PRs, review PRs, or comment as a GitHub App. |
| Linear | `oma linear publish <agent-id> --env <env-id>` | Agent should be assigned or mentioned in Linear issues. |

These flows require browser/admin steps. Generate exact handoff instructions
and verify with `list`, `pubs`, and `get` commands.

## Composio

Use Composio when the user asks for SaaS app tools and no native Harness
publication is needed. Good fits:

- Gmail
- Google Calendar
- Google Drive
- Notion
- HubSpot
- Salesforce
- Jira
- Airtable

General flow:

1. Add each toolkit under manifest `apps`.
2. Run `oma agents apply -f harness.agent.json`.
3. The CLI creates or reuses the `Connected Apps` vault.
4. The CLI opens a browser auth window for each toolkit and waits for the
   local callback.
5. The CLI creates the Composio tool-router credential in that vault.
6. The CLI attaches the Composio MCP server and stores the vault id in
   `metadata.default_vault_ids`.

Use `--no-auth` only for mock tests or CI plans where a human cannot complete
OAuth yet.

## Generic MCP

Use generic MCP when the user gives a server URL or the provider publishes a
known MCP endpoint.

```json
{
  "name": "notion",
  "type": "url",
  "url": "https://mcp.notion.com/mcp"
}
```

For OAuth-backed remote MCP, connect the credential to a vault:

```bash
oma vaults create "Connected Apps"
oma connect notion --vault <vault-id>
```

Then include the vault id in `agent.default_vault_ids`.

## Custom Tools

Use custom tools when the capability is an internal API or product-specific
action that is not available through built-in tools, MCP, or Composio.

Prefer narrow, typed tools:

- `lookup_customer`
- `create_refund_case`
- `schedule_email_digest`

Avoid broad tools:

- `call_internal_api`
- `run_any_query`
- `perform_action`

Each custom tool must have a JSON Schema input and a clear side-effect policy.
