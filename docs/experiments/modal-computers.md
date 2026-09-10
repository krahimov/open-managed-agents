# Modal computers experiment

Branch: `codex/modal-cloud-computers`. Production still uses Daytona.
Do not merge or select a replacement provider until the live Modal agent test
and Cua comparison are complete. The live Modal harness check has passed;
the full HTTP deployment test and Cua comparison are still pending.

## Implementation

Set these variables on an isolated Orrery Node server:

```dotenv
SANDBOX_PROVIDER=modal
SANDBOX_SCOPE=agent
SANDBOX_IMAGE=node:22-bookworm
MODAL_TOKEN_ID=...
MODAL_TOKEN_SECRET=...
MODAL_APP_NAME=orrery-modal-comparison
MACHINE_BROWSER=true
MACHINE_DESKTOP=true
MACHINE_IDLE_STOP_MINUTES=10
```

Optional `MODAL_ENVIRONMENT` selects a Modal environment. `MODAL_IMAGE_ID` selects
an existing Modal filesystem image instead of the registry image. Environment
configuration can also select `sandbox.provider=modal`, `scope=agent`, `desktop=true`
and an image or snapshot. Credentials come only from the operator environment.
Use a separate database and test agent. Do not reuse a Daytona agent's identity.

The provider uses Modal's JavaScript SDK 0.10.0 and a CPU VM with one physical
core and 4 GiB of RAM. No GPU is requested. Internet egress uses Modal's default
network policy. VNC and CDP use private Connect tokens. The Orrery server forwards
those tokens in headers; the console receives only its existing short-lived
single-use desktop ticket.

The Modal transport implements the structural box interface introduced by the
Daytona adapter. Both use the existing session file/resource sync, vault proxy,
background-process handle and generation checks. The Modal path does not load
or call the Daytona SDK. Provider identity is frozen in the machine config;
changing an existing agent's provider is rejected.

On stop, Orrery refuses active work/viewers, closes Chromium through CDP, creates
a filesystem snapshot, commits its image ID to the machine row, then terminates
the VM. Snapshot or database failure must leave the live VM intact. Starting
restores a new VM from that image and increments the generation. New VM startup
removes stale X11 and Chromium lock files. Filesystem snapshots include the
browser profile, downloads and all session output directories. They do not
resume processes or memory.

Background commands have a detached supervisor inside the VM. Completion,
stdout, stderr, PID and boot identity are stored on disk so a host restart can
inspect orphan work and prevent idle shutdown while it is still running.

## Limits before rollout

- Modal imposes a 24-hour VM lifetime. Idle stops checkpoint first, but this
  branch does not yet migrate continuously active jobs across that boundary.
  A job running past the limit can lose work since the last checkpoint. If no
  checkpoint exists, acquisition fails rather than silently creating an empty
  computer. This is a rollout blocker for arbitrary long-running jobs.
- Checkpoints have no expiry so a dormant agent does not lose its disk. A
  successful later stop deletes the superseded checkpoint. Account cleanup must
  remove retained images when the experiment or agent is retired. A process
  crash between snapshot creation and its database commit can leave an orphan
  image; automatic orphan-image collection is not implemented yet.
- The host scheduler must remain available for idle shutdown. If the host dies,
  cloud work continues until the provider's lifetime limit. Production would
  need a reliable scheduler and recovery policy.
- The initial implementation supports agent scope only. Desktop-enabled images
  require Debian tools. Per-agent CPU/memory settings are not exposed yet.
- Cross-provider migration of an existing computer is not implemented.
- Real external account sign-in/refresh, a deployed HTTP/session-queue test,
  and a Cua live comparison remain acceptance checks. The live test used the
  actual Orrery Codex harness and MCP tool bridge with an in-memory machine
  store. It did not deploy or exercise the full server HTTP/session queue.

## Validation and comparison

The earlier isolated Python infrastructure trial verified external websites,
Chromium clicks, live noVNC input, downloads, detached background work, and file,
localStorage and test-cookie persistence across VM replacement. That trial is
separate from this JavaScript/Orrery implementation and does not prove it works.

Local validation on September 10: 108 sandbox tests passed; 273 server tests
passed with 14 existing skips. Both package typechecks passed.

The JavaScript branch acceptance test passed on September 10:

- Computer startup took 33.9 seconds using a cached registry image.
- Chromium returned HTTP 200 for Example.com, GitHub, Google and DuckDuckGo.
- Native desktop keyboard input navigated Chromium to Example.com.
- The desktop endpoint rejected unauthenticated HTTP requests with 401 and
  accepted the authenticated request with 200.
- The real Orrery Codex harness used the browser and desktop tools, then wrote
  and verified `MODAL_AGENT_OK` through its remote shell tool.
- Background work completed after the session detached.
- A new VM restored workspace files, browser localStorage and a persistent test
  cookie from the committed snapshot. Generation advanced to 2.
- Both test VMs and the checkpoint were deleted after the successful run. An
  earlier failed VM was also cleaned up.

The first live attempt found that Modal's `waitUntilReady()` requires an explicit
readiness probe. The driver now returns the sandbox identity promptly and lets
Orrery's bootstrap commands wait for the guest. This also keeps resource identity
available to the manager before bootstrap completes.

Run the opt-in live script from `apps/main-node` with an absolute artifact directory:

```sh
OMA_MODAL_SMOKE_DIR=/absolute/test-artifacts OMA_MODAL_SMOKE_CODEX=1 \
  pnpm exec tsx scripts/modal-computer-smoke.ts
```

Supply Modal credentials through environment variables. The Codex harness also
requires its operator-approved private auth cache. The script provisions billable
resources and terminates its owned VMs and checkpoint in `finally`.

Run local checks:

```sh
pnpm --filter @open-managed-agents/sandbox test
pnpm --filter @open-managed-agents/sandbox typecheck
pnpm --filter @open-managed-agents/main-node test
pnpm --filter @open-managed-agents/main-node typecheck
```

Use the same workload with Modal and Cua: launch an Orrery agent, navigate public
sites, manipulate a browser page and the desktop, create/download files, finish
background work after disconnect, reconnect from a new host process, then stop
and restore. Verify files and a test cookie independently. Record startup time,
completion time, failure/recovery behavior, authenticated desktop access and
actual provider usage. Terminate test computers and remove owned snapshots after
collecting evidence. The user chooses the provider after reviewing both results.

References:

- https://modal.com/docs/sdk/js/latest/Sandbox
- https://modal.com/docs/guide/vm-sandboxes
- https://modal.com/docs/guide/sandbox-snapshots
- https://modal.com/docs/guide/sandbox-networking
