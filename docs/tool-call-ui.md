# Tool-call UI in the session views

`SessionChat` (agent builder, test runs) and `SessionDetail` (the full session
view) render tool calls with one shared set of components in
`apps/console/src/components/tool-calls/`:

- `model.ts` is pure. `buildTimeline(events)` pairs each use with its result,
  groups consecutive calls, folds finished turns, and labels each call.
- `ToolCalls.tsx` holds the rows (`WorkTimeline`, `WorkGroup`, `ToolCallRow`,
  `ThinkingRow`, `StreamingToolRow`, `WorkingRow`, `FoldRow`, `Output`,
  `DiffView`).

The host page still renders messages, errors and the `system.*` cards through
a `renderEvent` callback. The model never sees those cards' internals.

## Patterns adopted from T3 Code

We studied [T3 Code](https://github.com/pingdotgg/t3code) (MIT,
© 2026 T3 Tools Inc.), mainly `apps/web/src/components/chat/WorkLog.tsx`,
`TimelineWorkGroupRows.tsx`, `TimelineWorkEntryRow*.ts(x)` and
`packages/client-runtime/src/work-log/presentation.ts`. We copied no code
verbatim. These are the patterns we re-implemented:

1. **Turn fold.** Once a turn finishes (idle `end_turn`, `session.error` or
   `terminated`), its work collapses behind a `Worked for 2m 8s ›` row. The
   intermediate assistant messages ("Let me check…") fold with it. The final
   answer, user messages and `system.*` cards stay visible. An interrupted turn
   reads `Stopped after 9s`. A fold that hides a failed or denied call shows a
   red mark on its header.
2. **What never folds.** Failed or denied work that comes *after* the final
   answer stays in view, as do calls still waiting on the user (approval or a
   client result) and turns that are still running.
3. **Grouped summaries.** Two or more consecutive calls (spans and status
   events don't break a run) collapse under one sentence, e.g. "Changed 2
   files, ran 1 command, read 2 files" or "Used Slack and Linear, ran 1
   command". The sentence names at most three actions, counts unique files for
   reads and edits, and ends with "N other actions" for the rest. A group that
   is live or parked starts open.
4. **One-line rows.** Each row is a kind icon, a verb, then the target: the
   command, a path relative to `/workspace`, a search query, or the URL host.
   The verb is muted and the target uses the foreground colour; commands and
   paths are mono. The status sits at the trailing edge: a spinner while
   running, the duration once done, `✕ Failed · 3.6s`, `Denied`,
   `Needs approval`, or `Waiting for client result`. A failed row also tints
   its icon. While a call runs, its verb shimmers.
5. **Expandable detail.** Click a row to open it, indented under the icon
   column, with mono wells that cap at about 24rem (`max-h-96`) and scroll:
   - commands show `$ command` then the output, red when the call failed;
   - edits and writes show a line diff built from
     `old_string`/`new_string`/`content`, with +/− counts on the row;
   - reads show the file content;
   - everything else shows Input JSON then Output, pretty-printed when the
     result is JSON.

   Output longer than 20 lines or 4k characters is truncated, with a
   `Show N more lines` toggle.
6. **Thinking.** A thinking block is a row with a brain icon and a one-line
   preview of the thought. Clicking it shows the full markdown. A thought still
   streaming shows a shimmering `Thinking`.
7. **Live state.** A `Working for 34s` row replaces the typing dots. Tool input
   that is still streaming renders as a running row in the same shape and is
   swapped for the real row once the canonical `tool_use` lands.
8. **MCP labels.** An MCP call reads `Slack · search channels`, from either
   `agent.mcp_tool_use` (with `mcp_server_name`) or an `mcp__<server>__<tool>`
   name. A tool name that repeats its server prefix (`slack_post_message`) is
   trimmed.

## Deliberately not copied

- **Virtualized scroll lists** inside expanded groups (T3 uses LegendList),
  along with its scroll anchoring and fade masks. Our groups are short enough
  that a plain list does the job.
- **T3-specific row kinds**: thread or PR links, subagent notifications,
  worktree setup, usage-limit cards, image previews and approval rows. Our
  approvals keep the existing `ToolConfirmationControls`, now shown inline
  under the row.
- **Hover timestamps** on each row. We show each call's duration instead.
- **Per-row hide-after-turn logic for steers.** OMA has no steering; a new
  `user.message` simply starts a new turn.
