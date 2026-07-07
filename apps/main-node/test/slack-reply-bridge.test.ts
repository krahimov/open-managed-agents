// Slack reply bridge — decision logic over in-memory sqlite. Guarantees:
// mirror the final agent.message to Slack when (and only when) the turn
// was Slack-originated and the agent didn't post natively.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import { NodeSlackReplyBridge } from "../src/lib/node-slack-reply-bridge";
import type { UserMessageEvent } from "@open-managed-agents/shared";

const SESSION = "sess_slack_1";
const TENANT = "tn_t";

function seedDb(events: Array<{ type: string; data: Record<string, unknown> }>) {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE session_events (session_id TEXT, seq INTEGER, type TEXT, data TEXT);
    CREATE TABLE slack_thread_sessions (publication_id TEXT, tenant_id TEXT, scope_key TEXT, session_id TEXT, status TEXT);
    CREATE TABLE slack_publications (id TEXT, installation_id TEXT);
    CREATE TABLE slack_installations (id TEXT, access_token_cipher TEXT);
  `);
  const ins = db.prepare(`INSERT INTO session_events VALUES (?, ?, ?, ?)`);
  events.forEach((e, i) => ins.run(SESSION, i + 1, e.type, JSON.stringify(e.data)));
  db.prepare(`INSERT INTO slack_thread_sessions VALUES ('pub1', ?, 'channel:C123', ?, 'active')`).run(TENANT, SESSION);
  db.prepare(`INSERT INTO slack_publications VALUES ('pub1', 'inst1')`).run();
  db.prepare(`INSERT INTO slack_installations VALUES ('inst1', 'cipher-xyz')`).run();
  return new BetterSqlite3SqlClient(db);
}

function trigger(withSlackMeta = true): UserMessageEvent {
  return {
    type: "user.message",
    content: [{ type: "text", text: "hi" }],
    ...(withSlackMeta
      ? { metadata: { slack: { channelId: "C123", threadTs: "1783.42" } } }
      : {}),
  } as never;
}

function build(events: Array<{ type: string; data: Record<string, unknown> }>) {
  const posts: Array<{ url: string; body: Record<string, unknown>; auth: string }> = [];
  const bridge = new NodeSlackReplyBridge({
    sql: seedDb(events),
    decryptToken: async (cipher) => `xoxb-decrypted-${cipher}`,
    fetchImpl: (async (url: string, init: { body: string; headers: Record<string, string> }) => {
      posts.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.authorization });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as never,
  });
  return { bridge, posts };
}

const TURN = [
  { type: "user.message", data: { type: "user.message", content: [{ type: "text", text: "do it" }] } },
  { type: "agent.tool_use", data: { type: "agent.tool_use", name: "create_ambient_rule", input: {} } },
  { type: "agent.message", data: { type: "agent.message", content: [{ type: "text", text: "Done — rule created." }] } },
];

describe("NodeSlackReplyBridge", () => {
  it("mirrors the final agent message into the thread with the bot token", async () => {
    const { bridge, posts } = build(TURN);
    await bridge.mirrorTurnReply({ tenantId: TENANT, sessionId: SESSION, triggerEvent: trigger() });
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toContain("chat.postMessage");
    expect(posts[0].body.channel).toBe("C123");
    expect(posts[0].body.thread_ts).toBe("1783.42");
    expect(posts[0].body.text).toBe("Done — rule created.");
    expect(posts[0].auth).toBe("Bearer xoxb-decrypted-cipher-xyz");
  });

  it("skips when the agent posted natively via a Slack MCP tool", async () => {
    const { bridge, posts } = build([
      ...TURN.slice(0, 2),
      { type: "agent.mcp_tool_use", data: { type: "agent.mcp_tool_use", name: "mcp__slack__chat_postMessage", input: {} } },
      TURN[2],
    ]);
    await bridge.mirrorTurnReply({ tenantId: TENANT, sessionId: SESSION, triggerEvent: trigger() });
    expect(posts).toHaveLength(0);
  });

  it("no-ops for non-Slack turns and for turns with no agent message", async () => {
    const { bridge, posts } = build(TURN);
    await bridge.mirrorTurnReply({ tenantId: TENANT, sessionId: SESSION, triggerEvent: trigger(false) });
    expect(posts).toHaveLength(0);

    const empty = build([TURN[0], TURN[1]]);
    await empty.bridge.mirrorTurnReply({ tenantId: TENANT, sessionId: SESSION, triggerEvent: trigger() });
    expect(empty.posts).toHaveLength(0);
  });

  it("swallows failures (slack 500) without throwing", async () => {
    const sql = seedDb(TURN);
    const bridge = new NodeSlackReplyBridge({
      sql,
      decryptToken: async () => "xoxb",
      fetchImpl: (async () => new Response("oops", { status: 500 })) as never,
    });
    await expect(
      bridge.mirrorTurnReply({ tenantId: TENANT, sessionId: SESSION, triggerEvent: trigger() }),
    ).resolves.toBeUndefined();
  });
});
