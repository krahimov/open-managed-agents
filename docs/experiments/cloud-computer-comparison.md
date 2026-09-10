# Modal and Cua computer comparison

Tested September 10, 2026. The Modal implementation is on
`codex/modal-cloud-computers`, based on main at `d1ac584de`. Production still uses
Daytona. This experiment has not been merged or deployed to production.

Both providers ran a real Orrery Codex harness task. The agent operated Chromium,
read the Example Domain heading and wrote a verified file on its remote computer.
Modal also restored files and browser state after replacing the VM. Cua passed
reconnection to the same running computer; replacement persistence remains untested.

## Results

| Check | Modal | Cua Fleet |
| --- | --- | --- |
| Internet access | Chromium HTTP 200 for Example.com, GitHub, Google and DuckDuckGo | curl HTTPS 200 for the same four sites; Chromium loaded Example.com |
| Actual agent task | Orrery Codex harness used browser, screenshot and shell tools; verified `MODAL_AGENT_OK` | Orrery Codex harness used screenshot, keyboard and shell tools; verified `CUA_AGENT_OK` |
| Native desktop input | Passed | Passed |
| Private desktop endpoint | Unauthenticated request returned 401; authenticated request returned 200 | Used authenticated SDK connection; equivalent endpoint rejection check not performed |
| Detached background command | Completed after session detach | Completed after SDK disconnect and reconnect |
| Files after reconnect | Passed | Passed on the same running VM |
| Files after VM replacement | Passed through a committed filesystem snapshot | Not tested |
| Browser state after VM replacement | localStorage and persistent test cookie retained | Not tested |
| Startup sample | 33.9 seconds with cached registry image | 101.1 seconds with prebuilt Cua image |
| Integration in this branch | Provider adapter, lifecycle manager, console configuration, regression tests | Temporary local SDK bridge for comparison only |

Startup times are single observations with different images and resources. They
are not a performance benchmark. Modal requested one physical CPU core and 4 GiB
RAM; Cua requested two vCPUs and 4 GB RAM.

The Modal app's reported usage was $0.00735320 when checked after cleanup. Cua's
usage page had not populated yet. Billing can lag, so there is no reliable cost
comparison from this trial.

## Problems found and remaining work

The first Modal attempt called `waitUntilReady()` without a readiness probe.
Removing that call fixed startup; normal bootstrap commands wait for the guest.
The failed VM was terminated before the successful rerun.

Modal's 24-hour VM lifetime is a blocker for arbitrary long-running jobs. This
branch checkpoints on idle stop, but it does not migrate continuously active jobs
before expiry. An expired VM can lose changes since its last checkpoint. A machine
without any checkpoint fails explicitly rather than returning an empty computer.
Snapshot cleanup after agent retirement and orphan snapshot collection also need
work before rollout. See [implementation limits](modal-computers.md).

Cua's default desktop browser launcher returned an input/output error. Launching
Chromium explicitly reported an empty remote error even though the browser opened
and the agent then used it successfully. Browser startup and error reporting need
attention in a Cua adapter.

The tested `cua-sandbox` 0.4.3 Fleet transport raises `NotImplementedError` for its
filesystem snapshot operation. This establishes a limitation of the selected SDK
transport, not every Cua product. We have not established browser profile
persistence through suspend/resume or VM replacement.

Neither initial trial exercised the deployed Orrery HTTP server and session queue
or a real external account's OAuth refresh. A later [staging QA run](modal-staging-qa.md)
passed through the deployed server and queue. The Modal acceptance script used the real
Codex harness and tools with an in-memory machine store. The Cua task used the
same harness through a temporary authenticated local Python SDK bridge. A full
Cua provider integration is not part of this branch.

## Validation and cleanup

- Sandbox suite: 108 passed.
- Node server suite: 273 passed, 14 existing skips.
- Sandbox and Node server typechecks passed.
- Modal live test restored a second VM and advanced machine generation to 2.
- All test VMs, the Modal checkpoint and the Cua namespace were deleted. The
  temporary Modal app was stopped.
- Temporary test API tokens were revoked and local test credential copies were
  removed. The user's original Cua key and Codex credentials were retained.

The committed Modal script is `apps/main-node/scripts/modal-computer-smoke.ts`.
Local evidence is in `oma-modal-branch-acceptance-20260910/run2` and
`oma-cua-trial-20260910` on the operator's Desktop. Those directories include
reports, screenshots and agent tool events and are not committed to the repository.

Modal is further along for this project because the branch integrates it with
Orrery and verifies replacement persistence. The next Modal milestone is handling
the 24-hour boundary and checkpoint cleanup. The later staging QA run passed. Choosing Cua would
first require establishing its persistence contract and implementing an equivalent
provider adapter. The provider decision and any merge remain with the user.
