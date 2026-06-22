# Agent Deployments — frontend access with publishable keys

Status: implemented (management API + public gateway on both runtimes,
`@openma/agent-sdk` client, Console UI).

## The problem

Tenant API keys (`oma_...`) grant full account access — they can never ship in
a browser bundle. Until now the only way to put an OMA agent behind a product
frontend was to build a bespoke backend proxy. **Deployments** close that gap:
publish an agent once, get a *publishable key* (`oma_pk_...`) that a frontend
can hold directly.

## Concepts

| Object | What it is |
|---|---|
| **Deployment** | A published pointer: agent (optionally pinned to a version) + optional environment + CORS origin allowlist + a publishable key. Stored in KV (`CONFIG_KV` on CF, `kv_entries` on Node) — no migrations. |
| **Publishable key** | `oma_pk_...`, sha256-hashed at rest, shown once at create/rotate. Scope: create sessions of the deployed agent and drive *those sessions only*. |
| **Public gateway** | `/public/v1/*` — publishable-key-authed, CORS-enabled mount that re-dispatches into the same sessions route bundle the private API uses (tenant injected after key auth), so session semantics stay identical. |

## Management API (tenant-authed)

```
POST   /v1/deployments                 {agent_id, agent_version?, environment_id?, name?, allowed_origins?}
                                       → record + key (key shown ONCE)
GET    /v1/deployments                 → {data: [...]}
GET    /v1/deployments/:id
POST   /v1/deployments/:id             {name?, allowed_origins?, disabled?, environment_id?, agent_version?}
POST   /v1/deployments/:id/rotate_key  → record + new key (old key dies)
DELETE /v1/deployments/:id
```

## Public gateway (publishable-key-authed)

Auth: `Authorization: Bearer oma_pk_...` (or `x-deployment-key`).

```
POST /public/v1/sessions                       {title?}     → sanitized session
GET  /public/v1/sessions/:id                                → sanitized session
POST /public/v1/sessions/:id/events            {events:[...]}
GET  /public/v1/sessions/:id/events            (history; supports limit/after_seq)
GET  /public/v1/sessions/:id/events/stream     (SSE; supports replay=1 + Last-Event-ID resume)
```

Hard limits enforced by the gateway:

- **Agent pinning** — the client cannot choose the agent, environment, vaults,
  or resources; those come from the deployment. Body fields attempting to
  override are ignored.
- **Event allowlist** — only `user.message`, `user.interrupt`,
  `user.tool_confirmation`, `user.custom_tool_result` pass through.
- **Session ownership** — a key can only see sessions it created (binding is
  recorded at create time; cross-deployment access 404s).
- **Response sanitization** — session responses expose `id/status/title/
  created_at/updated_at` only; the agent snapshot (system prompt, tools,
  vault ids) never reaches the public client.
- **CORS** — `allowed_origins` unset → `*` (a publishable key is public by
  design); set → only listed origins receive `Access-Control-Allow-Origin`.

## Client SDK

`packages/agent-sdk` → npm `@openma/agent-sdk`. See its README for full
usage; the short version:

```ts
import { AgentClient } from "@openma/agent-sdk";

const client = new AgentClient({ baseUrl, deploymentKey: "oma_pk_..." });
const session = await client.createSession({ title: "Support chat" });
for await (const ev of session.chat("Hello!")) {
  if (ev.type === "agent.message_chunk") render(ev.delta);
}
```

`session.stream()` replays history then tails live events and auto-reconnects
with `Last-Event-ID` resume, so a flaky mobile connection neither loses nor
duplicates events. `client.resumeSession(id)` re-attaches after a page reload.

## Implementation map

| Piece | Path |
|---|---|
| Routes + storage + gateway | `packages/http-routes/src/deployments/index.ts` |
| Node wiring | `apps/main-node/src/index.ts` (`/v1/deployments`, `/public/v1`) |
| CF wiring | `apps/main/src/index.ts` (same mounts; per-tenant services resolved after key auth) |
| Frontend SDK | `packages/agent-sdk/` |
| Tests | `test/unit/deployments-routes.test.ts` |

## Future work

- Per-deployment rate limits / daily session caps (currently inherits the
  tenant's session-create limits only).
- Optional end-user identity claims (signed visitor tokens) so one deployment
  can partition sessions per end-user.
- Event-stream filtering knobs (e.g. hide `agent.tool_result` payloads from
  public clients).
