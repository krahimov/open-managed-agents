import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/events";

import { EMPTY_LOG, failureText, foldLog, normalize, openOf, readSessionLog, settledFrom, type EventsPage } from "./log-reading";
import { openRequests } from "./requests";

/** A session's log as the events endpoint stores it: seq from 1. */
const stamp = (list: Array<Record<string, unknown>>, from = 1): Event[] =>
  list.map((e, i) => ({ id: `e${from + i}`, seq: from + i, ts: 1_800_000_000_000 + (from + i) * 1000, ...e })) as unknown as Event[];

const say = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user.message", content: [{ type: "text", text }], ...extra });
const think = (n: number) => Array.from({ length: n }, (_, i) => ({ type: "agent.thinking", text: `step ${i}` }));
const HUBSPOT = { type: "system.access_request", request_id: "acreq-1", service: "hubspot", auth_kind: "composio" };
const DOCX = { type: "system.skill_request", request_id: "skreq-1", skill_name: "docx" };
const RUNNING = { type: "session.status_running" };
const IDLE = { type: "session.status_idle" };

/** The events endpoint as Node serves it (`after_seq`, `limit`, `order`), counting what it is asked. */
function server(log: Event[], opts: { wrap?: boolean; fail?: boolean } = {}) {
  const asked: string[] = [];
  const get = async (query: string): Promise<EventsPage> => {
    asked.push(query);
    if (opts.fail) throw new Error("503");
    const q = new URLSearchParams(query.slice(1));
    const after = q.get("after_seq");
    const limit = Number(q.get("limit") ?? 100);
    const all = after !== null ? log.filter((e) => (e.seq ?? 0) > Number(after)) : log;
    const ordered = q.get("order") === "desc" ? [...all].reverse() : all;
    const data = ordered.slice(0, limit).map((e) => (opts.wrap ? ({ seq: e.seq, type: e.type, ts: e.ts, data: e } as unknown as Event) : e));
    return { data, has_more: all.length > limit };
  };
  return { get, asked };
}

const BUDGET = { tail: 40, page: 200, most: 2000 };

describe("reading a session's log until its requests are settled", () => {
  it("finds a request asked long before the newest events (45 thinking events, then idle)", async () => {
    const log = stamp([say("Build the plan"), RUNNING, HUBSPOT, ...think(45), IDLE]);
    const { get, asked } = server(log);
    const res = await readSessionLog(get, null, false, BUDGET);
    expect(res.kind).toBe("known");
    expect(openOf(res.state).map((r) => r.name)).toEqual(["HubSpot"]);
    // The same answer the session page gets from the whole log.
    expect(openOf(res.state)).toEqual(openRequests(log));
    // The tail, then one page back.
    expect(asked).toEqual(["?limit=40&order=desc", `?after_seq=0&limit=${log.length - 40}&order=asc`]);
    expect(res.state.seq).toBe(log.length);
  });

  it("stops at a person's reply: everything asked before it is settled", async () => {
    const log = stamp([say("Build the plan"), HUBSPOT, ...think(300), say("Skip HubSpot"), ...think(10), IDLE]);
    const { get, asked } = server(log);
    const res = await readSessionLog(get, null, false, BUDGET);
    expect(openOf(res.state)).toEqual([]);
    expect(asked).toHaveLength(1);
  });

  it("pages back through a long log, a page at a time, and agrees with the whole-log reading", async () => {
    const log = stamp([say("Start"), RUNNING, HUBSPOT, ...think(700), DOCX, ...think(30), IDLE]);
    const { get, asked } = server(log);
    const res = await readSessionLog(get, null, false, BUDGET);
    expect(openOf(res.state).map((r) => r.name)).toEqual(["HubSpot", "Word documents"]);
    expect(openOf(res.state)).toEqual(openRequests(log));
    // 40, then 200 at a time back to the start: 40 + 200 + 200 + 200 + 95.
    expect(asked.length).toBe(5);
  });

  it("reads what the Workers runtime returns, events wrapped as { seq, type, data }", async () => {
    const log = stamp([say("Build the plan"), HUBSPOT, ...think(60), IDLE]);
    const { get } = server(log, { wrap: true });
    const res = await readSessionLog(get, null, false, BUDGET);
    expect(openOf(res.state).map((r) => r.name)).toEqual(["HubSpot"]);
    expect(normalize({ seq: 7, type: "x", data: { type: "agent.thinking" } } as unknown as Event).seq).toBe(7);
  });

  it("then asks only for what is newer, and folds an answer in", async () => {
    const log = stamp([say("Build the plan"), HUBSPOT, ...think(60), IDLE]);
    const first = await readSessionLog(server(log).get, null, false, BUDGET);
    const more = [...log, ...stamp([say("[access granted] hubspot is now connected — continue."), RUNNING, IDLE], log.length + 1)];
    const { get, asked } = server(more);
    const next = await readSessionLog(get, first.state, false, BUDGET);
    expect(asked).toEqual([`?after_seq=${log.length}&limit=200&order=asc`]);
    expect(openOf(next.state)).toEqual([]);
    expect(next.state.seq).toBe(more.length);
  });

  it("says a log is too long to check rather than guess, and still counts what it found", async () => {
    const quiet = stamp([HUBSPOT, ...think(2600), IDLE]);
    const res = await readSessionLog(server(quiet).get, null, false, BUDGET);
    expect(res.kind).toBe("too-long");
    expect(openOf(res.state)).toEqual([]);
    expect(res.state.failureKnown).toBe(false);
    expect(res.exhausted).toBe(true);

    const found = stamp([HUBSPOT, ...think(2600), DOCX, IDLE]);
    const partial = await readSessionLog(server(found).get, null, false, BUDGET);
    expect(partial.kind).toBe("too-long");
    expect(openOf(partial.state).map((r) => r.name)).toEqual(["Word documents"]);
  });

  it("throws when a page cannot be read, so the caller can say the state is not known", async () => {
    await expect(readSessionLog(server([], { fail: true }).get, null, false, BUDGET)).rejects.toThrow("503");
  });
});

describe("why a turn failed, as the session page says it", () => {
  const failed = [
    say("Summarise the week"),
    RUNNING,
    { type: "span.model_request_start" },
    { type: "span.model_request_end", finish_reason: "error", error_message: "429 insufficient_quota: You exceeded your current quota" },
    { type: "session.error", error: "model_error", message: "No output generated. Check the stream for errors." },
    IDLE,
    // The runtime reports the same failure again for its work item.
    { type: "session.error", error: "model_error", message: "No output generated. Check the stream for errors.", work_item_id: "sw_1" },
  ];

  it("leads with the model's own error, not the runtime's 'No output generated'", () => {
    const state = foldLog(EMPTY_LOG, stamp(failed));
    expect(failureText(state)).toBe("429 insufficient_quota: You exceeded your current quota");
  });

  it("falls back to the runtime's message when the model said nothing", () => {
    const state = foldLog(EMPTY_LOG, stamp([RUNNING, { type: "session.error", error: "sandbox_error", message: "The sandbox failed to start" }]));
    expect(failureText(state)).toBe("The sandbox failed to start");
  });

  it("forgets a failure once a new turn starts, as the report does", () => {
    const state = foldLog(EMPTY_LOG, stamp([...failed, say("Try again"), RUNNING, IDLE]));
    expect(failureText(state)).toBeNull();
  });

  it("reads back to the start of the failed turn when the report says it failed", async () => {
    const log = stamp([...failed.slice(0, 4), ...think(80), ...failed.slice(4)]);
    const { get } = server(log);
    const res = await readSessionLog(get, null, true, BUDGET);
    expect(res.state.failureKnown).toBe(true);
    expect(failureText(res.state)).toMatch(/^429 insufficient_quota/);
  });

  it("stops at the budget when the turn began too long ago, and says the cause is not known", async () => {
    const log = stamp([say("Go"), RUNNING, ...think(2500), ...failed.slice(2)]);
    const res = await readSessionLog(server(log).get, null, true, BUDGET);
    // The person's message is out of reach, but so is any request before it: none was asked in the reach.
    expect(res.exhausted).toBe(true);
    expect(failureText(res.state)).toBeNull();
  });

  it("does not claim a cause it did not reach", () => {
    expect(settledFrom(stamp([say("hi"), ...think(3)]).reverse(), true)).toBeNull();
    const state = foldLog({ ...EMPTY_LOG, failureKnown: false }, stamp(failed));
    expect(failureText(state)).toBeNull();
  });
});
