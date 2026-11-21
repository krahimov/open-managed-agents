# Telegram signup and agent control

The Node deployment can create a user's first agent when they sign up. The
console offers **Continue in Telegram**, opening a private bot chat.
The initial account link requires signing in to this same deployment. Telegram
requires the user to press **Start** before a bot can contact them; a phone
number alone cannot authorize bot messages.

Once linked, the platform starts a real agent conversation automatically and the
agent introduces itself. Plain text goes to their active agent,
which works in the cloud and replies through Telegram even after the browser
closes. No API key needs to be pasted into Telegram.

Commands:

- `/new` starts the same guided setup session as the Orrery console. Describe the task in the next message, or include it after `/new`.
- Setup uses `update_harness` and `request_access` to save the agent configuration and request connections. It does not begin the actual work.
- `/run` creates a working session from the latest saved configuration, including selected vaults and connected tools.
- `/connect <app>` sends a connection button, for example `/connect linear` or `/connect gmail`. Agents can also request a connection during setup.
- `/agents` lists all non-archived workspace agents, numbered with the active one marked (up to 20, with an omitted count).
- `/use <ID, number or name>` switches agents. Numbers use your most recent `/agents` list; names match case-insensitively, exact first, then a unique prefix. Ambiguous names show candidates. Archived agents cannot be selected.
- `/status` reports the active agent's session status.
- `/stop` interrupts the active agent.
- `/unlink` disconnects Telegram; the agents and their files remain available.
- `/help` shows the commands.

## Shared conversations

Console-created agents and agents created through either chat channel are available
through both channels within the workspace. The owner marker records provenance;
it does not restrict access. Active agent selection remains independent per channel.

For each workspace user and agent, Telegram and iMessage use one session, setup/work
mode and output cursor. Open that session in the console to inspect the same event
history. `/new` still creates another agent in setup mode; `/run` replaces that
agent's shared session with a fresh snapshot. `/status` and `/stop` operate on the
shared session. Session titles use “Chat” rather than a channel name.

Messages and commands make their channel the reply destination for that conversation.
Agent replies, errors and access requests go only to that destination. If it is
unlinked, delivery falls back to the other linked channel; without any linked channel,
output is retained and the cursor is held. Queued output also survives unlinking.
Access requests use a Mini App button on Telegram and a signed-in console link on
iMessage; API-key requests use a one-time key page on both. Telegram's existing conversation routes and ownership checks work for
shared sessions, including sessions first used from iMessage.

The new migrations leave the old conversation tables in place, unused by the server.
If both contain a conversation for the same user and agent, Telegram's session wins.
The displaced iMessage session drains remaining output from its own preserved cursor;
new input goes to the shared session. Already queued output parts are preserved.
Atomic event enqueue/cursor updates and shared in-process serialization prevent
both channel ticks from delivering the same event. Provider acceptance followed by
a crash before local acknowledgement can still cause a duplicate send; this is
not an end-to-end exactly-once transport guarantee. Run one Node replica.

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

Connection buttons open a Telegram Mini App. The server verifies Telegram's signed
launch data, its age, the linked account, current tenant membership, and ownership
of the exact session and connection request. No Orrery browser login is needed.
Signed launch data expires after 15 minutes and is never stored in browser storage
or passed in an authorization URL. Reopen the bot's button if it expires.

Choose a vault, prepare authorization, then open the provider's consent screen.
Return to the Mini App and press **I've authorized the app**. The server checks
that MCP OAuth stored a credential, or that Composio has an active account for
the requested toolkit and vault, before attaching it and notifying the agent.
Failed or incomplete consent cannot mark the request connected. `/run` starts a
new session with the saved tools and vaults. Complete connections before `/run`.

Old ordinary browser links cannot supply Telegram identity. Send `/connect <app>`
again to receive a Mini App button. Provider sign-in and consent still happen at
the provider. API-key integrations (`auth_kind: "mcp_api_key"`) get a URL
button to a one-time secure page instead of the Mini App; the key is stored in the
workspace vault and never enters the chat. Text that looks like a pasted key is not
sent to the agent, and the bot replies with guidance and, when a key is pending, a
fresh secure link. The inbox stores only the update and message IDs, chat ID and
type, sender ID and bot flag, and the message text; captions, quoted replies,
entities and media are never persisted (rows stored by an older version, holding
the full update, still decode, and are reduced to this shape at the start of
processing, before anything that can fail). `/start <code>` is exempt from
screening only when the code matches a live link code; unlinked users' other
messages are not stored. Links with a 16+ character value in a secret-named query
or fragment parameter (`?token=…`, `?api_key=…`, reset and magic links) are
treated as credentials on purpose. Details, limits and the public route
(`/integrations/channel-key?t=<token>`) are in
[iMessage: API keys](imessage-onboarding.md#api-keys-secure-one-time-page).
Composio needs a workspace key or operator `COMPOSIO_API_KEY`; the Mini App shows
an explicit configuration error if neither is available. Google services use
individual toolkit slugs such as `gmail` and `googledrive`.

The normal Orrery login independently shows GitHub only when both
`GITHUB_AUTH_CLIENT_ID` and `GITHUB_AUTH_CLIENT_SECRET` are configured. These are
per deployment: a separate Telegram test service does not inherit production's
GitHub login, accounts, cookies, or provider configuration. `/auth-info` reports
the providers enabled on the service being opened.

This version supports text and explicit creation commands. Attachments, voice,
and Telegram group workspaces are not implemented. iMessage is available in the Node
deployment through [Sendblue](imessage-onboarding.md). Existing Clerk accounts can link from the console; automatic
creation at signup currently uses the Better Auth signup hook.
