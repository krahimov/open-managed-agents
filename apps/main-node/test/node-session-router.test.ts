import { describe, expect, it, vi } from "vitest";
import type { SessionEvent } from "@open-managed-agents/shared";
import type { SqlEventLog } from "@open-managed-agents/event-log/sql";
import type { SessionStreamHandle } from "@open-managed-agents/session-runtime";
import { InProcessEventStreamHub } from "../src/lib/event-stream-hub.js";
import { NodeSessionRouter } from "../src/lib/node-session-router.js";

const event = (seq: number, extra: Record<string, unknown> = {}) => ({
  type: "agent.message",
  seq,
  content: [{ type: "text", text: `message ${seq}` }],
  ...extra,
}) as unknown as SessionEvent & { seq: number };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(getEventsAsync = vi.fn(async (_afterSeq?: number) => [] as SessionEvent[])) {
  const hub = new InProcessEventStreamHub();
  const router = new NodeSessionRouter({
    hub,
    sql: {} as never,
    registry: {} as never,
    newEventLog: () => ({ getEventsAsync }) as unknown as SqlEventLog,
  });
  return { router, hub, getEventsAsync };
}

async function drain(handle: SessionStreamHandle) {
  handle.close();
  const events: Array<Record<string, unknown>> = [];
  for await (const frame of handle) events.push(JSON.parse(frame.data));
  return events;
}

describe("NodeSessionRouter event stream replay", () => {
  it("replays history before live events published while the history read is pending", async () => {
    const snapshot = deferred<SessionEvent[]>();
    const { router, hub } = setup(vi.fn(() => snapshot.promise));
    const opening = router.streamEvents("session", { replay: true });

    // SQL has taken its snapshot but has not returned. This event is durable
    // after that snapshot, and no second publication occurs on reconnect.
    hub.publish("session", event(3));
    snapshot.resolve([event(1), event(2)]);
    const handle = await opening;
    hub.publish("session", event(4));

    expect((await drain(handle)).map((ev) => ev.seq)).toEqual([1, 2, 3, 4]);
  });

  it("deduplicates overlap with the history snapshot and delayed history broadcasts", async () => {
    const snapshot = deferred<SessionEvent[]>();
    const { router, hub } = setup(vi.fn(() => snapshot.promise));
    const opening = router.streamEvents("session", { replay: true });
    hub.publish("session", event(2));
    hub.publish("session", event(3));
    snapshot.resolve([event(1), event(2)]);
    const handle = await opening;
    hub.publish("session", event(2));
    hub.publish("session", event(4));

    expect((await drain(handle)).map((ev) => ev.seq)).toEqual([1, 2, 3, 4]);
  });

  it("resumes after Last-Event-ID while retaining thread and extension filters", async () => {
    const snapshot = deferred<SessionEvent[]>();
    const { router, hub, getEventsAsync } = setup(vi.fn(() => snapshot.promise));
    const opening = router.streamEvents("session", {
      lastEventId: 2,
      threadId: "sthr_primary",
    });
    hub.publish("session", event(2));
    hub.publish("session", event(5));
    hub.publish("session", event(6, { session_thread_id: "sthr_other" }));
    hub.publish("session", event(7, { type: "agent.message_delta" }));
    snapshot.resolve([
      event(3, { session_thread_id: "sthr_other" }),
      event(4),
    ]);

    expect((await drain(await opening)).map((ev) => ev.seq)).toEqual([4, 5]);
    expect(getEventsAsync).toHaveBeenCalledWith(2);
  });

  it("retains live chunks without sequence IDs during replay when requested", async () => {
    const snapshot = deferred<SessionEvent[]>();
    const { router, hub } = setup(vi.fn(() => snapshot.promise));
    const opening = router.streamEvents("session", { replay: true, include: ["chunks"] });
    const chunk = { type: "agent.message_delta", text: "hello" } as unknown as SessionEvent;
    hub.publish("session", chunk);
    snapshot.resolve([event(1)]);

    expect((await drain(await opening)).map((ev) => ev.type)).toEqual([
      "agent.message", "agent.message_delta",
    ]);
  });

  it("does not truncate reconnect history at the live buffer limit", async () => {
    const history = Array.from({ length: 1_100 }, (_, i) => event(i + 1));
    const { router, hub } = setup(vi.fn(async () => history));
    const handle = await router.streamEvents("session", { replay: true });
    hub.publish("session", event(1_101));
    const events = await drain(handle);
    expect(events).toHaveLength(1_101);
    expect(events.at(-1)?.seq).toBe(1_101);
  });

  it("detaches the subscription if the replay query fails", async () => {
    const snapshot = deferred<SessionEvent[]>();
    const { router, hub } = setup(vi.fn(() => snapshot.promise));
    const originalAttach = hub.attach.bind(hub);
    const detach = vi.fn();
    vi.spyOn(hub, "attach").mockImplementation((sid, writer) => {
      const unsubscribe = originalAttach(sid, writer);
      return () => { detach(); unsubscribe(); };
    });
    const opening = router.streamEvents("session", { replay: true });
    snapshot.reject(new Error("database unavailable"));

    await expect(opening).rejects.toThrow("database unavailable");
    expect(detach).toHaveBeenCalledOnce();
  });

  it("subscribes immediately without reading history for a live-only stream", async () => {
    const { router, hub, getEventsAsync } = setup();
    const handle = await router.streamEvents("session");
    hub.publish("session", event(1));
    expect((await drain(handle)).map((ev) => ev.seq)).toEqual([1]);
    expect(getEventsAsync).not.toHaveBeenCalled();
  });
});
