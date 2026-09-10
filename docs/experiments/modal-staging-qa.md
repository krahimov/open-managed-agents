# Modal staging QA

On September 10, 2026, the Modal branch ran a saved QA agent through Orrery's
deployed Node server and session queue. The agent completed 15 browser and UI
checks with no failed or blocked checks. This was a bounded smoke test, not a
complete application regression suite.

- Branch revision deployed: `b8020349f`.
- Railway deployment: `d8e065b6-a7b1-44b5-866f-1434b2054431`, observed `SUCCESS`.
- [Saved QA agent](https://agent-computer-test-agent-computer-test.up.railway.app/agents/agent-18bauf4y1wk9x96c).
- [QA session and report](https://agent-computer-test-agent-computer-test.up.railway.app/sessions/sess-vr0mh2oseo3v8ozq).
- Environment: Modal, agent scope, Chromium and native Linux desktop enabled.
- Model and harness: `gpt-5.6-sol`, `codex-sdk`.

## Observed results

The machine API reported provider `modal` and state `running`. The agent used
native keyboard tools to open Example.com and read its heading from a screenshot.
Browser navigation then loaded the GitHub repository, Google and DuckDuckGo
search results. Each rendered successfully; no connection reset or challenge
was observed. The operator independently downloaded the desktop screenshot and
verified the repository page, then connected through Orrery's live desktop viewer.

Inside the Modal browser, the agent checked staging's email/password form,
disabled empty submit, email-code mode, return to password mode, and signup view.
It created one disposable account at `example.invalid` through the normal signup
UI. The dashboard, Agents, Sessions and Environments pages rendered successfully.
The production sign-in page also loaded; the agent did not authenticate to
production or modify production data.

The agent wrote `modal-qa-report.md` to its session outputs. The operator verified
the final `session.status_idle` event with `end_turn`, listed the output through
the session API and downloaded the 5,137-byte report. Local evidence, screenshots
and the full event log are in `Desktop/oma-modal-qa-20260910` on the operator's
computer, outside the repository.

After closing the desktop viewer, the operator stopped the computer through the
HTTP API. The API reported `stopped` without an error. The agent, environment,
session and checkpoint remain for another run. This staging run did not test a
subsequent restore; replacement persistence was tested in the earlier adapter
acceptance run.

## Issues fixed during deployment

Clean Railway builds exposed duplicate and missing dependency snapshots in the
branch lockfile. Local installation had reused its existing dependency state and
missed these defects. The fixes removed identical duplicates and restored the
omitted baseline and Modal transitive snapshots. Every importer and snapshot
dependency reference was then checked, and the clean install and console build
passed in the successful deployment.

Staging lacked `GITHUB_AUTH_CLIENT_ID` and `GITHUB_AUTH_CLIENT_SECRET`, which hid
the GitHub sign-in button. Its exact `/auth/callback/github` URL was added to the
existing login OAuth application's redirect list, and the corresponding settings
were configured in staging. The existing production callback was retained.
`/auth-info` then listed GitHub, and the operator completed the browser OAuth flow
and CLI authorization into their staging workspace.

## Remaining limits

The 24-hour Modal VM boundary and checkpoint retirement/orphan cleanup remain
rollout blockers described in [the implementation notes](modal-computers.md).
This run did not test external OAuth refresh inside the VM, email delivery,
password re-login, concurrent sessions, or agent creation from the QA browser.
The agent's own creation and execution were tested through the normal HTTP API.
Daytona remains staging's default provider for other agents. No production
deployment or main-branch merge was performed.
