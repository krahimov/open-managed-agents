# Muse console on main: port notes

Step 0 (baseline) of `~/Desktop/oma-redesign-r3/_rig/notes/muse/port-scout/PLAN.md`, option C, with the plan's "Adversarial check" corrections applied. Read the plan for the why; this file is the what.

## Refs

- Branch `feat/muse-console` in `~/Desktop/oma-muse-prod`, created from `origin/main` = **e9d33b8d2** (Merge PR #53).
- Muse console source: tip of `redesign-r3/muse` = **af3ace2c1** ("fix(console): muse — a failed send's notice in dark…", 2026-11-13 21:53). This is newer than the a6eaaa27a the plan names; the Muse worktree was clean at this commit. Every Muse commit on top of redesign/base touches only `apps/console/`.
- Main's console as it stands: read-only checkout `~/Desktop/oma-main-scout` (e9d33b8d2). Read main's version of any file there.

## What the baseline did

1. `apps/console/` now equals Muse at af3ace2c1 (the 72 files only main had were removed first), then main's pieces below were brought back.
2. **Main tests waiting to be ported**: the 19 main test files Muse lacks that are not pure-lib tests are in `apps/console/src/__main_tests__/`, at their original relative paths (`__main_tests__/pages/SessionDetail.hitl.test.tsx` was `src/pages/SessionDetail.hitl.test.tsx`). The folder is excluded from vitest (`vitest.config.ts` `exclude`) and from tsc (`tsconfig.json` `exclude`). Their imports are relative to the original location, so they do not compile where they are. **Move each one next to the code it tests, rewrite it for Muse, and delete it from the folder.** The folder must be empty at integration, when the lead removes both excludes.
3. **Main's pure libs and their tests, verbatim** in `src/lib/`: app-version, update-prompt, chunk-reload, lazy-route, composer-draft, deferred-mcp, tool-status, event-key, default-environment, oauth-popup, markdown-urls, attachments, session-outputs, telegram-mini-app (12 test files; all pass). Do not edit them; if one must change, tell the lead.
4. `package.json` and `vite.config.ts` are main's (adds `@novnc/novnc ^1.7.0`, `build.target: "es2022"`, `/v1` proxy `ws: true`). The lockfile already had novnc, so `pnpm install` changed nothing. `src/novnc.d.ts` is main's.
5. `lib/api.ts`: a 2xx response on `/v1/*` or `/public/v1/*` whose body is a web page (content-type text/html, or a non-JSON body starting with `<`) throws `ApiError{status: 404, code: "not_on_server"}`. It reports like any 404: silent with `silentErrors` or `quietNotFound`, otherwise the usual read/write reporting. New exports: `NOT_ON_SERVER_CODE`, `isNotOnServer(err)` (true for 404 and 501).
6. New `lib/server-features.ts` (+ test). See "Feature detection".
7. `mocks/handlers.ts` now answers `GET */v1/server_features` with **every** feature on, so existing Muse tests keep the backend they were written for. See "Tests".
8. `skills/orrery-agent-builder/` (repo root, additive) copied from Muse's tree. Muse's `lib/harness-agent-builder-skill.ts` imports its SKILL.md with `?raw`; main only had `skills/harness-agent-builder/` (kept), so test and build failed without it. The Dockerfile does `COPY . .`, so prod builds see it.
9. Contract stubs (below), each rendering `null`, with a doc comment saying what it must do.

Gate at the baseline commit: `corepack pnpm --filter managed-agents-console typecheck` passes, `test` 50 files / 390 tests pass, `build` passes.

## Contracts

Props are fixed. The owner fills in the body. Callers may render them now (they render nothing). Do not change a contract's props without the lead. Extra optional props are allowed only if the other side's slice is told.

| Component | File | Owner | Rendered by | Props |
|---|---|---|---|---|
| `SavedLoginLine` | components/SavedLoginLine.tsx | C5 | C3 (card kind `saved_login`), C6b (SessionChat) | `event: Event`, `sessionId?: string`, `switched?: boolean` |
| `MemoryEnabledCard` | components/MemoryEnabledCard.tsx | C6b | C3 (card kind `memory_enabled`), C6b (SessionChat) | `event: Event` |
| `AgentMemoryPanel` (+ `AgentMemoryResponse`) | components/AgentMemoryPanel.tsx | C6b | C6a (Overview) | `agentId: string` |
| `AgentModelSwitcher` | components/AgentModelSwitcher.tsx | C6b | C6a (Overview, Model row) | `agent: AgentRecord`, `onSaved?: (agent: AgentRecord) => void` |
| `SessionModelPicker` | components/SessionModelPicker.tsx | C6b | C4 (SessionComposer chip slot), C6b (SessionChat) | `sessionId: string`, `disabled?: boolean` |
| `AgentComputerPanel` | components/AgentComputerPanel.tsx | C6a | C6a (Overview) | `agentId: string`, `localRuntime?: boolean`, `defaultEnvironment?: EnvironmentChoice \| null` |
| `TurnFiles` | components/sessions/TurnFiles.tsx | C4 | C3 places it under an agent turn; C4 decides the files | `sessionId: string`, `files: SessionOutputFile[]` (test id `turn-files`) |
| `MessageAttachmentChips` | components/sessions/AttachmentChips.tsx | C4 | C3 places it under a user message (`metadata.attachments`) | `attachments: MessageAttachment[]` (test id `message-attachments`) |
| `ApprovalControls` | components/sessions/ApprovalControls.tsx | C3 | C3 (approval card, tool rows) | `sessionId: string`, `toolUseId: string`, `threadId?: string`, `server?: string`, `tool?: string` |
| `AccessRequestCard` new props | components/AccessRequestCard.tsx | C5 | C3 (ConversationView), C6b (SessionChat), C1 (TelegramConnect) | adds `granted?: boolean` and `vaultId?: string` to the existing `event`, `state?`, `sessionId?` |

Event shape: `Event` is `lib/events` (identical on main and Muse). Muse's conversation model already carries the raw event on `card` items (`{ kind: "card", card, event }`). C3 adds `card: "memory_enabled" | "saved_login"` there.

The rules that cross slices:

- **access_granted fold (owner C3).** C3 folds `system.access_granted` events (by `request_id`) in components/sessions/model.ts, and passes the result as `granted` to AccessRequestCard and `switched` to SavedLoginLine. C3 also does this in SessionChat's render path; C6b owns SessionChat.tsx, so C6b uses `grantedRequestIds(events): Set<string>`, which the baseline already exported from components/sessions/model.ts (C3 owns it; keep the signature). C5's card must never post its "[access granted]" nudge when `granted` is true, or when the popup's `oauth_complete` carries `grant_recorded: true` (correction 5: otherwise every start-token connect wakes the agent twice).
- **HITL.** `ApprovalControls` posts `user.tool_confirmation` to `/v1/sessions/:id/events` through C3's `useSessionOperations(sessionId).decide(toolUseId, result, { threadId, denyMessage })`. `session_thread_id` is sent only when the thread is not `sthr_primary`. Use the `/v1/operations/...approvals` path only when `useServerFeature("operations")` is on. `canOperate` is true when `/v1/workspace/access` is missing.
- **Computer delete text.** C6a exports `agentMachineQueryKey`, `loadAgentMachine` and `deleteAgentConfirmText` from AgentComputerPanel.tsx as main does, and uses them in its own AgentDetail.
- **Reasoning.** Use api-types' `UI_REASONING_LEVELS` and `DEFAULT_REASONING_LEVEL` ("medium"). Unset means inherit, never "Instant". This applies to every picker, including the eval judge list in lib/evals.ts (C6b).

## Feature detection (`lib/server-features.ts`)

- `useServerFeature(key: ServerFeature): boolean`. It is false while loading and when the read failed, so a surface stays hidden rather than flashing in and erroring. `useServerFeatures()` returns the query: `{ features: Set, source: "server" | "probe" }`. `SERVER_FEATURE_KEYS` (const tuple) and `type ServerFeature` are exported. So are `SERVER_FEATURES_QUERY_KEY` (tests can `setQueryData`) and `loadServerFeatures(api)`.
- Keys: `operations`, `workspace_access`, `usage`, `missions`, `workspace_admin` (members/role/audit), `budgets`, `scoped_keys`, `simulations`, `draft_scenarios`, `comparisons`, `memory_writes`, `skill_versions`, `runtimes`, `cap_cli`.
- Source: one cached `GET /v1/server_features` → `{ features: string[] }`. Unknown keys are ignored. The answer is cached for the life of the tab (staleTime Infinity, no focus refetch).
- **B1 must add `GET /v1/server_features`**, registered before `app.route("/v1", v1)`, answering `{ features: ["workspace_access", "usage"] }` for this release. Each later wave adds its key.
- A server without the endpoint (404, 501, or the HTML page turned into `not_on_server`) gets probe mode. Every feature is off except those a quiet GET confirms: operations (`/v1/operations`), workspace_access (`/v1/workspace/access`), usage (`/v1/usage?since=1&until=2`), workspace_admin (`/v1/workspace/members`), budgets (`/v1/workspace/budgets`) and comparisons (`/v1/evals/comparisons`). Write-only features stay off. This keeps the Muse demo backend (redesign/base, :8790) working.
- **B1 shim shape** (correction 3). Muse reads `lib/operations.ts` `WorkspaceAccess` = `{ authorization: { role: "owner"|"admin"|"operator"|"viewer", kind, scopes? }, budgets_supported: false }`. The role is nested. Map main's `member` to `admin` (or owner), and never return `authorization: null`: auth-disabled and api_key callers get `{ role: "owner", kind }`. Otherwise approvals lock and the access-policy editor disappears.

## Tests

- **Run the console with** `corepack pnpm --filter managed-agents-console typecheck|test|build`. `--filter console` matches nothing and exits 0.
- msw is strict (`onUnhandledRequest: "error"`). The global handler in `mocks/handlers.ts` answers `/v1/server_features` with every feature on. To test a hidden surface: `server.use(http.get("*/v1/server_features", () => HttpResponse.json({ features: [] })))`.
- Many Muse tests mock `useApi` wholesale (`vi.mock("../lib/api", …)`, e.g. pages/Operations.test.tsx). Once a component calls `useServerFeature`, that mock receives `"/v1/server_features"`. Answer it, e.g. `if (path === "/v1/server_features") return { features: [...SERVER_FEATURE_KEYS] }`. A mock that throws a plain Error turns every feature off. `isNotOnServer` still comes from the real module when the mock spreads `original`.
- A ported main test is "done" when it lives next to its code, passes, and is deleted from `__main_tests__/`.

## File ownership

Each slice edits only its own files. A dependency on another slice goes through a contract above, or through the lead. The lead (baseline) owns, and has frozen: `lib/api.ts`, `lib/server-features.ts(+test)`, `mocks/handlers.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json`, `vite.config.ts`, `src/novnc.d.ts`, the verbatim main libs in src/lib, `lib/operations.ts` (types read by C2/C3 and matched by B1), and `skills/orrery-agent-builder/`. Ask the lead for a change to any of them.

**B1, backend (apps/main-node only)**: `src/lib/console-static.ts`, `src/index.ts`, `src/lib/node-harness-runtime.ts`, `src/lib/claude-agent-sdk-harness.ts`, `src/lib/codex-sdk-harness.ts`, new `src/lib/workspace-access-routes.ts`, new `src/lib/node-usage-tracker.ts` (from 6fe359558). Tests go in `test/v1-not-found.test.ts`, `test/workspace-access-shim.test.ts` and `test/node-usage-tracker.test.ts`. Per correction 9, prefer extending the existing `test/console-static.test.ts` for the JSON-404 cases (`/v1/x`, `/v1/oma/x`, `/public/v1/x`). B1 also adds `GET /v1/server_features` (above). Per correction 7, codex-sdk-harness already has `recordUsage`, so wire it rather than cherry-picking.

**C1, shell, runtime and Telegram**: `src/main.tsx`, `components/AppShell.tsx`, `components/AppSidebar.tsx`, `components/navigation.tsx`, `components/CommandPalette.tsx`, new `components/TelegramOnboarding.tsx`, new `pages/TelegramConnect.tsx` (+ ported `__main_tests__/pages/TelegramConnect.test.tsx`), and the lib tests for app-version, chunk-reload, lazy-route and composer-draft (already in src/lib and passing). **Extra: `src/index.css`, except the `--needs-you-*` tokens.** Also per correction 10: gate the `/_kit` route on `import.meta.env.DEV` (main.tsx:311).

**C2, honest degradation of base-only surfaces**: `lib/directory.ts`, `pages/Operations.tsx` (+test), `components/operations/*`, `components/home/RightNow.tsx`, `components/home/SinceLastVisit.tsx`, `pages/SessionsList.tsx`, `pages/Dashboard.tsx`, `pages/UsagePage.tsx`, `pages/usage/*`, `pages/ModelCardsList.tsx` (+ ported `__main_tests__/pages/ModelCardsList.test.tsx`), `pages/WorkspaceSettings.tsx`, `pages/ApiKeysList.tsx` (+test), `components/RunUntilDoneDialog.tsx`, `components/MissionBanner.tsx`, `components/MissionVerdictCard.tsx`, `pages/EvalRunsList.tsx`, `pages/evals/NewSimulationDialog.tsx`, `pages/agents/AgentVersionComparison.tsx` (+test), `pages/MemoryStoresList.tsx`, `pages/MemoryStoreDetail.tsx`, `components/resources/MemoryPanels.tsx`, `pages/SkillsList.tsx`, `components/resources/SkillPanel.tsx`, `pages/RuntimesList.tsx`, `pages/ConnectRuntime.tsx`. Assigned by the baseline: `components/sessions/readings.ts` (+ readings/patience tests), which consumes `useOperations()` and is owned by no other slice. Gate `useOperations` in directory.ts (`enabled: useServerFeature("operations")`) so readings, the sidebar count and Home degrade together.

**C3, conversation logic and HITL**: `components/sessions/model.ts` (+test), `components/sessions/tools.tsx`, `components/sessions/ConversationView.tsx`, `components/sessions/RequestParts.tsx`, `components/sessions/hooks.ts`, `components/timeline/*` (+ ported `__main_tests__/components/timeline/derive.test.ts`, rewritten in Muse's vocabulary), new `components/sessions/ApprovalControls.tsx` (+ ported `__main_tests__/components/ToolConfirmationControls.test.tsx`). Also the ToolCalls intent from `__main_tests__/components/tool-calls/{ToolCalls.test.tsx,model.test.ts}` against Muse's ToolRun/ToolCallCard DOM. **Extra: the access_granted fold** (see Contracts).

**C4, composer, attachments and outputs**: `pages/SessionDetail.tsx`, `components/sessions/SessionComposer.tsx`, `components/Composer.tsx`, `components/sessions/ContextPanel.tsx`, `components/sessions/SessionHeader.tsx`, `components/home/SessionStarter.tsx`, `components/home/SessionOptions.tsx`, `components/files/*`, `pages/FilesList.tsx`, `components/Markdown.tsx`, `pages/session-detail/Panels.tsx`, new `components/sessions/TurnFiles.tsx` and `components/sessions/AttachmentChips.tsx`. Ported tests, rewritten for Muse: `__main_tests__/pages/SessionDetail.{files,hitl,agent-link}.test.tsx` (the hitl one with C3's ApprovalControls). **Extra: `components/files/refusal.ts`.**

**C5, OAuth and connections**: `components/AccessRequestCard.tsx` (+ ported `__main_tests__/components/AccessRequestCard.test.tsx`), `components/resources/AddCredentialDialog.tsx`, `components/resources/credentials.ts`, new `components/SavedLoginLine.tsx` (+ ported `__main_tests__/components/SavedLoginLine.test.tsx`), new `components/OAuthAppSetupPanel.tsx`, `pages/VaultDetail.tsx`, `pages/VaultsList.tsx`, `pages/IntegrationsApps.tsx`. **Extra: the `--needs-you-*` tokens in index.css** (only those lines).

**C6a, agent page and computer**: `pages/AgentDetail.tsx` (+ ported `__main_tests__/pages/AgentDetail.delete.test.tsx`, rewritten for ConfirmDialog), `pages/AgentsList.tsx`, `pages/agents/detail/OverviewTab.tsx`, `pages/agents/detail/parts.tsx`, `pages/agents/detail/AccessTab.tsx`, new `components/AgentComputerPanel.tsx` (+ ported `__main_tests__/components/AgentComputerPanel.test.tsx`) and `components/DesktopViewer.tsx`. Main's `pages/agents/setup-session.ts` (the Setup chat resume/create helper) was not restored. Copy it in as your own file if you want it.

**C6b, agent config: reasoning, memory, edit, default environment**: `pages/agents/AgentFormDialog.tsx` (+ ported `__main_tests__/pages/agents/AgentFormDialog.{create,edit}.test.tsx`, rewritten), `pages/agents/EditAgentDialog.tsx`, `pages/agents/form/*`, `pages/agents/AgentSetup.tsx`, `pages/agents/SessionChat.tsx`, `pages/agents/setup/*`, `pages/agents/detail/VersionsTab.tsx`, `components/MemoryModeControl.tsx`, `components/home/EnvironmentPicker.tsx`, `components/home/session-options.ts`, `components/sessions/NewSessionDialog.tsx` (+ the intent of `__main_tests__/pages/SessionsList.new-session.test.tsx`), `types/agent.ts`, new `components/AgentMemoryPanel.tsx`, `components/MemoryEnabledCard.tsx`, `components/ModelReasoningPicker.tsx`, `components/AgentModelSwitcher.tsx`, `components/SessionModelPicker.tsx`. Ported tests: `__main_tests__/components/{AgentMemoryPanel,MemoryEnabledCard,ModelReasoningPicker}.test.tsx`. **Extra: `lib/evals.ts`, `components/evals/fields.tsx`, `pages/evals/NewEvalRunDialog.tsx`** (the judge reasoning list, which main extended with xhigh). Main's `pages/agents/useAgentFormAux.ts` was not restored. Copy it in as your own file if you want it.

### `__main_tests__` → owner

| File | Owner |
|---|---|
| components/AccessRequestCard.test.tsx | C5 |
| components/SavedLoginLine.test.tsx | C5 |
| components/AgentComputerPanel.test.tsx | C6a |
| pages/AgentDetail.delete.test.tsx | C6a |
| components/AgentMemoryPanel.test.tsx | C6b |
| components/MemoryEnabledCard.test.tsx | C6b |
| components/ModelReasoningPicker.test.tsx | C6b |
| pages/agents/AgentFormDialog.create.test.tsx | C6b |
| pages/agents/AgentFormDialog.edit.test.tsx | C6b |
| pages/SessionsList.new-session.test.tsx | C6b (the dialog is C6b's; SessionsList.tsx is C2's, so coordinate the mount) |
| components/ToolConfirmationControls.test.tsx | C3 (becomes ApprovalControls.test.tsx) |
| components/timeline/derive.test.ts | C3 |
| components/tool-calls/ToolCalls.test.tsx | C3 |
| components/tool-calls/model.test.ts | C3 |
| pages/SessionDetail.files.test.tsx | C4 |
| pages/SessionDetail.hitl.test.tsx | C4 |
| pages/SessionDetail.agent-link.test.tsx | C4 |
| pages/ModelCardsList.test.tsx | C2 |
| pages/TelegramConnect.test.tsx | C1 |

## Surprises and things to know

- **The Muse tip is af3ace2c1, not the plan's a6eaaa27a.** The commits after it are more Muse polish, still console-only.
- **Main-only console files not restored** (consult them in ~/Desktop/oma-main-scout; rebuild in Muse's language, do not copy main's UI): `components/ListPage.tsx`, `components/ai-elements/*`, `components/tool-calls/*`, `components/SessionFiles.tsx` (its pieces are the TurnFiles/MessageAttachmentChips contracts plus composer attach for C4), `components/ToolConfirmationControls.tsx` (→ ApprovalControls), `pages/agents/setup-session.ts`, `pages/agents/useAgentFormAux.ts`, `pages/evals/SuitesSection.tsx`, plus the new components each slice ports.
- **Other main changes since d1d0170b9 in files Muse also has** (they are all owned above; diff with `git diff d1d0170b9 e9d33b8d2 -- <file>`): AccessRequestCard, AppShell, Badge (main added `to` link badges and a `waiting` tone; Muse's Badge is a different component, so C4 builds the session-header agent link in its own files), Markdown, timeline/*, main.tsx, AgentDetail, AgentsList, FilesList, ModelCardsList, SessionDetail, SessionsList, VaultDetail, AgentFormDialog, AgentSetup, SessionChat, NewEvalRunDialog, session-detail/Panels, types/agent.ts.
- **types/agent.ts differs.** Main types `_oma.reasoning_level`, `memory`, `mcp_tool_loading` and `vault_mcp_servers` from api-types. Muse's has `reasoning_level?: string` and `memory | null` with base-only `extract/push`. C6b owns it. Until C6b lands, the other slices should not rely on either shape.
- **`api()` is the only fetch with the not_on_server guard.** Raw `fetch` callers (integrations client, file downloads/thumbnails, screenshot fetch) do not have it. Where they read JSON from a path that may be missing, check `content-type` or go through `api()`. They also lack the bearer/tenant headers (shape 12). C4 fixes downloads and thumbnails through `fetchFileContent`.
- **Detail pages treat any 404 as "this record no longer exists".** A `not_on_server` 404 is a 404, so a surface whose endpoint is missing must be hidden by `useServerFeature`, not left to the detail page's not-found state. Check `err.code === NOT_ON_SERVER_CODE` if you need to tell the two apart.
- **A local main-node without `CONSOLE_DIR` answers unknown /v1 GETs with JSON 404**, which hides finding 1. To see prod's behaviour, run with `CONSOLE_DIR=apps/console/dist`.
- **CI does not typecheck the console.** The root tsconfig excludes apps/console. Run the filtered typecheck yourself before handing back.
- `test/e2e/console.spec.ts` (Playwright) is stale on main too. Leave it out of the gate (correction 11).
- In `~/Desktop/open-managed-agents-src`, the base WIP (migrations 0006/0007) is still uncommitted. Nobody commits from that tree.
