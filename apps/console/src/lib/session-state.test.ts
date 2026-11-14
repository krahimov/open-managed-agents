import { describe, expect, it } from "vitest";

import { quietWords, readSession, STALLED_AFTER_MS, waitingOn } from "./session-state";
import { forgetMissions, missionTitle, rememberMissions, sessionDisplayStatus, sessionTitle, shortGoal } from "./sessions";

const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const ago = (ms: number) => NOW - ms;
const MIN = 60_000;
const HOUR = 60 * MIN;

describe("one reading of a session", () => {
  it("trusts the server's status when nobody is needed", () => {
    expect(readSession({ status: "idle" })).toMatchObject({ status: "idle", label: "Idle", tone: "neutral", waiting: null });
    expect(readSession({ status: "terminated" })).toMatchObject({ status: "terminated", label: "Ended" });
    expect(readSession({ status: "running", lastEventAt: ago(4000), now: NOW })).toMatchObject({
      status: "running",
      label: "Running",
      tone: "info",
      working: true,
      stalled: false,
    });
    expect(readSession({ status: undefined })).toMatchObject({ status: "idle" });
  });

  it("reads a retrying session as retrying wherever it is shown, whatever its last event was", () => {
    // The seed's case: status `rescheduling`, last event a scheduled wake-up.
    const r = readSession({ status: "rescheduling", activity: "Waiting for a scheduled wake-up", lastEventAt: ago(5 * MIN), now: NOW });
    expect(r).toMatchObject({ status: "rescheduling", label: "Retrying", detail: "Retrying after a failure", tone: "warning" });
    // A failed turn that is being retried is retrying, not failed.
    expect(readSession({ status: "rescheduling", error: true }).label).toBe("Retrying");
  });

  it("uses the last event for detail only", () => {
    expect(readSession({ status: "running", activity: "Running a command" }).detail).toBe("Running a command");
    expect(readSession({ status: "running" }).detail).toBe("Working");
    // An activity never changes what an idle session is called.
    expect(readSession({ status: "idle", activity: "Running a command" }).label).toBe("Idle");
  });

  it("counts an unanswered access or skill request exactly as an approval", () => {
    const approval = readSession({ status: "idle", approvals: 1 });
    expect(approval).toMatchObject({ status: "approval", tone: "warning", label: "Needs approval", detail: "Waiting for your approval" });
    expect(approval.waiting).toMatchObject({ count: 1, kinds: ["approval"], summary: "1 approval" });

    const access = readSession({ status: "idle", requests: [{ kind: "access", name: "HubSpot" }, { kind: "access", name: "Retell" }] });
    expect(access).toMatchObject({ status: "approval", tone: "warning", label: "Needs access", detail: "Waiting for access to HubSpot and Retell" });
    expect(access.waiting).toMatchObject({ count: 2, access: 2, summary: "2 access requests" });

    const skill = readSession({ status: "idle", requests: [{ kind: "skill", name: "Word documents" }] });
    expect(skill).toMatchObject({ label: "Needs a skill", detail: "Waiting for the Word documents skill" });

    // The states gallery's session: two access requests and a skill request.
    const mixed = readSession({
      status: "idle",
      requests: [
        { kind: "access", name: "HubSpot" },
        { kind: "access", name: "Retell" },
        { kind: "skill", name: "Word documents" },
      ],
    });
    expect(mixed).toMatchObject({ status: "approval", label: "Waiting on you", detail: "Waiting on you: 2 access requests and 1 skill request" });
    expect(mixed.waiting?.count).toBe(3);
    expect(waitingOn(2, [{ kind: "access" }, { kind: "skill" }])?.summary).toBe("2 approvals, 1 access request and 1 skill request");
    expect(waitingOn(0, [])).toBeNull();
  });

  it("keeps the server's word while the agent is still working, and still says a person is waited on", () => {
    const r = readSession({ status: "running", requests: [{ kind: "access", name: "HubSpot" }], lastEventAt: ago(2000), now: NOW });
    expect(r.label).toBe("Running");
    expect(r.waiting?.count).toBe(1);
  });

  it("lets a person being waited on outrank a failure, and a failure outrank rest", () => {
    expect(readSession({ status: "idle", approvals: 1, error: true }).label).toBe("Needs approval");
    expect(readSession({ status: "idle", error: "The model provider rejected this workspace's key." })).toMatchObject({
      status: "errored",
      label: "Failed",
      tone: "danger",
      detail: "The model provider rejected this workspace's key.",
    });
    expect(readSession({ status: "terminated", error: true }).label).toBe("Failed");
    // A turn in flight is not failed, whatever the last one did.
    expect(readSession({ status: "running", error: true }).label).toBe("Running");
  });

  it("waits on nobody once the session has ended", () => {
    expect(readSession({ status: "terminated", requests: [{ kind: "access", name: "HubSpot" }], approvals: 1 })).toMatchObject({
      label: "Ended",
      waiting: null,
    });
  });

  it("calls a session that claims to work and has gone silent stalled, in one wording", () => {
    const quiet = readSession({ status: "running", lastEventAt: ago(4 * 24 * HOUR + 9 * HOUR), now: NOW });
    expect(quiet).toMatchObject({ status: "stalled", label: "Stalled", tone: "warning", stalled: true, working: false, detail: "No activity for 4d 9h" });
    expect(readSession({ status: "rescheduling", lastEventAt: ago(9 * 24 * HOUR), now: NOW })).toMatchObject({
      label: "Stalled",
      detail: "No activity for 9d",
    });
    // Just under the line it is still running; just over, stalled.
    expect(readSession({ status: "running", lastEventAt: ago(STALLED_AFTER_MS - 1000), now: NOW }).stalled).toBe(false);
    expect(readSession({ status: "running", lastEventAt: ago(STALLED_AFTER_MS + 1000), now: NOW }).stalled).toBe(true);
    // Silence means nothing for a session at rest, or when the time is not known.
    expect(readSession({ status: "idle", lastEventAt: ago(30 * 24 * HOUR), now: NOW }).stalled).toBe(false);
    expect(readSession({ status: "running" }).stalled).toBe(false);
    expect(quietWords(42 * MIN)).toBe("No activity for 42m");
    expect(quietWords(3 * HOUR + 12 * MIN)).toBe("No activity for 3h 12m");
  });

  it("gives the lists that know less the same answer for what they do know", () => {
    expect(sessionDisplayStatus("idle", "approval")).toBe("approval");
    expect(sessionDisplayStatus("idle", "error")).toBe("errored");
    expect(sessionDisplayStatus("running", "error")).toBe("running");
    expect(sessionDisplayStatus("rescheduling", null)).toBe("rescheduling");
    expect(sessionDisplayStatus(undefined)).toBe("idle");
  });
});

describe("the title of a run until done", () => {
  const GOAL = "Migrate every route file under src/routes to the withErrors handler, with the route tests and the type check green";
  const server = (n: number) => ({ title: `Mission mis-V1StGXR8Z5jdHi6BmyTq4 · iteration ${n}`, agent: undefined as never });

  it("names the run by its goal and the iteration once the goal is known", () => {
    forgetMissions();
    expect(sessionTitle(server(3))).toBe("Run until done · iteration 3");
    rememberMissions([{ id: "mis-V1StGXR8Z5jdHi6BmyTq4", goal: GOAL }]);
    expect(sessionTitle(server(3))).toBe("Migrate every route file under src/routes to the withErrors handler · iteration 3");
    expect(sessionTitle(server(2))).toBe("Migrate every route file under src/routes to the withErrors handler · iteration 2");
    // Another run reads as another thing.
    rememberMissions([{ id: "mis-other", goal: "Bring test coverage of the billing module to 90%" }]);
    expect(sessionTitle({ title: "Mission mis-other · iteration 1", agent: undefined as never })).toBe(
      "Bring test coverage of the billing module to 90% · iteration 1",
    );
    forgetMissions();
  });

  it("shortens a goal at a clause or a word, never mid-word", () => {
    expect(shortGoal("Fix the flaky login test.")).toBe("Fix the flaky login test");
    expect(shortGoal(GOAL)).toBe("Migrate every route file under src/routes to the withErrors handler");
    const long = shortGoal("Rewrite the ingestion pipeline so that every connector streams records through the new batching layer without loss");
    expect(long.length).toBeLessThanOrEqual(64);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
    expect(missionTitle("mis-unknown", 4)).toBe("Run until done · iteration 4");
    expect(missionTitle(null, 2, "Ship it")).toBe("Ship it · iteration 2");
  });
});

describe("a session whose requests could not be read", () => {
  it("is 'State unknown', never 'Idle'", () => {
    const r = readSession({ status: "idle", requestsUnknown: "unreadable" });
    expect(r.status).toBe("unknown");
    expect(r.label).toBe("State unknown");
    expect(r.detail).toMatch(/could not be read/);
    expect(r.waiting).toBeNull();
    expect(readSession({ status: "idle", requestsUnknown: "too-long" }).detail).toMatch(/too long/);
  });

  it("still says what is known first: waiting, working, failed or ended", () => {
    expect(readSession({ status: "idle", requestsUnknown: "too-long", requests: [{ kind: "access", name: "HubSpot" }] }).label).toBe("Needs access");
    expect(readSession({ status: "idle", requestsUnknown: "unreadable", approvals: 1 }).label).toBe("Needs approval");
    expect(readSession({ status: "running", requestsUnknown: "unreadable", lastEventAt: Date.now() }).label).toBe("Running");
    expect(readSession({ status: "idle", requestsUnknown: "unreadable", error: "The model provider rejected this workspace's key." }).label).toBe("Failed");
    expect(readSession({ status: "terminated", requestsUnknown: "unreadable" }).label).toBe("Ended");
  });
});
