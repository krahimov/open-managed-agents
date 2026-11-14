// GET /v1/workspace/access (read-only shim) and GET /v1/server_features.
//
// The console gates approvals and the access-policy editor on
// authorization.role, so the shim must answer for every caller, nest the
// role under `authorization`, map main's "member" to "admin", and never
// answer `authorization: null`.

import { beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { BetterSqlite3SqlClient } from "@open-managed-agents/sql-client/adapters/better-sqlite3";
import {
  buildWorkspaceAccessRoutes,
  consoleRoleFor,
  resolveWorkspaceAccess,
} from "../src/lib/workspace-access-routes";
import { SERVER_FEATURES, serverFeaturesBody } from "../src/lib/server-features";

type Caller = { auth_type?: "session" | "api_key" | "disabled"; user_id?: string; tenant_id: string };

let app: Hono;

beforeAll(() => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE membership (user_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const insert = db.prepare(`INSERT INTO membership VALUES (?, ?, ?, 0)`);
  insert.run("usr_owner", "ten_a", "owner");
  insert.run("usr_member", "ten_a", "member");
  insert.run("usr_member", "ten_b", "owner");
  const sql = new BetterSqlite3SqlClient(db);

  // Same lookup index.ts wires, behind a stand-in for authMw that sets the
  // variables the real middleware sets.
  app = new Hono();
  const v1 = new Hono<{ Variables: { tenant_id: string; user_id?: string; auth_type?: string } }>();
  v1.use("*", async (c, next) => {
    const caller = JSON.parse(c.req.header("x-caller") ?? "null") as Caller | null;
    if (!caller) return c.json({ error: "Unauthorized" }, 401);
    c.set("tenant_id", caller.tenant_id);
    if (caller.user_id) c.set("user_id", caller.user_id);
    if (caller.auth_type) c.set("auth_type", caller.auth_type);
    await next();
  });
  v1.get("/server_features", (c) => c.json(serverFeaturesBody()));
  v1.route("/workspace", buildWorkspaceAccessRoutes({
    membershipRole: async (userId, tenantId) =>
      (await sql
        .prepare(`SELECT role FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`)
        .bind(userId, tenantId)
        .first<{ role: string }>())?.role ?? null,
  }));
  app.route("/v1", v1);
  app.notFound((c) => c.json({ error: "not found" }, 404));
});

async function access(caller: Caller | null) {
  const res = await app.request("/v1/workspace/access", {
    headers: caller ? { "x-caller": JSON.stringify(caller) } : {},
  });
  return { status: res.status, body: await res.json() };
}

describe("GET /v1/workspace/access", () => {
  it("reports an owner as owner", async () => {
    expect(await access({ auth_type: "session", user_id: "usr_owner", tenant_id: "ten_a" })).toEqual({
      status: 200,
      body: { authorization: { role: "owner", kind: "session" }, budgets_supported: false },
    });
  });

  it("reports a plain member as admin, since this server enforces no roles", async () => {
    const { body } = await access({ auth_type: "session", user_id: "usr_member", tenant_id: "ten_a" });
    expect(body).toEqual({ authorization: { role: "admin", kind: "session" }, budgets_supported: false });
  });

  it("answers for the active workspace, not the user's first one", async () => {
    const { body } = await access({ auth_type: "session", user_id: "usr_member", tenant_id: "ten_b" });
    expect(body.authorization.role).toBe("owner");
  });

  it("never answers null: auth-disabled and API-key callers are owners", async () => {
    expect((await access({ auth_type: "disabled", user_id: "default", tenant_id: "default" })).body).toEqual({
      authorization: { role: "owner", kind: "development" },
      budgets_supported: false,
    });
    expect((await access({ auth_type: "api_key", user_id: "usr_member", tenant_id: "ten_a" })).body).toEqual({
      authorization: { role: "owner", kind: "api_key" },
      budgets_supported: false,
    });
    expect((await access({ auth_type: "api_key", tenant_id: "ten_a" })).body.authorization).toEqual({
      role: "owner",
      kind: "api_key",
    });
  });

  it("falls back to admin when the membership row is missing or the lookup fails", async () => {
    expect((await access({ auth_type: "session", user_id: "usr_ghost", tenant_id: "ten_a" })).body.authorization).toEqual({
      role: "admin",
      kind: "session",
    });
    const failed = await resolveWorkspaceAccess(
      { authType: "session", userId: "usr_owner", tenantId: "ten_a" },
      { membershipRole: async () => { throw new Error("db down"); } },
    );
    expect(failed).toEqual({ authorization: { role: "admin", kind: "session" }, budgets_supported: false });
  });

  it("stays behind authentication", async () => {
    expect((await access(null)).status).toBe(401);
  });

  it("is read-only: the rest of /v1/workspace is not served", async () => {
    const caller = { "x-caller": JSON.stringify({ auth_type: "session", user_id: "usr_owner", tenant_id: "ten_a" }) };
    for (const [method, path] of [
      ["GET", "/v1/workspace/members"],
      ["PUT", "/v1/workspace/members/usr_member"],
      ["GET", "/v1/workspace/audit"],
      ["GET", "/v1/workspace/budgets"],
      ["POST", "/v1/workspace/access"],
    ] as const) {
      const res = await app.request(path, { method, headers: caller });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("maps membership roles", () => {
    expect(consoleRoleFor("owner")).toBe("owner");
    expect(consoleRoleFor("member")).toBe("admin");
    expect(consoleRoleFor(null)).toBe("admin");
    expect(consoleRoleFor("something-new")).toBe("admin");
  });
});

describe("GET /v1/server_features", () => {
  it("lists exactly what this release backs", async () => {
    const res = await app.request("/v1/server_features", {
      headers: { "x-caller": JSON.stringify({ auth_type: "disabled", tenant_id: "default" }) },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ features: ["workspace_access", "usage"] });
  });

  it("only names keys the console knows", () => {
    const known = [
      "operations", "workspace_access", "usage", "missions", "workspace_admin", "budgets", "scoped_keys",
      "simulations", "draft_scenarios", "comparisons", "memory_writes", "skill_versions", "runtimes", "cap_cli",
    ];
    for (const key of SERVER_FEATURES) expect(known).toContain(key);
  });
});
