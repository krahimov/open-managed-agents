// MAX_AGENTS_PER_TENANT gate — unit tests over in-memory sqlite.

import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import {
  buildAgentPreCreateGate,
  resolveMaxAgentsPerTenant,
} from "../src/lib/agent-limits";

function buildSql(rows: Array<{ id: string; tenant: string; archived?: boolean }>) {
  const db = new Database(":memory:");
  const sql = new BetterSqlite3SqlClient(db);
  db.exec(
    `CREATE TABLE agents (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL,
     config TEXT NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER, archived_at INTEGER)`,
  );
  const ins = db.prepare(`INSERT INTO agents (id, tenant_id, archived_at) VALUES (?, ?, ?)`);
  for (const r of rows) ins.run(r.id, r.tenant, r.archived ? Date.now() : null);
  return sql;
}

describe("resolveMaxAgentsPerTenant", () => {
  it("unset/blank/zero/garbage → null (unlimited)", () => {
    for (const v of [undefined, "", "  ", "0", "-3", "ten"]) {
      expect(resolveMaxAgentsPerTenant({ MAX_AGENTS_PER_TENANT: v } as NodeJS.ProcessEnv)).toBeNull();
    }
  });
  it("positive integer parses", () => {
    expect(resolveMaxAgentsPerTenant({ MAX_AGENTS_PER_TENANT: "10" } as NodeJS.ProcessEnv)).toBe(10);
  });
});

describe("buildAgentPreCreateGate", () => {
  it("blocks at the cap, scoped per tenant, ignoring archived agents", async () => {
    const sql = buildSql([
      { id: "a1", tenant: "tn_full" },
      { id: "a2", tenant: "tn_full" },
      { id: "a3", tenant: "tn_full", archived: true }, // freed slot
      { id: "b1", tenant: "tn_other" },
    ]);
    const gate = buildAgentPreCreateGate({ sql, maxAgents: 2 });

    const blocked = await gate({ tenantId: "tn_full" });
    expect(blocked?.status).toBe(403);
    expect(JSON.stringify(blocked?.body)).toMatch(/agent_limit_reached/);
    expect(JSON.stringify(blocked?.body)).toMatch(/limited to 2 agents \(2 in use\)/);

    // Other tenants unaffected; empty tenants pass.
    expect(await gate({ tenantId: "tn_other" })).toBeNull();
    expect(await gate({ tenantId: "tn_new" })).toBeNull();
  });
});
