import { describe, expect, it } from "vitest";

import type { Event } from "@/lib/events";

import { buildConversation } from "./model";
import { isPersonMessage, openRequests, openRequestsFromTail, readGrant, readRequests, requestsPending } from "./requests";

const events = (list: Array<Record<string, unknown>>): Event[] =>
  list.map((e, i) => ({ id: `e${i}`, seq: i + 1, ts: 1_800_000_000_000 + i * 1000, ...e })) as unknown as Event[];
const say = (text: string, extra: Record<string, unknown> = {}) => ({ type: "user.message", content: [{ type: "text", text }], ...extra });

const HUBSPOT = { type: "system.access_request", request_id: "acreq-1", service: "hubspot", auth_kind: "composio" };
const RETELL = { type: "system.access_request", request_id: "acreq-2", service: "retell", auth_kind: "mcp_api_key", mcp_server_url: "https://mcp.retellai.com/mcp" };
const DOCX = { type: "system.skill_request", request_id: "skreq-3", skill_name: "docx", resolution: "catalog" };

describe("requests an agent makes of a person", () => {
  it("are open until someone answers", () => {
    const log = events([say("Build the plan"), { type: "session.status_running" }, HUBSPOT, RETELL, DOCX, { type: "session.status_idle" }]);
    expect(openRequests(log)).toMatchObject([
      { kind: "access", key: "acreq-1", name: "HubSpot" },
      { kind: "access", key: "acreq-2", name: "Retell" },
      { kind: "skill", key: "skreq-3", name: "Word documents" },
    ]);
  });

  it("are answered by the server's own note, one request at a time", () => {
    const log = events([
      say("Build the plan"),
      HUBSPOT,
      RETELL,
      DOCX,
      say("[access granted] hubspot is now connected — continue where you left off."),
    ]);
    const read = readRequests(log);
    expect(read.open.map((r) => r.name)).toEqual(["Retell", "Word documents"]);
    expect(read.states.get("acreq-1")).toBe("answered");
    expect(read.states.get("acreq-2")).toBe("open");

    const key = events([...log, say("[access granted] The retell API key is saved in the vault — calls to https://mcp.retellai.com/mcp are now authenticated automatically.")]);
    expect(openRequests(key).map((r) => r.name)).toEqual(["Word documents"]);

    const skill = events([
      ...key,
      say('[skill attached] "docx" is now attached to you. Its playbook follows.\n\n---\n\n# DOCX', { metadata: { kind: "skill_attached", skill_id: "skill-1" } }),
    ]);
    expect(openRequests(skill)).toEqual([]);
    expect(readRequests(skill).states.get("skreq-3")).toBe("answered");
  });

  it("are passed over, not left waiting for ever, when the person replies in words", () => {
    const log = events([say("Build the plan"), HUBSPOT, DOCX, say("Skip HubSpot, use what the ticket says.")]);
    const read = readRequests(log);
    expect(read.open).toEqual([]);
    expect(read.states.get("acreq-1")).toBe("passed");
    expect(read.states.get("skreq-3")).toBe("passed");
    // A request made after that reply is open again.
    expect(openRequests(events([...log, RETELL])).map((r) => r.name)).toEqual(["Retell"]);
  });

  it("are not answered by a wake-up, a run's brief or an ended session's silence", () => {
    const wake = say("Check the queue", { metadata: { harness: "schedule", kind: "wakeup" } });
    expect(isPersonMessage(wake as unknown as Event)).toBe(false);
    expect(openRequests(events([HUBSPOT, wake])).length).toBe(1);
    expect(openRequests(events([HUBSPOT, { type: "session.status_terminated" }]))).toEqual([]);
  });

  it("reads the same from the newest events as from the whole log", () => {
    const log = events([say("Build the plan"), HUBSPOT, RETELL, say("[access granted] hubspot is now connected."), DOCX]);
    const tail = [...log].reverse();
    expect(openRequestsFromTail(tail)).toEqual(openRequests(log));
    // A tail that starts after the request cannot invent one.
    expect(openRequestsFromTail(tail.slice(0, 1)).map((r) => r.name)).toEqual(["Word documents"]);
  });

  it("tells the server's notes from what a person typed", () => {
    expect(readGrant(say("[access granted] hubspot is now connected.") as unknown as Event)).toEqual({ kind: "access", service: "hubspot" });
    expect(readGrant(say('[skill attached] "docx" is now attached to you.') as unknown as Event)).toEqual({ kind: "skill", skill: "docx" });
    expect(readGrant(say("I granted access yesterday") as unknown as Event)).toBeNull();
  });
});

describe("the conversation of a session with requests", () => {
  it("counts open requests, marks each card, and never draws the server's note as a bubble from you", () => {
    const log = events([
      say("Build the plan"),
      { type: "session.status_running" },
      HUBSPOT,
      DOCX,
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      say("[access granted] hubspot is now connected — continue where you left off."),
    ]);
    const c = buildConversation(log);
    expect(c.openRequests.map((r) => r.name)).toEqual(["Word documents"]);
    const cards = c.items.flatMap((i) => (i.kind === "agent" ? i.blocks : [])).filter((b) => b.kind === "card");
    expect(cards.map((b) => (b.kind === "card" ? b.request : null))).toEqual(["answered", "open"]);
    expect(c.items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(c.items.at(-1)).toMatchObject({ kind: "answered", grant: { kind: "access", service: "hubspot" } });
  });
});

describe("requestsPending", () => {
  const q = { candidates: 12, isLoading: false, isPlaceholderData: false, settled: false };
  it("is loading while the first read runs", () => {
    expect(requestsPending({ ...q, isLoading: true })).toBe(true);
  });
  it("does not count an answer kept from a narrower set of sessions as the first answer", () => {
    expect(requestsPending({ ...q, isPlaceholderData: true })).toBe(true);
  });
  it("once settled, a re-read shows the last answer instead of loading", () => {
    expect(requestsPending({ ...q, isPlaceholderData: true, settled: true })).toBe(false);
    expect(requestsPending({ ...q, settled: true })).toBe(false);
  });
  it("with no session to read there is nothing to wait for", () => {
    expect(requestsPending({ ...q, candidates: 0, isLoading: true })).toBe(false);
  });
});
