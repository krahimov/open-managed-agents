# Agent memory

Whether an agent carries anything from one session to the next. One field —
`_oma.memory` — decides it; the storage is the existing memory-store system
(`/v1/memory_stores`: blobs + index, S3 or local fs). Source of truth:
`apps/main-node/src/lib/agent-memory-mode.ts` (who owns which store, attach)
and `apps/main-node/src/lib/memory-prompt.ts` (what a session is told).
Node runtime only.

## Modes

| `_oma.memory.mode` | Effect |
|---|---|
| unset | Off. Still eligible for the automatic enable below. |
| `off` | Off, explicitly. The platform never turns it on over this; only the user (console toggle) or the setup agent's `enable_memory` does. A pinned `store_id` is kept so re-enabling finds the same notes. |
| `shared` | One store per agent (`store_id`, named `<agent id>-memory`), attached read-write to every new working session. |
| `per_user` | One store per (agent, calling principal), provisioned lazily; callers without a principal share an explicit anonymous bucket. API-only for now. |

## How it gets turned on

| Path | What happens |
|---|---|
| Setup chat | The setup agent calls `enable_memory` when the user asks it to remember, track changes over time, or run on a schedule. The handler creates the store and sets the mode; the tool result states what is now on. |
| Ambient rule created | `create_ambient_rule` (setup or working session) and `POST /v1/agents/:id/ambient-rules` enable memory unless the mode is an explicit `off`. Each firing is a fresh session, so memory is the only continuity a recurring agent has. The tool result says which case applied. |
| Console | The **Memory** switch on the agent page: `PUT /v1/agents/:id/memory {"enabled": bool}`. `GET` returns state, store, note count. |
| API | `_oma.memory` on `POST /v1/agents[/:id]`. A `shared` mode without a store is provisioned (and pinned) on the next session. |

New agents are **not** given memory by default. A chat-only agent with no
schedule keeps today's behavior and no extra store; memory is one tool call
or one click away. Existing agents are untouched.

## What a session gets

Every path that creates a working session attaches the agent's store as a
session resource (`type: "memory_store"`): the sessions route, the ambient
dispatcher, integration webhooks, Telegram. Setup sessions are skipped. The
mode is read from the session's agent snapshot, so sessions already open
keep what they started with.

The session's system prompt then carries:

1. `memoryGuidance` (only when a store is attached): check memory at the
   start, apply standing rules, save durable preferences, and — for
   recurring work — record what was delivered before finishing.
2. One block per store: where it is, how to save (normal file tools — there
   is no separate memory tool), a newest-first listing of saved notes, and
   the newest notes inline (≤ 3,000 chars per note, ≤ 6,000 per store, ≤ 12,000
   per session).

The block is snapshotted per session and reused for 30 minutes, so the
prompt stays byte-stable while the agent writes notes mid-conversation.

| Harness | Where the store appears |
|---|---|
| default, pi, codex-sdk on an agent computer | `/mnt/memory/<store name>/` (sandbox mount) |
| claude-agent-sdk, codex-sdk on the host | `./memory/<store name>/`, materialized before the turn and written back after (`sdk-harness-memory.ts`) |

## Setup mode

Setup sessions keep their small toolset and no file access, but the
preamble now says that those limits belong to setup only: working sessions
have files, a shell and (when on) memory, and setup limits must not be
written into the working system prompt. The preamble carries a live
`MEMORY STATUS` line; the agent may only claim it will remember when that
line or a tool result says memory is on, and must not offer external
storage as a substitute.

## Not covered

- CF runtime (`apps/main`): accepts and returns `_oma.memory` but has no
  attach hook, so the field has no effect there.
- Fact indexing / search tools / per-turn push (PR #19, "memory facts v2")
  are separate; this uses the same `_oma.memory` shape so the two compose.
