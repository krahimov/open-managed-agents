# Agent computers

An agent computer is a persistent Daytona Linux machine shared by an agent's
sessions. The Node API server runs the model loop and durable work queue in the
cloud. Closing the console or disconnecting its event stream does not cancel a
submitted task.

The computer includes a shell, Python, Git, Node.js, coding utilities, a shared
`/workspace`, and optionally Chromium. Browser tools connect to Chromium inside
that same machine. Downloads land in `/workspace/downloads`. The console's
Computer section shows its state and an authenticated browser screenshot.

## Run on a cloud server

Run `apps/main-node` on Railway or another continuously running Node host. Use a
persistent database and file storage. For a single replica, SQLite databases and
file storage can live on a mounted volume. Running the API on your laptop still
requires that laptop to remain awake, even when the sandbox itself is remote.

Configure the server:

```dotenv
SANDBOX_PROVIDER=daytona
SANDBOX_SCOPE=agent
DAYTONA_API_KEY=<your Daytona key>
SANDBOX_IMAGE=node:22-bookworm
MACHINE_BROWSER=true
MACHINE_IDLE_STOP_MINUTES=30
OMA_DEFAULT_HARNESS=default
```

Keep authentication enabled for a public deployment. Set an API model credential
or create a model card through the console. Use the default OMA harness; the
Claude Code and Codex SDK harnesses still run their native tools on the API host
and are rejected for agent computers.

An environment can opt in instead of setting `SANDBOX_SCOPE` globally:

```json
{
  "name": "agent-computer",
  "config": {
    "type": "cloud",
    "sandbox": {
      "provider": "daytona",
      "scope": "agent",
      "image": "node:22-bookworm",
      "workdir": "/workspace",
      "browser": true,
      "idle_stop_minutes": 30
    }
  }
}
```

Enable browser tools on the agent:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [{ "name": "browser", "enabled": true }]
}
```

Start a session using that agent and environment. When the server default is
agent scope, the agent's Computer section can provision a computer before the
first session. With an environment opt-in, create the first session before
using the Computer controls.

## Persistence and lifecycle

- Sessions of the same tenant and agent share one computer and `/workspace`.
  They are not filesystem security boundaries from each other. Different agents
  and tenants receive different machines.
- Session outputs use `/mnt/sessions/<session-id>/outputs`. Creating another
  session does not remove prior output files.
- Stop preserves the provider disk. Start reconnects to that disk and restarts
  Chromium. Detaching or deleting a session does not delete its computer.
- Active turns and tracked background processes keep the computer awake. Stop
  returns `409` while work is active. Closing a preview does not stop work.
- Idle machines stop according to `MACHINE_IDLE_STOP_MINUTES`. There is no
  automatic disk deletion. Stopped machine storage may still incur provider
  charges.
- The machine configuration is frozen on first creation. A session requesting a
  different image, browser setting, or tool configuration is rejected instead
  of silently replacing the computer.
- Explicit stop attempts a `/workspace` backup. A deleted provider machine can
  be recreated and restored from its last successful backup. Unbacked files,
  running processes, and browser memory cannot be recovered from a lost disk.
- API process crash recovery uses the existing session recovery behavior. A
  client disconnect continues normally; an API process crash is a different
  failure and may require retrying the interrupted model turn.

Chromium uses a private Daytona preview endpoint. Preview credentials stay on
the API server, and the console receives only an authenticated PNG response.
This implementation provides a browser preview, not a streamed Linux desktop.

## API

All endpoints require the owning tenant's authentication and an existing agent.

| Endpoint | Result |
| --- | --- |
| `GET /v1/agents/:id/machine` | Supported flag and public machine state |
| `POST /v1/agents/:id/machine/start` | Create or resume the computer |
| `POST /v1/agents/:id/machine/stop` | Preserve disk and stop when idle |
| `GET /v1/agents/:id/machine/screenshot` | PNG preview of the current browser tab |

The existing session outputs API lists and downloads generated files. Browser
preview requests do not start a stopped computer. Listing or downloading session
outputs resumes a stopped computer to read its disk.

## Acceptance check

1. Create an agent with the default toolset and browser enabled.
2. Start a session with an agent-computer environment.
3. Ask it to write a file in `/workspace`, open a local HTML file in Chromium,
   and save a result in its session outputs directory.
4. Disconnect the event stream while the task is running, then reconnect and
   verify that the final message and output file are available.
5. Start a second session for the same agent and verify that it reads the
   original workspace file and connects to the existing Chromium context.
6. Stop and start the idle computer. Verify that the workspace file survives.
7. Verify that a second tenant cannot inspect, stop, or preview that computer.

Local regression tests cover lifecycle leases, duplicate creation, session
output isolation, background process completion, stop/start and recovery,
HTTP authorization, preview handling, and completion after SSE disconnection.
A live provider test is required to validate the deployed credentials, Linux
image, preview routing, and real model tool use together.

## Automated cloud smoke test

Set `OMA_BASE_URL` and `OMA_API_KEY` for an isolated deployment, then run:

```sh
node scripts/agent-computer-smoke.mjs /tmp/computer-evidence.json
```

The script subscribes before submitting work, disconnects during the first
shell command, and checks the shared browser and files. It verifies that a
random value written to browser localStorage survives a new session and a
machine stop/start. Each session also triggers a browser download and reads
its random contents from `/workspace/downloads` using the shell.

It saves JSON evidence, server error details, and a screenshot. It stops only
its own idle test computer and retains the records for inspection.
`OMA_SMOKE_MODEL` can override the test model.
