# Cloud computers: staged merge review

Based on main `1ee34bb4a`. This branch contains persistent agent computers,
private Chromium/CDP and Linux desktop access, per-session outputs, lifecycle
and backup handling, and the Codex runtime required by the computer feature.
Setup interviews do not allocate computers. Codex remains disabled unless the
operator explicitly enables `OMA_ENABLE_CODEX_SDK=1`.

The accumulated feature branch is not merged wholesale. Telegram, missions,
evaluation features, usage analytics, and memory-facts migrations are excluded.
The SDK memory-file bridge is included as a dependency of the Codex harness.
Existing main OAuth/setup and tool-budget fixes are retained.

## Validation

| Check | Result |
| --- | --- |
| Node server | 236 passed, 14 skipped (external services unconfigured) |
| Sandbox lifecycle | 96 passed |
| Real Chrome browser suite | 26 passed |
| Session runtime | 36 passed |
| Console | 27 passed |
| Smoke-script self-tests | 7 passed |
| Cloudflare harness/tool unit tests | 87 passed |
| Root/Node TypeScript, console TypeScript | passed |
| Console production build | passed |
| Frozen dependency installation, whitespace checks | passed |

515 passing tests. The first Node run had a startup timeout while a missing
Codex dependency was being installed; the complete rerun passed. Crash tests
now signal the actual Node server, rather than a tsx launcher that could leave
a child server alive. Image tool tests assert the new AI SDK image-data format.

The broader Cloudflare session-harness integration suite has 36 failures and
one skip, reproduced on an untouched main worktree. Its test database lacks
`permission_grants`; those pre-existing failures are not addressed here.
Live Postgres/S3 and a complete model-driven Daytona run are not established by
these local tests. The live acceptance script is documented in agent-computer.md.

## Release sequence

1. Review/merge this cloud-only PR, then verify the cloud stage.
2. Extract Telegram into a separate PR based on the resulting main, then test it.
3. User acceptance test.

Railway production is connected to this repository's main branch, with
`checkSuites: false`. Merging main can deploy production immediately. The
production connection has not been changed. Confirm that deployment timing
before merging. The separate agent-computer-test service is the staging target.
