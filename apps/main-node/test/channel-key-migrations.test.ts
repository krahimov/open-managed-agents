import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as pg from "../../../packages/db-schema/src/node-pg/channel-keys";
import * as sqlite from "../../../packages/db-schema/src/node-sqlite/channel-keys";

const folder = fileURLToPath(new URL("../migrations-sqlite", import.meta.url));
const journal = JSON.parse(readFileSync(join(folder, "meta/_journal.json"), "utf8"));

describe("channel key link migrations", () => {
  it.each(["fresh", "existing"])("adds the key link tables to a %s SQLite database, repeatably", version => {
    const db = new Database(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "channel-key-upgrade-"));
    try {
      if (version === "existing") {
        // A database with every earlier migration applied (as the live ones are).
        mkdirSync(join(dir, "meta"));
        const entries = journal.entries.filter((e: any) => e.tag !== "0008_channel_key_links");
        for (const e of entries) copyFileSync(join(folder, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
        writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        migrate(drizzle(db), { migrationsFolder: dir });
        db.exec("INSERT INTO channel_conversations(session_id,tenant_id,user_id,agent_id,last_seq,mode,reply_channel) VALUES ('s','t','u','a',3,'work','imessage')");
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
      if (version === "existing") expect(db.prepare("SELECT last_seq FROM channel_conversations WHERE session_id='s'").get()).toEqual({ last_seq: 3 });
      const insert = db.prepare("INSERT INTO channel_key_links (tenant_id,user_id,session_id,request_id,channel,account_hash,token_hash,expires_at) VALUES (?,?,?,?,?,?,?,?)");
      insert.run("t", "u", "s", "r1", "imessage", "a", "h1", 1);
      // One row per request, and a token hash identifies exactly one row.
      expect(() => insert.run("t", "u", "s", "r1", "imessage", "a", "h2", 1)).toThrow();
      expect(() => insert.run("t", "u", "s", "r2", "imessage", "a", "h1", 1)).toThrow();
      expect(db.prepare("SELECT consumed,completed,vault_id FROM channel_key_links").get()).toEqual({ consumed: 0, completed: 0, vault_id: null });
    } finally { db.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("registers new Postgres and SQLite migrations after the existing ones", () => {
    const pgRoot = new URL("../migrations/", import.meta.url);
    const j = JSON.parse(readFileSync(new URL("meta/_journal.json", pgRoot), "utf8"));
    for (const [entries, tag, previous] of [[j.entries, "0011_channel_key_links", "0010_shared_channel_conversations"], [journal.entries, "0008_channel_key_links", "0007_shared_channel_conversations"]] as const) {
      const last = entries.at(-1);
      expect(last.tag).toBe(tag);
      expect(entries.at(-2).tag).toBe(previous);
      expect(last.when).toBeGreaterThan(entries.at(-2).when);
      expect(last.idx).toBe(entries.at(-2).idx + 1);
    }
    const pgDDL = readFileSync(new URL("0011_channel_key_links.sql", pgRoot), "utf8");
    const sqliteDDL = readFileSync(join(folder, "0008_channel_key_links.sql"), "utf8");
    for (const name of Object.keys(pg)) {
      expect(pgDDL).toContain(`CREATE TABLE ${name}`);
      expect(sqliteDDL).toContain(`CREATE TABLE ${name}`);
    }
    expect(pgDDL).toContain("expires_at BIGINT");
    // Same shape apart from the integer type.
    expect(pgDDL.replace(/BIGINT/g, "INTEGER")).toBe(sqliteDDL);
  });
});
