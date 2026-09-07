# Telegram signup and agent control

The Node deployment can create a user's first agent when they sign up. The
console offers **Continue in Telegram**, opening a private bot chat. Telegram
requires the user to press **Start** before a bot can contact them; a phone
number alone cannot authorize bot messages.

Once linked, the bot greets the user. Plain text goes to their active agent,
which works in the cloud and replies through Telegram even after the browser
closes. No API key needs to be pasted into Telegram.

Commands:

- `/new <task>` creates and starts an agent for that task.
- `/agents` lists the user's Telegram agents.
- `/use <agent ID>` switches the conversation to another of those agents.
- `/status` reports the active agent's session status.
- `/stop` interrupts the active agent.
- `/unlink` disconnects Telegram; the agents and their files remain available.
- `/help` shows the commands.

## Deployment

Configure secrets `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`, and the
public `TELEGRAM_BOT_USERNAME` without `@`. The feature stays disabled unless all
three are set. Set the bot webhook to:

```
https://YOUR_HOST/integrations/telegram/webhook
```

Use Telegram's `setWebhook` API with `secret_token` equal to
`TELEGRAM_WEBHOOK_SECRET` and `allowed_updates: ["message"]`. Use a dedicated
bot for staging. Never print the bot token in logs or commit it.

`OMA_ONBOARDING_MODEL` selects the first and subsequently chat-created agents'
model (default `gpt-6-astra`). `OMA_ONBOARDING_HARNESS` defaults to `default`.
For a trusted single-operator subscription test, choose `codex-sdk` and configure
its opt-in authentication as documented in [agent-computer.md](agent-computer.md).
Do not expose an operator's subscription harness as a public multi-user service.

`OMA_ONBOARDING_ENVIRONMENT_CONFIG` is a JSON environment configuration copied
into a tenant-owned **Telegram computer** environment. For example:

```json
{"type":"cloud","sandbox":{"provider":"daytona","scope":"agent","snapshot":"daytona-small","workdir":"/workspace","bootstrap_tools":false,"browser":true,"desktop":true,"idle_stop_minutes":10}}
```

Alternatively, `OMA_ONBOARDING_ENVIRONMENT_ID` selects an existing environment
for a single tenant. Each session pins its agent and environment snapshots.
Computers are provisioned lazily on the first task; signup creates the agent
configuration without allocating a Linux machine.

## Delivery and boundaries

Link tokens expire in ten minutes, are stored hashed, and are consumed once.
Only private chats with a matching Telegram sender are accepted. Tenant membership
is checked on incoming commands and outgoing replies. Group messages are ignored.
Users can also disconnect via `DELETE /v1/telegram/connection`.

SQLite/Postgres migrations add persistent account bindings, per-agent conversations,
and inbox/outbox queues. Duplicate webhook updates do not create repeated tasks.
Agent output cursors and pending deliveries survive server restarts. Telegram has
no send-message idempotency key, so a crash after Telegram accepts a reply but
before our acknowledgement is stored can repeat that reply. Deploy one Node
replica for this first version; queue processing/provisioning is serialized in
that process.

This version supports text and explicit creation commands. Attachments, voice,
Telegram group workspaces, iMessage and natural-language agent configuration
are not implemented. Existing Clerk accounts can link from the console; automatic
creation at signup currently uses the Better Auth signup hook.
