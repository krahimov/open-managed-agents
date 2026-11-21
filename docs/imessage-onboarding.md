# iMessage signup and agent control

The Node deployment offers **Continue in iMessage** beside the Telegram offer.
Sign in to Orrery, select it, then text the displayed number with the exact
`ORRERY …` code, or open the prefilled **Open Messages** link on your iPhone.
The first authenticated sender holding the code becomes the linked identity.
Treat the code as private; there is no pre-enrolled phone number to compare it to.
It expires after ten minutes, is stored hashed, and can be consumed once. Asking
for a new code invalidates the old one. Phone numbers and Apple ID emails remain
separate identities; link from the identity you intend to use.

A cloud agent introduces itself once linked. Plain text reaches the active agent,
and replies return through Sendblue even with your computer and browser closed.
Only the Node server runs this channel. No Mac or local Messages bridge is used.

## Commands

- `/new [task]` starts guided agent setup using Orrery's setup tools.
- `/run` starts a working session from the latest saved configuration and vaults.
- `/connect <app>` requests a connection, for example `/connect gmail`.
- `/agents` lists every non-archived workspace agent, numbered with the active one marked. Lists show up to 20 entries and an omitted count. `/use <ID, number or name>` selects by ID, the most recent list number, or a case-insensitive name (exact first, then a unique prefix). Ambiguity shows candidates; archived agents cannot be selected.
- `/status` reports session status; `/stop` interrupts the active agent.
- `/unlink` disconnects iMessage, preserving agents and their files.
- `/help` lists the commands.

Keep the slash: ordinary words such as “run”, “new”, “stop” and “help” can also be
agent prompts. The explicit `ORRERY …` linking phrase is the slash-free exception.

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
iMessage; API-key requests use the one-time key page on both (see below). Telegram's existing conversation routes and ownership checks work for
shared sessions, including sessions first used from iMessage.

The new migrations leave the old conversation tables in place, unused by the server.
If both contain a conversation for the same user and agent, Telegram's session wins.
The displaced iMessage session drains remaining output from its own preserved cursor;
new input goes to the shared session. Already queued output parts are preserved.
Atomic event enqueue/cursor updates and shared in-process serialization prevent
both channel ticks from delivering the same event. Provider acceptance followed by
a crash before local acknowledgement can still cause a duplicate send; this is
not an end-to-end exactly-once transport guarantee. Run one Node replica.

## Deployment and Sendblue setup

Set all four server variables to enable the feature:

```
SENDBLUE_API_KEY_ID=your-key-id
SENDBLUE_API_SECRET_KEY=your-api-secret
SENDBLUE_WEBHOOK_SECRET=a-long-random-webhook-secret
SENDBLUE_NUMBER=+15551234567
```

The number must be your assigned Sendblue line in E.164 format. Partial settings
leave the feature disabled and hidden. Set `PUBLIC_BASE_URL` to the public HTTPS
Orrery console origin so app-connection and API-key links work. Never commit or log secrets.
The default webhook header is `sb-signing-secret`; optionally override it with
`SENDBLUE_WEBHOOK_SECRET_HEADER`. This is a constant-time comparison of the static
shared secret, not an HMAC. See the [Sendblue adapter guide](https://docs.sendblue.com/guides/chat-sdk-adapter).

The account owner must do the following (no dashboard actions were performed by
this implementation):

1. Open your existing Sendblue dashboard. Obtain the API key ID and secret from
   your account dashboard; [the credentials docs](https://docs.sendblue.com/getting-started/credentials)
   say they appear once an account exists. **UNVERIFIED:** current button labels
   for creating/regenerating keys; do not regenerate existing production keys unnecessarily.
2. Find your assigned Sendblue number in the dashboard and copy it to
   `SENDBLUE_NUMBER`. [The public guide](https://docs.sendblue.com/guides/chat-sdk-adapter)
   confirms numbers are displayed there; **UNVERIFIED:** exact menu label and your
   account's assigned shared number. There is no universal number to hardcode.
3. Under **Developer → Webhooks**, add a **receive** subscription with URL
   `https://YOUR_HOST/integrations/imessage/webhook` and secret equal to
   `SENDBLUE_WEBHOOK_SECRET`. That menu and subscription are documented in
   [Webhooks](https://docs.sendblue.com/getting-started/webhooks).
   **UNVERIFIED:** precise labels for the dashboard secret input/save button.
   If the UI does not expose a per-webhook secret, use the documented API below.
4. On a free shared line, add the intended recipient as a contact in the dashboard,
   then have them text that assigned number once to verify. The public
   [receiving guide](https://docs.sendblue.com/getting-started/receiving-messages)
   documents these steps, but **UNVERIFIED:** contact-screen button labels and any
   account-specific verification phrase. Follow the phrase shown if provided.
   Only verified contacts' messages are routed to your account. After verification,
   send the Orrery link code (again if the first message only performed verification).
5. Sign in to this Orrery deployment, choose **Continue in iMessage**, and send its
   code from that verified contact. Confirm the agent introduction arrives.

The documented webhook API alternative is POST
`https://api.sendblue.com/api/account/webhooks`, authenticated with
`sb-api-key-id` and `sb-api-secret-key`, JSON body:

```json
{
  "type": "receive",
  "webhooks": [{
    "url": "https://YOUR_HOST/integrations/imessage/webhook",
    "secret": "SAME_VALUE_AS_SENDBLUE_WEBHOOK_SECRET"
  }]
}
```

POST appends; do not accidentally register duplicates. GET the same endpoint to
inspect subscriptions. PUT replaces all subscriptions and can remove unrelated
integrations. No API request is performed automatically by Orrery.

Public docs permit API replies to verified free-tier contacts. They do not promise
unsolicited sends to unverified contacts. **UNVERIFIED:** this account's specific
“Free API Mode” / “no outbound messaging” wording, 10-contact cap and exact free
throughput/content quotas. Verify those entitlements with Sendblue before relying
on them; Orrery does not bypass provider restrictions. See
[Sending messages](https://docs.sendblue.com/getting-started/sending-messages).

`OMA_ONBOARDING_MODEL` defaults to `gpt-6-astra`, and
`OMA_ONBOARDING_HARNESS` to `default`. `OMA_ONBOARDING_ENVIRONMENT_CONFIG` creates a
tenant-owned **iMessage computer**, with the same cloud configuration options as
[Telegram](telegram-onboarding.md). Alternatively set `OMA_ONBOARDING_ENVIRONMENT_ID`
for an existing tenant environment. Configure a real model provider and isolated
cloud sandbox on the server. Agent creation is lazy on console connect; unlike
Telegram, iMessage does not provision an unused agent at signup.

## API keys: secure one-time page

Some MCP servers authenticate with an API key instead of OAuth. When an agent's
`request_access` produces a `system.access_request` with `auth_kind: "mcp_api_key"`,
the chat message carries a link to a small page served by the Node server, instead
of the console link. Paste the key there, never in the chat.

- URL shape: `<PUBLIC_BASE_URL origin>/integrations/channel-key?t=<token>`. The
  prefix `/integrations/channel-key` serves only this page (GET shows the form,
  POST stores the key), so a reverse proxy can forward exactly that path.
  iMessage sends the link in the message text; Telegram sends a URL button
  (not a Mini App). Other `auth_kind` values keep the existing behaviour.
- The token is 32 random bytes (base64url). Only its SHA-256 is stored, in
  `channel_key_links`, bound to the tenant, user, session, request and the
  linked chat identity that received it. It expires after 15 minutes and works
  once. Each delivery attempt, and each later link for the same request,
  replaces the previous token. Opening the link (GET) never uses it up, so link
  previews are harmless.
- The page shows the service, the host of the MCP server the key will be sent to,
  and the agent's name, with one password field. It loads nothing external and
  runs no script; responses are `no-store`, `no-referrer`, `nosniff`, `noindex`,
  with a strict Content-Security-Policy (`default-src 'none'`, nonce'd style,
  `form-action 'self'`, `frame-ancestors 'none'`). Invalid, expired and used
  links all show the same page asking you to request a new link from the agent.
- On submit the server re-checks: link live, tenant membership, the receiving
  chat account still linked, conversation binding, session and agent not archived,
  the request exists, is `mcp_api_key`, targets an https MCP URL (http only for
  localhost) and is not yet granted. It then does what the console's
  access-request card does: picks the workspace vault the same way (**Connected
  Apps**, else the first active vault, else creates **Connected Apps**; the card's
  explicit vault choice has no chat equivalent), saves a `static_bearer` credential
  named `<service> API key (chat <id>)` for the request's `mcp_server_url`,
  attaches the vault and declares the server on the session's agent, and records
  `system.access_granted` plus an `[access granted]` message so the agent
  continues in the chat.
- A link only ever writes the credential its own request created (its ID is
  recorded on the request's row). If the vault already has an active credential of
  any type for that MCP server (including equivalent URL spellings) that this
  request did not create, the page says a key for the server already exists and is
  managed in the Orrery console; nothing is stored or changed and the link is not
  used up, so it works once the existing credential is removed in the console. The
  console card refuses the same case (409). This includes a credential saved for an
  earlier request for the same server.
- The link is claimed atomically, so concurrent submits store one credential.
  - Until the grant is recorded, a failed submit gives the link back, and a resubmit
    of the same link updates the same credential (recorded ID, or its
    request-specific name after a lost response). The page says which case applies:
    "not saved" only when nothing was written; "may have been saved" when the
    credential write's outcome is unknown; "saved, not yet connected" when the key
    is stored but the grant is not.
  - Once the grant is recorded, completion is idempotent: the `[access granted]`
    message uses a stable event ID and is posted at most once, by the submit, a
    resubmit of the same link, a later link request for that access request
    (directly or through the chat guard's pending-link lookup), or the next channel
    tick (every 2 seconds). The page then says the key is saved and to send the
    agent any message if it does not continue.
- Keys are trimmed, must be 8-4096 characters without spaces or control
  characters; bodies over 16 KiB are refused (413). Invalid input re-shows the
  form without using up the link. Each link accepts five submissions and 30 page
  loads per 15 minutes; 30 failed requests per client IP per 15 minutes are
  allowed. Oversized bodies count against both budgets. The IP is the socket
  address: forwarding headers are not trusted and the codebase has no
  trusted-proxy client-IP helper, so behind a reverse proxy that budget is shared
  by all clients of the proxy. Keys, tokens and request bodies are never logged or
  echoed. The token is in the query string, which keeps it out of the server's
  request traces (they record the path), but a reverse proxy's access log may
  record full URLs: disable query logging for this prefix.
- The page needs `PUBLIC_BASE_URL` to be an https origin with no path (http is
  allowed only for `localhost`, `127.0.0.1` and `[::1]`). Otherwise the channel
  keeps sending today's console link.

## Keys pasted in chat

Inbound chat text that looks like a credential is not sent to the agent. A
conservative detector (`apps/main-node/src/lib/chat-credential-detector.ts`)
checks, in order:

1. URLs that carry a credential: a password in the userinfo
   (`https://user:token@host`), a known key syntax in any query or fragment value,
   or a value of 16 or more characters in a secret-named parameter (`api_key`,
   `key`, `token`, `access_token`, `secret`, `password`, `sig`, …). **This is
   intended:** password-reset and magic links carry bearer secrets, so
   `https://example.com/reset?token=<16+ characters>` is withheld whatever its
   alphabet. Short values and other parameter names (`utm_*`, `id`, `page`, `q`,
   `ref`, …) pass. URL paths never count.
2. Known credential syntaxes, matched on syntax alone (no digits needed):
   `sk-…`, `sk_live_…`/`rk_test_…`, `ghp_…`, `github_pat_…`, `glpat-…`,
   `xoxb-…`, `AKIA…`, `AIza…`, `npm_`/`hf_`-style tokens, `Bearer <token>`,
   `Authorization:` header values, PEM private keys and JWTs. The body must be
   unbroken (a 16+ character run without hyphens for `Bearer` and `Authorization:`),
   so hyphenated words (`sk-learn-for-beginners`,
   `Authorization: Bearer token-based-authentication`) do not count, and a prefix
   inside a URL path or a platform ID (`agent-…`, `sess-…`) does not count.
3. A secret word that directly introduces a value: `api key: X`, `password: X`,
   `secret = X`, `api_key=X`, `my token is X`, and the same in French, Spanish,
   German, Portuguese (`mot de passe est X`, `contraseña es X`, `Passwort ist X`,
   `senha é X`, `clé API: X`, …), Chinese (`密钥是 X`, `令牌：X`) and Arabic
   (`مفتاحي X`). X counts when it is one unbroken token of 16+ characters from the
   base64/hex/UUID alphabets (letters, digits, `/ + = - _ .`), regardless of the
   other heuristics, unless it is a platform ID. Compound uses of "key" that are not
   secrets (`idempotency key`, `cache key`, `primary key`, `sort key`,
   `partition key`, `foreign key`, …) and identifiers such as `cacheKey` do not
   introduce a value.
4. A long random-looking token mixing letters and digits, with a lower bar next
   to a secret word. Readable identifiers made of words and a few numbers
   (`customerAccount2024BillingRegion2025`, `release_2024_q3_notes`) do not count,
   nor do e-mail addresses, UUIDs, numbers and commands.

**Link codes.** A 32-character message (bare from an unlinked iMessage sender,
after `ORRERY `, or Telegram `/start <code>`) is exempt only when its hash matches a
live, unexpired link code in that channel's accounts table, checked at the webhook
before storing and again at processing. Anything else of that shape is withheld:
from an unlinked sender it is dropped silently as before; from an already linked
sender (for example re-sending a used code) it gets one neutral reply: the account
is already linked, nothing was sent to the agent, and if it was a key rather than a
linking code it should be rotated. A known credential syntax is never a link code.
Messages from unlinked senders are never stored beyond the sender and message ID
that the "how to link" notice needs.

When the detector fires, the webhook stores only the sender and message ID in the
inbox, never the text (rows queued by an older version are scrubbed before
processing, including when processing then fails and is retried), nothing is
appended to the session, and one reply explains that keys are not accepted in chat
and that the key should be rotated. If the conversation has a pending API-key
request, the reply includes a fresh secure link (minted when the reply is sent, so
it is never stored in plain form); otherwise it says the agent will send a secure
link when it needs a key. The text has already passed through the messaging
provider; the server cannot remove it there. The detector is a heuristic: short
keys, keys introduced in other ways or other languages, and keys split across
messages are missed, and a value introduced by a secret word is withheld even if it
was not actually a secret.

## App connections

OAuth and Composio access requests and `/connect` send a plain link to the existing
`/sessions/<session-id>#needs-you` page (API-key requests use the secure page above). Sign in to the same Orrery deployment and
select the correct workspace; use its existing access-request card to authorize.
Provider consent, vault selection, ownership and tenant checks remain the normal
console flow. There is no iMessage Mini App or unauthenticated connection flow.
Return to Messages and use `/run` after setup and connections are saved.

## Delivery and boundaries

Both channels share the conversation and event-delivery tables. Account selection,
inbound queues and command replies remain channel-specific. Migrations are included for Postgres and SQLite. Run one Node
replica: processing and provisioning are serialized in-process, not across replicas.

The receive endpoint checks the secret, enforces 64 KiB, accepts only `RECEIVED`
inbound private messages to the configured number, and persists before acknowledging.
`message_handle` deduplicates retries. Groups, outbound echoes, status updates and
identified reactions are ignored. Only text is supported; attachments get a text-only
notice and their URLs are never fetched. **UNVERIFIED:** legacy tapbacks without
reaction/type markers can resemble text; free-tier Apple ID email replies also
need a real-account test. Valid email identities are preserved rather than rejected.

Tenant membership is checked on incoming commands, console routes and outgoing
replies. Console users can disconnect with `DELETE /v1/imessage/connection`.
Unlinked senders get one linking instruction per day, capped at ten notices per
server/day; the allowance survives restarts. Notices are best effort, not retried.

Agent replies have common Markdown simplified and are split into at most 18,996
Unicode characters per provider request. Outbox records and event cursors survive
restarts. Temporary failures retry with exponential backoff from 30 seconds to one
hour; Retry-After is honored (bounded to one day). Explicit permanent contact failures
unlink; generic API-key, quota and line failures do not. No message bodies or
provider error bodies are logged by the channel.

An accepted send is not proof of handset delivery. This version does not register
status callbacks or track asynchronous delivery failures. Sendblue documents no
send idempotency key in the reviewed API, so a crash or lost HTTP response after
acceptance can cause a repeated reply. Typing indicators and read receipts are
not sent. No QR component exists in this console, so no QR dependency was added.
