import { describe, expect, it } from "vitest";
import type { Event } from "../../lib/events";
import {
  buildTimeline,
  describeTool,
  formatElapsed,
  lineDiff,
  summarizeSteps,
  type TimelineItem,
  type WorkStep,
} from "./model";

const at = (s: number) => new Date(Date.UTC(2026, 10, 9, 12, 0, s)).toISOString();
const ev = (e: Record<string, unknown>) => e as Event;

const user = (id: string, s: number) => ev({ type: "user.message", id, processed_at: at(s), content: [{ type: "text", text: "hi" }] });
const bash = (id: string, s: number, command = "ls") => ev({ type: "agent.tool_use", id, name: "bash", input: { command }, processed_at: at(s) });
const result = (id: string, s: number, content: unknown, is_error = false) =>
  ev({ type: "agent.tool_result", id: `r-${id}`, tool_use_id: id, content, is_error, processed_at: at(s) });
const reply = (id: string, s: number) => ev({ type: "agent.message", id, processed_at: at(s), content: [{ type: "text", text: "done" }] });
const idle = (id: string, s: number, type = "end_turn") => ev({ type: "session.status_idle", id, processed_at: at(s), stop_reason: { type } });

const work = (items: TimelineItem[]) => items.filter((i): i is Extract<TimelineItem, { kind: "work" }> => i.kind === "work");
const tools = (steps: WorkStep[]) => steps.flatMap((s) => (s.kind === "tool" ? [s.call] : []));

describe("describeTool", () => {
  it("labels built-ins by kind with their one-line target", () => {
    expect(describeTool("bash", { command: "npm test\n--watch" })).toMatchObject({ kind: "command", verb: "Ran", target: "npm test" });
    expect(describeTool("Read", { file_path: "/workspace/src/app.ts" })).toMatchObject({ kind: "read", target: "src/app.ts" });
    expect(describeTool("web_search", { query: "oma docs" })).toMatchObject({ kind: "web_search", target: "oma docs" });
    expect(describeTool("request_access", { service: "github", reason: "x" })).toMatchObject({ kind: "access", target: "GitHub" });
  });

  it("labels MCP calls as server · tool, from either wire shape", () => {
    expect(describeTool("slack_search_channels", { query: "eng" }, "slack")).toMatchObject({
      kind: "mcp",
      verb: "Slack · search channels",
      server: "Slack",
      target: "eng",
    });
    expect(describeTool("mcp__linear__list_issues", {})).toMatchObject({ kind: "mcp", verb: "Linear · list issues" });
  });
});

describe("buildTimeline", () => {
  it("pairs results with their use by id, with status and duration", () => {
    const { items } = buildTimeline([
      user("u1", 0),
      bash("c1", 1),
      ev({ type: "agent.mcp_tool_use", id: "m1", name: "search", mcp_server_name: "slack", input: {}, processed_at: at(2) }),
      result("c1", 3, [{ type: "text", text: "a.txt" }]),
      ev({ type: "agent.mcp_tool_result", id: "rm1", mcp_tool_use_id: "m1", content: '{"ok":true}', processed_at: at(4) }),
    ]);
    const calls = tools(work(items)[0].steps);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ status: "completed", output: "a.txt", durationMs: 2000 });
    expect(calls[1]).toMatchObject({ status: "completed", output: '{\n  "ok": true\n}' });
    // results never render on their own
    expect(items.some((i) => i.kind === "event" && i.event.type.endsWith("tool_result"))).toBe(false);
  });

  it("marks running and failed calls", () => {
    const { items } = buildTimeline([user("u1", 0), bash("c1", 1), result("c1", 2, "boom", true), bash("c2", 3)]);
    expect(tools(work(items)[0].steps).map((c) => c.status)).toEqual(["failed", "running"]);
  });

  it("keeps consecutive calls in one group across silent span/status events", () => {
    const { items } = buildTimeline([
      user("u1", 0),
      bash("c1", 1),
      ev({ type: "span.model_request_end", id: "s1" }),
      ev({ type: "span.model_request_start", id: "s2" }),
      bash("c2", 2),
      reply("a1", 3),
      bash("c3", 4),
    ]);
    expect(work(items).map((w) => w.steps.length)).toEqual([2, 1]);
  });

  it("folds a finished turn's work behind 'Worked for', keeping the final answer", () => {
    const { items, openTurnStartMs } = buildTimeline([
      user("u1", 0),
      ev({ type: "agent.thinking", id: "t1", text: "plan", processed_at: at(1) }),
      bash("c1", 2),
      result("c1", 3, "ok"),
      reply("a0", 4),
      bash("c2", 5),
      result("c2", 6, "ok"),
      reply("a1", 120),
      idle("i1", 128),
    ]);
    const fold = items.find((i) => i.kind === "fold");
    expect(fold).toMatchObject({ label: "Worked for 2m 8s", failed: false });
    const visible = items.filter((i) => i.kind !== "fold" && !i.foldId);
    expect(visible.map((i) => (i.kind === "event" ? i.event.id : i.kind))).toEqual(["u1", "a1"]);
    // the intermediate message folds with the work
    const a0 = items.find((i) => i.kind === "event" && i.event.id === "a0");
    expect(a0 && "foldId" in a0 && a0.foldId).toBe("u1");
    expect(openTurnStartMs).toBeNull();
  });

  it("does not fold a turn still running or parked on approval", () => {
    const running = buildTimeline([user("u1", 0), bash("c1", 1)]);
    expect(running.items.some((i) => i.kind === "fold")).toBe(false);
    expect(running.openTurnStartMs).toBe(Date.parse(at(0)));

    const parked = buildTimeline([user("u1", 0), bash("c1", 1), idle("i1", 2, "requires_action")]);
    expect(parked.items.some((i) => i.kind === "fold")).toBe(false);
  });

  it("keeps a failed call after the final answer out of the fold", () => {
    const { items } = buildTimeline([user("u1", 0), reply("a1", 1), bash("c1", 2), result("c1", 3, "nope", true), idle("i1", 4)]);
    expect(items.some((i) => i.kind === "fold")).toBe(false);
    expect(work(items)[0].foldId).toBeUndefined();
  });

  it("drops hidden tools along with their results", () => {
    const { items } = buildTimeline(
      [user("u1", 0), ev({ type: "agent.tool_use", id: "s1", name: "mcp__oma_setup__update", input: {} }), result("s1", 1, "ok")],
      { hideTool: (u) => String(u.name).startsWith("mcp__oma_setup__") },
    );
    expect(work(items)).toHaveLength(0);
  });

  it("labels an interrupted turn as stopped", () => {
    const { items } = buildTimeline([user("u1", 0), bash("c1", 1), ev({ type: "user.interrupt", id: "x" }), idle("i1", 9)]);
    expect(items.find((i) => i.kind === "fold")).toMatchObject({ label: "Stopped after 9s" });
  });
});

describe("summarizeSteps", () => {
  it("names up to three actions plus a remainder, MCP servers first", () => {
    const { items } = buildTimeline([
      user("u1", 0),
      ev({ type: "agent.tool_use", id: "r1", name: "read", input: { file_path: "/workspace/a" } }),
      ev({ type: "agent.tool_use", id: "r2", name: "read", input: { file_path: "/workspace/b" } }),
      bash("c1", 1),
    ]);
    expect(summarizeSteps(work(items)[0].steps).label).toBe("Ran 1 command, read 2 files");

    const many = buildTimeline([
      user("u1", 0),
      ev({ type: "agent.tool_use", id: "r1", name: "read", input: { file_path: "a" } }),
      ev({ type: "agent.tool_use", id: "e1", name: "edit", input: { file_path: "a" } }),
      bash("c1", 1),
      ev({ type: "agent.tool_use", id: "w1", name: "web_search", input: { query: "q" } }),
    ]);
    expect(summarizeSteps(work(many.items)[0].steps).label).toBe("Changed 1 file, ran 1 command, read 1 file, 1 other action");

    const mcp = buildTimeline([
      user("u1", 0),
      ev({ type: "agent.mcp_tool_use", id: "m1", name: "search", mcp_server_name: "slack", input: {} }),
      ev({ type: "agent.tool_use", id: "m2", name: "mcp__linear__list_issues", input: {} }),
      bash("c1", 1),
      ev({ type: "agent.tool_use", id: "g1", name: "grep", input: { pattern: "x" } }),
    ]);
    expect(summarizeSteps(work(mcp.items)[0].steps).label).toBe("Used Slack and Linear, ran 1 command, searched code");
  });
});

describe("helpers", () => {
  it("formats elapsed time like T3", () => {
    expect(formatElapsed(850)).toBe("850ms");
    expect(formatElapsed(4200)).toBe("4.2s");
    expect(formatElapsed(128_000)).toBe("2m 8s");
  });

  it("diffs an edit line by line with context", () => {
    expect(lineDiff("a\nb\nc\nd", "a\nB\nc\nd")).toEqual([
      { op: " ", text: "a" },
      { op: "+", text: "B" },
      { op: "-", text: "b" },
      { op: " ", text: "c" },
      { op: " ", text: "d" },
    ]);
  });
});
