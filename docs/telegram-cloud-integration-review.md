# Telegram and cloud computer integration review

Date: 2026-09-08. Integration branch: `codex/telegram-cloud-integration`.

## Why Telegram shows a different login

The Telegram bot points at the separate `agent-computer-test` Railway service.
Its public `/auth-info` response is `{"auth_disabled":false,"providers":["email"],"turnstile_site_key":null}`.
The normal Orrery service responds with `providers: ["email", "github"]`.
Both pages were inspected in a real browser and match those responses.

The test service has neither `GITHUB_AUTH_CLIENT_ID` nor
`GITHUB_AUTH_CLIENT_SECRET`. No credentials were changed or copied between
services. Its operator-level `COMPOSIO_API_KEY` is also absent; tenant vault keys
are resolved independently and were not inspected. Login hides GitHub when that
service does not advertise it. The old Telegram page was behind `AppShell`, which
also discarded its destination when redirecting to login.

## Changes prepared

- Telegram connection buttons launch a Mini App with Telegram's signed identity.
  Verification checks the bot signature, a 15-minute maximum age, linked account,
  membership, conversation ownership and exact access request.
- The public connection page uses only that proof for narrowly scoped actions.
  It does not issue an Orrery session, accept a tenant ID from the browser, or
  send login cookies. The general `/v1` API remains behind its existing auth.
- The user chooses a vault and explicitly opens provider consent. Completion
  requires a server-recorded MCP OAuth receipt or a verified active Composio
  account. Failed notification or unfinished consent cannot report completion.
- The ordinary login redirect preserves its destination. Old browser links tell
  the user to request a fresh `/connect <app>` button in Telegram.
- Tests now launch the actual server process instead of the `tsx` launcher.
  This makes SIGKILL recovery checks kill the API process and prevents orphaned
  servers. Leaked processes from this isolated test checkout were cleaned up.

## Merge assessment

The cloud work is on `codex/finish-agent-computer` at `3d0e6d7c9`, built on the
local integration lineage `d14631edd`. Its first cloud-computer commit is
`7b32cf6a3`. The branch contains 66 commits absent from `main`: 12 cloud/Telegram
commits and 54 earlier integration commits. Main also had 10 commits missing
from that branch.

The trial merge includes current `origin/main` at `1ee34bb4a`. Four conflicts
were resolved in the access-request card, Node bootstrap, Claude SDK setup
imports, and SQL event-log retry logic. Both current OAuth grant handling and
cloud-computer behavior are retained. Event appends serialize within the process
and retain main's bounded cross-process retry.

**Do not merge this accumulated branch into a public main deployment as-is.**
The inherited mission supervisor runs user-supplied verifier commands through
`sh -c` on the API host, with its process environment. It is wired to the
`/v1/missions` routes and scheduler without an opt-in gate. Its own historical
merge commit `c032c3019` says not to deploy before verifiers are sandboxed.
Extract cloud computers/Telegram with their necessary dependencies, or move
mission verification into the tenant's sandbox before promoting this lineage.
The other accumulated evaluation/memory changes also require scope review.

## Validation

Commands were run against the isolated merge checkout, not the user's working
checkout or either original feature checkout. See the final verification results
below. No live third-party consent, Telegram messages, provider credential
changes, or new Daytona computer provisioning were performed in this review.
The new Mini App flow has not been deployed, so existing bot buttons retain the
old behavior until deployment and a fresh `/connect <app>` request.

The live cloud smoke script remains available for an isolated test
service with credentials and sufficient Daytona capacity. Its deterministic
checks and the local real-Chromium test passed, but they do not establish that
the new merged code has run against Daytona in the cloud.
