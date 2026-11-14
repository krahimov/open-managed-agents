import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/events";

import { formatClock, plainLine, readPulse } from "./activity";
import { visitCutoff } from "./useLastVisit";

const at = (iso: string) => ({ processed_at: iso });

describe("plainLine", () => {
  it("says what a message says, without how it is typeset", () => {
    expect(plainLine("Posted the review as **Request changes** with 3 inline comments → [review-2418](https://github.com/x/y/pull/1#r)")).toBe(
      "Posted the review as Request changes with 3 inline comments → review-2418",
    );
    expect(plainLine("All 6 checks passed ✅ — `orders_fact` is back to baseline.")).toBe(
      "All 6 checks passed — orders_fact is back to baseline.",
    );
  });

  it("keeps separate thoughts separate", () => {
    expect(plainLine("**What's new in 2.14**\n- 🧩 Drag to rearrange dashboard tiles\n- 💬 Alert follow-ups stay in one thread")).toBe(
      "What's new in 2.14 · Drag to rearrange dashboard tiles · Alert follow-ups stay in one thread",
    );
    expect(plainLine("**Go, with one caveat.**\n\n- ✅ Release notes drafted\n- ⚠️ PR #1842 has changes requested")).toBe(
      "Go, with one caveat. Release notes drafted · PR #1842 has changes requested",
    );
  });

  it("skips tables and code, and cuts at a word", () => {
    expect(plainLine("### October reconciliation\n\n| Payout | Diff |\n|---|---|\n| po_1 | $4.10 |\n\nTwo payouts need a decision.")).toBe(
      "October reconciliation · Two payouts need a decision.",
    );
    expect(plainLine("Done.\n```sql\nselect 1\n```")).toBe("Done.");
    const long = plainLine("word ".repeat(80), 60);
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long.endsWith("…")).toBe(true);
    expect(long).not.toMatch(/\s…$/);
  });
});

describe("readPulse", () => {
  // Newest first, as the events endpoint returns them with order=desc.
  const running: Event[] = [
    { type: "span.model_request_end", ...at("2026-11-06T13:56:55.382Z") },
    { type: "agent.tool_use", id: "c3", name: "bash", input: { command: "duckdb /workspace/warehouse.duckdb -c '.read q4.sql'" }, ...at("2026-11-06T13:56:55.153Z") },
    { type: "agent.message", content: [{ type: "text", text: "Progress update — cohorts are built (42 rows)." }], ...at("2026-11-06T13:56:54.297Z") },
    { type: "agent.tool_result", tool_use_id: "c2", content: "ok", ...at("2026-11-06T13:56:48.917Z") },
    { type: "agent.tool_use", id: "c2", name: "bash", input: { command: "ls" }, ...at("2026-11-06T13:56:44.332Z") },
    { type: "session.status_running", ...at("2026-11-06T13:56:33.982Z") },
    { type: "user.message", content: [{ type: "text", text: "Build the Q4 retention cohort table by plan" }], ...at("2026-11-06T13:56:33.582Z") },
  ];

  it("says what the agent is doing: the call it has not had an answer to", () => {
    const pulse = readPulse(running);
    expect(pulse.activity?.label).toBe("Running a command");
    expect(pulse.activity?.detail).toContain("duckdb /workspace/warehouse.duckdb");
    expect(pulse.activity?.code).toBe(true);
    expect(pulse.activity?.tone).toBe("working");
  });

  it("times the turn from the message that started it, and keeps the agent's last words", () => {
    const pulse = readPulse(running);
    expect(pulse.turnStartedAt).toBe(Date.parse("2026-11-06T13:56:33.582Z"));
    expect(pulse.lastEventAt).toBe(Date.parse("2026-11-06T13:56:55.382Z"));
    expect(pulse.lastSaid).toBe("Progress update — cohorts are built (42 rows).");
  });

  it("reads the other things an agent can be doing", () => {
    expect(readPulse([{ type: "agent.tool_result", tool_use_id: "c1", content: "x" }, { type: "agent.tool_use", id: "c1", name: "bash", input: {} }]).activity?.label).toBe(
      "Reading the result",
    );
    expect(readPulse([{ type: "span.model_request_start" }, { type: "user.message", content: "hi there" }]).activity?.label).toBe("Thinking");
    expect(
      readPulse([{ type: "agent.mcp_tool_use", id: "m1", mcp_server_name: "linear", name: "create_issue", input: { title: "SSO loop" } }]).activity?.label,
    ).toBe("Using Linear (create issue)");
    expect(readPulse([{ type: "session.status_idle", stop_reason: { type: "requires_action" } }]).activity).toMatchObject({
      label: "Waiting for approval",
      tone: "waiting",
    });
    expect(readPulse([{ type: "session.status_idle", stop_reason: { type: "end_turn" } }, { type: "span.wakeup_scheduled", reason: "Postmortem review Thursday 15:00" }]).activity).toMatchObject({
      label: "Waiting for a scheduled wake-up",
      detail: "Postmortem review Thursday 15:00",
    });
    expect(readPulse([]).activity).toBeNull();
  });

  it("says a session is retrying when the runtime says so", () => {
    expect(readPulse(running, { retrying: true }).activity).toMatchObject({ label: "Retrying after a failure", tone: "waiting" });
    // The council's case: the status says retrying, the log ends on a scheduled wake-up.
    // The status decides what it is called; the wake-up is only detail.
    const woke: Event[] = [
      { type: "session.status_idle", stop_reason: { type: "end_turn" }, ...at("2026-11-02T18:10:39.435Z") },
      { type: "span.wakeup_scheduled", reason: "Postmortem review Thursday 15:00", ...at("2026-11-02T18:10:38.870Z") },
      { type: "user.message", content: [{ type: "text", text: "Draft the postmortem" }], ...at("2026-11-02T18:10:33.582Z") },
    ];
    expect(readPulse(woke).activity?.label).toBe("Waiting for a scheduled wake-up");
    expect(readPulse(woke, { retrying: true }).activity).toMatchObject({
      label: "Retrying after a failure",
      detail: "a wake-up was scheduled: Postmortem review Thursday 15:00",
      tone: "waiting",
    });
  });
});

describe("formatClock", () => {
  it("counts seconds while they matter", () => {
    expect(formatClock(42_000)).toBe("42s");
    expect(formatClock(3 * 60_000 + 7_000)).toBe("3m 07s");
    expect(formatClock(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatClock(4 * 86_400_000 + 9 * 3_600_000)).toBe("4d 9h");
    expect(formatClock(-5)).toBe("0s");
  });
});

describe("visitCutoff", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  const hour = 3_600_000;

  it("has nothing to compare with on a first visit", () => {
    expect(visitCutoff(null, now)).toBeNull();
  });

  it("counts from the end of the visit before, after a break", () => {
    expect(visitCutoff({ seen: now - 5 * hour, since: now - 30 * hour }, now)).toBe(now - 5 * hour);
  });

  it("stays put within one visit, so leaving Home and coming back does not wipe what is new", () => {
    expect(visitCutoff({ seen: now - 60_000, since: now - 30 * hour }, now)).toBe(now - 30 * hour);
    expect(visitCutoff({ seen: now - 60_000, since: null }, now)).toBeNull();
  });
});

describe("a session that stopped on an error", () => {
  it("says why in the session page's words: the model's error, not 'No output generated'", () => {
    const newestFirst = [
      { type: "session.error", error: "harness_turn_failed", message: "No output generated. Check the stream for errors.", work_item_id: "sw_1" },
      { type: "session.status_idle" },
      { type: "session.error", error: "harness_turn_failed", message: "No output generated. Check the stream for errors." },
      { type: "span.model_request_end", finish_reason: "error", error_message: '429 insufficient_quota: You exceeded your current quota {"type":"error"}' },
      { type: "span.model_request_start" },
      { type: "session.status_running" },
    ] as unknown as Event[];
    const pulse = readPulse(newestFirst);
    expect(pulse.activity?.label).toBe("Stopped on an error");
    expect(pulse.activity?.detail).toBe("The model provider account is out of quota, or is rate limiting this key.");
    expect(pulse.error).toMatch(/^429 insufficient_quota/);
  });

  it("falls back to the runtime's message when the model said nothing", () => {
    const pulse = readPulse([
      { type: "session.error", error: "sandbox_error", message: "The sandbox did not start" },
      { type: "span.model_request_end", finish_reason: "stop" },
    ] as unknown as Event[]);
    expect(pulse.activity?.detail).toBe("The sandbox did not start");
  });
});
