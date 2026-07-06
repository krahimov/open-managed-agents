# @agent mentions in Slack

Publish a platform agent into a Slack workspace so anyone can `@mention` it
in a channel (or DM it) the way Anthropic's Claude Tag works: the mention
starts a session turn, the agent reads the thread, does its work with its
normal tools/memory/skills, and replies under its own bot identity in the
same thread.

**Status (verified 2026-07-01):** the full pipeline exists and is
signature-verified end-to-end on both runtimes — manifest generation →
per-tenant Slack app → OAuth (bot + user tokens) → Events API webhook →
event queue → session dispatch → threaded replies via Slack MCP. The one
missing runtime primitive on Node self-host — durable `scheduleWakeup`,
which the per-channel protocol depends on — ships in the same branch as
this doc (`session_wakeups` + scheduler pump, see
`apps/main-node/src/lib/node-session-wakeups.ts`).

## How a mention becomes a turn

1. Slack POSTs to `POST /slack/webhook/pub/:pubId` (per-publication) or
   `/slack/webhook/app/:appId`. HMAC-SHA256 signature over
   `v0:{ts}:{rawBody}` with 5-minute replay protection; the
   `url_verification` handshake is answered inline. Unknown app/pub ids are
   acked with `{ok:false, reason}` so Slack doesn't retry-storm.
2. The provider normalizes the event and classifies dispatch:
   - `direct_invocation` — someone @-mentioned the bot or DM'd it. A
     session is resolved per scope (`per_thread` granularity:
     `channel_id:thread_ts`; DMs get their own scope) via
     `slack_thread_sessions`, creating it on first contact with the
     publication's agent + the Slack signal-protocol prompt appended.
   - `channel_scan_armed` — a top-level channel message under
     `per_channel` granularity arms a ~90s debounce; the agent is told to
     `schedule` a wakeup and scan `conversations.history` when it fires.
   - `joined_channel`, `reaction_on_bot_message`, `session_closed` —
     lifecycle signals with matching protocol guidance.
3. The event text reaches the agent as a `user.message` wrapped in an
   `<oma_signal kind="…">` envelope carrying `channel` / `thread_ts`.
4. The agent replies by calling the Slack MCP tools (`mcp__slack__*`,
   backed by Slack's hosted MCP at `mcp.slack.com`); the user
   `xoxp-`/bot token is injected by the vault outbound proxy — tokens
   never enter the sandbox.
5. Slack's 3-second ack budget is honored by returning 200 immediately and
   running dispatch as deferred work.

## Setup (console)

Console → **Integrations → Slack** (`apps/console/src/pages/IntegrationsSlack.tsx`):

1. **Create the Slack app** — OMA generates a Slack app manifest with the
   right scopes and event subscriptions (below) plus your webhook URL, and
   gives you a `slack.com/apps` deep link. Paste back the app credentials
   (client id/secret, signing secret). Stored per-tenant in `slack_apps`.
2. **Install / OAuth** — the OAuth v2 dual-token flow captures both the
   bot token and a user-scope token (search + canvases). Rows land in
   `slack_installations`.
3. **Publish an agent** — bind agent ↔ workspace/channels as a
   `slack_publications` row with a session granularity (`per_thread` for
   @-mention Q&A, `per_channel` for an ambient channel teammate).
4. Invite the bot to a channel and `@mention` it.

Self-host requirements: `PLATFORM_ROOT_SECRET` set (the integrations
gateway and credential encryption are gated on it) and a public URL for
the webhook (`PUBLIC_BASE_URL`; use a tunnel in dev).

### Manifest scopes/events (source: `packages/slack/src/config.ts`)

- Bot scopes: `app_mentions:read`, `assistant:write`, `chat:write`,
  `chat:write.public`, `channels:history`, `groups:history`, `im:history`,
  `mpim:history`, + reads (`users:read`, …).
- User scopes: `search:read.*` (public/private/im/mpim), history reads,
  `canvases:read/write`.
- Events: `app_mention`, `message.channels`, `message.im`,
  `message.groups`, `message.mpim`, `assistant_thread_started`,
  `member_joined_channel`, `member_left_channel`, `channel_archive`,
  `tokens_revoked`, `app_uninstalled`.

This is the same surface Anthropic's Claude-in-Slack app requests
(mention trigger + thread reads + DM channel + posting), plus the Slack
Assistant API so the bot appears in Slack's Agents & AI Apps pane.

## Parity with Claude Tag — where we stand

| Capability | Claude Tag | OMA today |
|---|---|---|
| @mention in channel starts work | ✅ | ✅ `direct_invocation` |
| Replies threaded, no re-mention needed in-thread | ✅ | ✅ `per_thread` scope key |
| DMs without @mention | ✅ | ✅ `message.im` subscription |
| Ambient channel watching | ✅ channel watches | ✅ `per_channel` + debounce scan (needs the Node wakeup fix in this branch) |
| Bot posts under its own identity | ✅ | ✅ bot token via vault injection |
| Channel-scoped memory | ✅ | ⚠️ sessions are long-lived per scope, but no channel-scoped memory-store binding yet |
| Live-updating checklist first reply | ✅ `chat.update` | ❌ not implemented — agent posts normal messages |
| "Open session" deep link back to console | ✅ | ❌ not implemented |
| Org/channel-scoped credential bundles | ✅ access bundles | ⚠️ vaults exist; no per-channel scoping |
| Per-channel spend caps + audit view | ✅ | ❌ (usage events exist on CF runtime only) |

Good next steps, in impact order: session deep-link in the first reply,
`chat.update` checklist rendering, channel-scoped memory stores.
