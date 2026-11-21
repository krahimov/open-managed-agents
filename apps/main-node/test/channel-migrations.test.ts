import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pg from "../../../packages/db-schema/src/node-pg/channels";
import * as sqlite from "../../../packages/db-schema/src/node-sqlite/channels";
const folder = fileURLToPath(new URL("../migrations-sqlite", import.meta.url));
const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));
describe("shared channel migrations", () => {
  it.each(["fresh", "telegram", "both"])("upgrades %s without losing cursors or queued output", (version) => {
    const db = new Database(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "channel-upgrade-"));
    try {
      if (version !== "fresh") {
        mkdirSync(join(dir, "meta"));
        const entries = journal.entries.filter((e: any) => !e.tag.includes("channel_key_links")).filter((e: any) => !e.tag.includes("shared_channel") && (version === "both" || !e.tag.includes("imessage")));
        for (const e of entries) copyFileSync(join(folder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
        writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        migrate(drizzle(db), { migrationsFolder: dir });
        db.exec(`INSERT INTO telegram_conversations(session_id,tenant_id,user_id,agent_id,last_seq,mode,transition_id)
          VALUES ('tg','t','u','a',12,'setup','transition'),('tg-only','t','u','b',4,'work',NULL);
          INSERT INTO telegram_outbox(id,tenant_id,user_id,chat_id,text,sent) VALUES
          ('event:tg:0000000000000012:0','t','u','123','pending Telegram',0),
          ('event:tg:0000000000000011:0','t','u','123','sent Telegram',1);`);
        db.exec(`INSERT INTO sessions(id,tenant_id,agent_id,status,created_at) VALUES ('retired','t','a','idle',1);
          INSERT INTO telegram_outbox(id,tenant_id,user_id,chat_id,text,sent) VALUES
          ('event:retired:0000000000000003:0','t','u','123','retired pending',0),
          ('event:retired:0000000000000004:0','t','u','123','retired delivered',1);`);
        if (version === "both") db.exec(`INSERT INTO imessage_conversations(session_id,tenant_id,user_id,agent_id,last_seq,mode)
          VALUES ('im-overlap','t','u','a',7,'work'),('im-only','t','u','c',9,'setup');
          INSERT INTO imessage_outbox(id,tenant_id,user_id,chat_id,text,sent) VALUES
          ('event:im-overlap:0000000000000007:000000','t','u','phone','pending iMessage',0),
          ('event:im-overlap:0000000000000006:000000','t','u','phone','sent iMessage',1);`);
      }
      migrate(drizzle(db), { migrationsFolder: folder });
      const count = db.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
      migrate(drizzle(db), { migrationsFolder: folder });
      expect(db.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual(count);
      for (const [name, table] of Object.entries(sqlite)) {
        const columns = (db.prepare(`PRAGMA table_info(${name})`).all() as any[]).map(c => c.name).sort();
        expect(columns).toEqual(Object.keys(getTableColumns(table)).sort());
        expect(columns).toEqual(Object.keys(getTableColumns((pg as any)[name])).sort());
      }
      if (version !== "fresh") {
        expect(db.prepare("SELECT session_id,last_seq,mode,transition_id,reply_channel FROM channel_conversations WHERE agent_id='a'").get())
          .toEqual({ session_id: "tg", last_seq: 12, mode: "setup", transition_id: "transition", reply_channel: "telegram" });
        expect(db.prepare("SELECT last_seq FROM channel_conversations WHERE agent_id='b'").get()).toEqual({ last_seq: 4 });
        expect(db.prepare("SELECT text FROM channel_deliveries WHERE session_id='tg' AND id LIKE 'legacy:telegram:%'").all()).toEqual([{ text: "pending Telegram" }]);
        expect(db.prepare("SELECT COUNT(*) AS n FROM telegram_outbox WHERE sent=0").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT session_id,last_seq FROM channel_conversation_drains WHERE session_id='retired'").get()).toEqual({ session_id: "retired", last_seq: 4 });
        expect(db.prepare("SELECT text FROM channel_deliveries WHERE session_id='retired'").all()).toEqual([{ text: "retired pending" }]);
        // Old tables remain intact, with their original cursors.
        expect(db.prepare("SELECT last_seq FROM telegram_conversations WHERE session_id='tg'").get()).toEqual({ last_seq: 12 });
      }
      if (version === "both") {
        expect(db.prepare("SELECT session_id,last_seq,reply_channel FROM channel_conversations WHERE agent_id='c'").get()).toEqual({ session_id: "im-only", last_seq: 9, reply_channel: "imessage" });
        expect(db.prepare("SELECT session_id,last_seq FROM channel_conversation_drains WHERE session_id='im-overlap'").all()).toEqual([{ session_id: "im-overlap", last_seq: 7 }]);
        expect(db.prepare("SELECT text FROM channel_deliveries WHERE id LIKE 'legacy:imessage:%'").all()).toEqual([{ text: "pending iMessage" }]);
      }
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("registers matching new Postgres and SQLite DDL after existing migrations", () => {
    const pgRoot = new URL("../migrations/", import.meta.url);
    const j = JSON.parse(readFileSync(new URL("meta/_journal.json", pgRoot), "utf8"));
    // Later migrations may follow; find this one by tag instead of assuming it is last.
    const index = j.entries.findIndex((e: any) => e.tag === "0010_shared_channel_conversations");
    expect(index).toBeGreaterThan(0);
    expect(j.entries[index].when).toBeGreaterThan(j.entries[index - 1].when);
    expect(journal.entries.some((e: any) => e.tag === "0007_shared_channel_conversations")).toBe(true);
    const pgDDL = readFileSync(new URL("0010_shared_channel_conversations.sql", pgRoot), "utf8");
    expect(pgDDL).toBe(readFileSync(join(folder, "0007_shared_channel_conversations.sql"), "utf8"));
    for (const name of Object.keys(pg)) expect(pgDDL).toContain(`CREATE TABLE ${name}`);
  });
});
