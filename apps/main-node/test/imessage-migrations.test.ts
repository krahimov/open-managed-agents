import { describe, expect, it } from "vitest";
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getTableColumns } from "drizzle-orm";
import * as pg from "../../../packages/db-schema/src/node-pg/imessage";
import * as sqliteSchema from "../../../packages/db-schema/src/node-sqlite/imessage";

const root = fileURLToPath(new URL("../migrations-sqlite", import.meta.url));
const journal = JSON.parse(readFileSync(join(root, "meta/_journal.json"), "utf8"));
describe("iMessage migrations", () => {
  it.each([false, true])("migrates a %s existing database and is repeatable", existing => {
    const dir = mkdtempSync(join(tmpdir(), "imessage-migration-"));
    const sql = new Database(":memory:"), db = drizzle(sql);
    try {
      if (existing) {
        mkdirSync(join(dir, "meta"));
        const entries = journal.entries.filter((e: any) => !e.tag.includes("channel_key_links")).filter((e: any) => !e.tag.includes("imessage") && !e.tag.includes("shared_channel"));
        for (const e of entries) copyFileSync(join(root, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
        writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
        migrate(db, { migrationsFolder: dir });
        sql.exec("INSERT INTO telegram_accounts(tenant_id,user_id,chat_id) VALUES('tenant','user','123')");
      }
      migrate(db, { migrationsFolder: root });
      const count = sql.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
      migrate(db, { migrationsFolder: root });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual(count);
      for (const [name, table] of Object.entries(sqliteSchema)) {
        const columns = sql.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[];
        expect(columns.map(c => c.name).sort()).toEqual(Object.keys(getTableColumns(table)).sort());
        expect(Object.keys(getTableColumns((pg as any)[name])).sort()).toEqual(columns.map(c => c.name).sort());
      }
      sql.exec("INSERT INTO imessage_accounts(tenant_id,user_id,chat_id) VALUES('tenant','user','+15550000101')");
      expect(() => sql.exec("INSERT INTO imessage_accounts(tenant_id,user_id,chat_id) VALUES('other','user','+15550000101')")).toThrow();
      if (existing) expect(sql.prepare("SELECT chat_id FROM telegram_accounts").get()).toEqual({ chat_id: "123" });
    } finally { sql.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("registers the Postgres migration after Telegram with the same columns", () => {
    const root = new URL("../migrations/", import.meta.url);
    const j = JSON.parse(readFileSync(new URL("meta/_journal.json", root), "utf8"));
    const entry = j.entries.find((e: any) => e.tag === "0009_imessage_onboarding");
    expect(entry.tag).toBe("0009_imessage_onboarding");
    expect(entry.when).toBeGreaterThan(j.entries.find((e: any) => e.tag === "0008_telegram_setup").when);
    const ddl = readFileSync(new URL(`${entry.tag}.sql`, root), "utf8");
    for (const name of Object.keys(pg)) expect(ddl).toContain(`CREATE TABLE ${name}`);
    expect(ddl).toContain("link_expires_at BIGINT");
    expect(ddl).not.toContain("telegram_");
  });
});
