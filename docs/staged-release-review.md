# Cloud and Telegram staged release

Cloud PR #22 merged as `90c58be1f`, after 515 targeted tests passed. Its
post-merge server run passed all 236 tests, with 14 external-service skips.
The merged tree matched the tested and staged cloud commit `c75bd5a4c`.

Telegram is extracted onto that main version. It adds signup/linking, guided
agent creation, durable inbox/outbox delivery, and provider connections using
verified Telegram Mini App identity. Necessary Composio connection attachment
code is included; unrelated missions, evaluations, analytics and memory-facts
changes from the accumulated feature branch remain excluded.

## Telegram validation

- Node server suite: 267 passed, 14 external-service tests skipped.
- Console suite: 32 passed.
- Root/Node and console TypeScript: passed.
- Console production build and whitespace checks: passed.
- SQLite upgrades tested from main, first Telegram release, and the legacy test
  migration journal. Existing account bindings and queued messages survive.
  Existing migration tags/timestamps are retained; no memory-facts migration is added.

The broader Cloudflare session-harness integration suite has 36 failures and one
skip on unchanged main because its fixture lacks permission_grants. This staged
release does not repair that unrelated fixture. Live Postgres/S3 suites and a
complete model-driven Daytona run are not claimed by these results.

## Production hold

With the user's approval on 2026-09-09, the GitHub source was disconnected from
Railway production service `cc8515f8-ba46-4340-b39e-63ae19c110ad`, in project
`63978c42-b902-428b-a327-56e4151654b6`, environment
`549f05be-fdcc-49e4-9a35-f0e9e0eb1644`. Its previous source was
`krahimov/open-managed-agents`, branch `main`, with checkSuites disabled.
The running production deployment remained
`b34a2be4-68b1-41b4-aae9-05ec772193e4`, from pre-feature main `1ee34bb4a`.

Keep production disconnected until the user approves release after acceptance.
Reconnecting the repository can immediately deploy the latest main. The GitHub
source can then be restored with the Railway service source connect command,
using these explicit service/environment/project IDs, repository and branch.
No credentials or production data were changed for this hold.

## User acceptance

Use https://agent-computer-test-agent-computer-test.up.railway.app with the test
service's account. Production accounts and GitHub login are separate. This test
service has email login but no GitHub OAuth app credentials.

1. Open Continue in Telegram and press Start, or use the already-linked chat.
2. Send /new with a task, then complete the setup conversation.
3. Send /connect with an app name. Use a fresh Mini App button, finish provider
   consent, return and verify the connection. Provider configuration is still
   required; the Mini App does not bypass provider consent.
4. Send /run and verify browser/computer work continues after closing the console.
   Reopen the agent's computer and check its files and outputs.

Old ordinary browser links cannot authenticate with Telegram. Replace them with
a fresh /connect button. Full real-provider consent and the user's Telegram
client remain acceptance checks. See telegram-onboarding.md and agent-computer.md.
