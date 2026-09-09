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
or create a model card through the console. Use the default OMA harness for API
billing, or the opt-in Codex subscription path below for single-operator testing.
The Claude Code SDK harness runs tools on the API host and is rejected for agent computers.

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
first session. Set `metadata.default_environment_id` on the agent to make the
Computer controls and scheduled ambient sessions use its chosen environment.

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

## Full Linux desktop

For Daytona's native desktop, set `sandbox.desktop: true` alongside
`sandbox.browser: true`. A prebuilt Daytona snapshot avoids installing the
operating system packages on every new computer:

```json
{
  "provider": "daytona",
  "scope": "agent",
  "snapshot": "daytona-medium",
  "workdir": "/workspace",
  "bootstrap_tools": false,
  "browser": true,
  "desktop": true,
  "idle_stop_minutes": 10
}
```

A snapshot must include Chromium, Node.js, curl, util-linux, and Daytona's
computer-use dependencies. Debian-based custom images can instead use
`bootstrap_tools: true` to install them. Global equivalents include
`DAYTONA_SNAPSHOT` and `MACHINE_DESKTOP=true`.

Daytona supervises Xvfb, XFCE, VNC, and noVNC. Chromium runs visibly on that
same desktop; existing browser tools still use CDP. Agents also receive
`computer_screenshot`, `computer_click`, `computer_type`, `computer_press`, and
`computer_scroll` when their browser tool configuration is enabled.

The Console's **Open desktop** button streams the desktop and allows keyboard
and mouse control. Viewing it keeps the machine awake; closing the viewer
leaves active agent work running. The console requires a modern ES2022 browser.

Chromium and VNC use private Daytona preview endpoints. Provider credentials
remain on the API server. The browser receives a tenant-scoped, single-use
WebSocket ticket that expires in 30 seconds; the gateway also verifies its
Origin. Set `PUBLIC_BASE_URL` to the console's public origin and allow WebSocket
upgrades through your reverse proxy.

For standing incident monitoring, create an ambient schedule rule, for example
`* * * * *` in UTC, and set the agent's `metadata.default_environment_id`.
Every wake runs in a fresh session on the same persistent computer. The cloud
API must remain running for schedules to fire. This schedules model turns;
it does not keep an infinite model request open. Save checker state and incident
history in `/workspace` so later wakes can detect changes.


## API

All endpoints require the owning tenant's authentication and an existing agent.

| Endpoint | Result |
| --- | --- |
| `GET /v1/agents/:id/machine` | Supported flag and public machine state |
| `POST /v1/agents/:id/machine/start` | Create or resume the computer |
| `POST /v1/agents/:id/machine/stop` | Preserve disk and stop when idle |
| `GET /v1/agents/:id/machine/screenshot` | PNG of the desktop, or current browser tab in headless mode |
| `POST /v1/agents/:id/machine/desktop-ticket` | Short-lived ticket for the live desktop WebSocket |

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

### OpenAI GPT-6 Astra

Set `OPENAI_API_KEY` on the server and select `gpt-6-astra` on the agent.
The default harness uses the Responses API for Astra's function tools,
including browser and desktop actions. The default and `instant` reasoning
settings use Astra's minimum supported effort, `low`; the existing `max`
setting maps to `xhigh`. Responses are not stored at OpenAI; the harness
replays its durable history, including encrypted reasoning when returned.
Create a new session after changing the agent model because existing sessions
retain the agent version they started with. Scheduled wakes use the latest
agent version.

A provider failure after successful tool calls now fails the turn visibly
instead of reporting a successful completion with no final answer.


### Codex subscription testing (single operator)

Agent computers can also use `harness: "codex-sdk"` when the operator explicitly
sets `OMA_ENABLE_CODEX_SDK=1`. This path uses the official Codex SDK and the
operator's ChatGPT sign-in, including `gpt-6-astra`. It does not use an OpenAI API
key. Subscription usage limits still apply.

Set `OMA_CODEX_HOME` to a private persistent directory, with an authenticated
`auth.json` from `codex login` (directory mode 700, file mode 600). Alternatively,
set the deployment secret `OMA_CODEX_AUTH_JSON` to that file's contents; the
server seeds the cache only if absent, preserving subsequent CLI token refreshes.
Credentials stay on the API host and are never mounted in Daytona. Keep this
opt-in harness limited to a trusted single-operator deployment.

For agent-scoped computers the Codex process has native shell/image/browser tools
and host plugins disabled, a read-only local sandbox, and an allowlisted process
environment. Its authenticated MCP bridge exposes the session's prepared OMA
tools; `bash`, file tools, browser and desktop actions execute on Daytona.
Screenshots are returned as MCP image blocks. Native `apply_patch` cannot write
in the read-only local sandbox; use OMA `write` / `edit` / `bash` on the computer.
Tools awaiting approval are omitted, and pinned access policies are rejected.
The Codex thread ID and auth cache persist across API-server restarts.
