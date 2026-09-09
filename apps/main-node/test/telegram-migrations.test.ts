import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const migrationsFolder = fileURLToPath(new URL("../migrations-sqlite", import.meta.url));
const journal = JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8"));

describe("Telegram migration upgrades", () => {
  it.each(["main", "onboarding", "legacy-test"])("preserves data when upgrading %s", (version) => {
    const dir = mkdtempSync(join(tmpdir(), "telegram-upgrade-"));
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    try {
      mkdirSync(join(dir, "meta"));
      const entries = journal.entries.filter((entry: { tag: string }) =>
        version === "main" ? !entry.tag.includes("telegram") :
        version === "onboarding" ? !entry.tag.endsWith("telegram_setup") : true,
      ).map((entry: { idx: number; tag: string }) => ({
        ...entry,
        // Earlier test releases included an unrelated migration before Telegram.
        idx: version === "legacy-test" && entry.tag.includes("telegram") ? entry.idx + 1 : entry.idx,
      }));
      for (const entry of entries) copyFileSync(join(migrationsFolder, `${entry.tag}.sql`), join(dir, `${entry.tag}.sql`));
      writeFileSync(join(dir, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      migrate(db, { migrationsFolder: dir });
      sqlite.exec("CREATE TABLE retained_data (value TEXT); INSERT INTO retained_data VALUES ('keep')");
      if (version !== "main") {
        sqlite.exec("INSERT INTO telegram_accounts(tenant_id,user_id,chat_id) VALUES ('tenant','user','123')");
        sqlite.exec("INSERT INTO telegram_conversations(session_id,tenant_id,user_id,agent_id) VALUES ('session','tenant','user','agent')");
        sqlite.exec("INSERT INTO telegram_outbox(id,tenant_id,user_id,chat_id,text) VALUES ('message','tenant','user','123','pending')");
      }
      migrate(db, { migrationsFolder });
      const count = sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get();
      migrate(db, { migrationsFolder });
      expect(sqlite.prepare("SELECT COUNT(*) AS n FROM __drizzle_migrations").get()).toEqual(count);
      expect(sqlite.prepare("SELECT value FROM retained_data").get()).toEqual({ value: "keep" });
      const columns = sqlite.prepare("PRAGMA table_info(telegram_conversations)").all() as { name: string }[];
      expect(columns.map(c => c.name)).toEqual(expect.arrayContaining(["mode", "transition_id"]));
      if (version !== "main") {
        expect(sqlite.prepare("SELECT chat_id FROM telegram_accounts").get()).toEqual({ chat_id: "123" });
        expect(sqlite.prepare("SELECT mode FROM telegram_conversations").get()).toEqual({ mode: "work" });
        expect(sqlite.prepare("SELECT text,reply_markup FROM telegram_outbox").get()).toEqual({ text: "pending", reply_markup: null });
      }
    } finally { sqlite.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});
