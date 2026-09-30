import { beforeEach, describe, expect, it } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@open-managed-agents/sql-client";
import {
  findLegacyCredentialForUrl,
  findSessionCredentialForUrl,
  listCredentialsByVaults,
  loadSessionScope,
} from "../src/resolver";

const SCHEMA = `
CREATE TABLE sessions (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, agent_id TEXT, environment_id TEXT,
  vault_ids TEXT, agent_snapshot TEXT, environment_snapshot TEXT, archived_at INTEGER
);
CREATE TABLE environments (id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, config TEXT NOT NULL);
CREATE TABLE credentials (
  id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, vault_id TEXT NOT NULL,
  mcp_server_url TEXT, auth TEXT NOT NULL, created_at INTEGER NOT NULL, archived_at INTEGER
);
CREATE TABLE session_resources (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, config TEXT NOT NULL, created_at INTEGER
);
CREATE TABLE kv_entries (key TEXT NOT NULL, tenant_id TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER);
`;

let sql: SqlClient;
let seq = 0;

async function addCred(tenant: string, vault: string, url: string, token: string, archived = false) {
  const id = `cred_${++seq}`;
  await sql
    .prepare(
      `INSERT INTO credentials (id, tenant_id, vault_id, mcp_server_url, auth, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, tenant, vault, url, JSON.stringify({ type: "static_bearer", mcp_server_url: url, token }), seq, archived ? 1 : null)
    .run();
  return id;
}

async function addSession(opts: {
  id: string;
  tenant: string;
  vaults?: string[];
  envId?: string | null;
  archived?: boolean;
  mcpUrls?: string[];
}) {
  await sql
    .prepare(
      `INSERT INTO sessions (id, tenant_id, environment_id, vault_ids, agent_snapshot, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opts.id,
      opts.tenant,
      opts.envId ?? null,
      JSON.stringify(opts.vaults ?? []),
      JSON.stringify({ mcp_servers: (opts.mcpUrls ?? []).map((url, i) => ({ name: `m${i}`, url })) }),
      opts.archived ? 1 : null,
    )
    .run();
}

beforeEach(async () => {
  sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(SCHEMA);
});

describe("oma-vault session-scoped credential resolution", () => {
  it("returns the credential from the session's own vault", async () => {
    const credId = await addCred("tn_a", "vlt_a", "https://api.example.com", "tok_a");
    await addSession({ id: "sess_a", tenant: "tn_a", vaults: ["vlt_a"] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(scope).not.toBeNull();
    const m = await findSessionCredentialForUrl(sql, "https://api.example.com/v1/x", scope!);
    expect(m).toEqual({
      vaultId: "vlt_a",
      credentialId: credId,
      injectHeader: { name: "authorization", value: "Bearer tok_a" },
    });
  });

  it("does not return a credential from a vault the session isn't bound to", async () => {
    await addCred("tn_a", "vlt_other", "https://api.example.com", "tok_other");
    await addCred("tn_a", "vlt_a", "https://unrelated.example.com", "tok_a");
    await addSession({ id: "sess_a", tenant: "tn_a", vaults: ["vlt_a"] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(await findSessionCredentialForUrl(sql, "https://api.example.com/", scope!)).toBeNull();
  });

  it("returns nothing for a session with no vaults, even if some vault has the host", async () => {
    await addCred("tn_a", "vlt_a", "https://api.example.com", "tok_a");
    await addSession({ id: "sess_a", tenant: "tn_a", vaults: [] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(await findSessionCredentialForUrl(sql, "https://api.example.com/", scope!)).toBeNull();
  });

  it("isolates tenants: a session cannot resolve another tenant's vault even by id", async () => {
    await addCred("tn_b", "vlt_b", "https://api.example.com", "tok_b");
    // Session row of tenant A that (maliciously / by bug) lists B's vault id.
    await addSession({ id: "sess_a", tenant: "tn_a", vaults: ["vlt_b"] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(await findSessionCredentialForUrl(sql, "https://api.example.com/", scope!)).toBeNull();
  });

  it("refuses to load a session under the wrong tenant (forged identity) or when archived", async () => {
    await addSession({ id: "sess_b", tenant: "tn_b", vaults: ["vlt_b"] });
    await addSession({ id: "sess_old", tenant: "tn_a", vaults: [], archived: true });
    expect(await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_b" })).toBeNull();
    expect(await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_old" })).toBeNull();
    expect(await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "missing" })).toBeNull();
  });

  it("ignores archived credentials and honours vault_ids order on host collisions", async () => {
    await addCred("tn_a", "vlt_1", "https://api.example.com", "tok_archived", true);
    await addCred("tn_a", "vlt_2", "https://api.example.com", "tok_2");
    await addCred("tn_a", "vlt_1", "https://api.example.com", "tok_1");
    await addSession({ id: "sess_a", tenant: "tn_a", vaults: ["vlt_1", "vlt_2"] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    const m = await findSessionCredentialForUrl(sql, "https://api.example.com/", scope!);
    expect(m?.injectHeader.value).toBe("Bearer tok_1");
    const grouped = await listCredentialsByVaults(sql, "tn_a", ["vlt_2", "vlt_1"]);
    expect(grouped.map((g) => g.vault_id)).toEqual(["vlt_2", "vlt_1"]);
  });

  it("resolves GitHub repo tokens only from the session's own resources", async () => {
    await addSession({ id: "sess_a", tenant: "tn_a" });
    await addSession({ id: "sess_b", tenant: "tn_b" });
    await sql
      .prepare(`INSERT INTO session_resources (id, session_id, type, config, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind("res_b", "sess_b", "github_repository", JSON.stringify({ url: "https://github.com/b/repo" }), 1)
      .run();
    await sql
      .prepare(`INSERT INTO kv_entries (key, tenant_id, value, expires_at) VALUES (?, ?, ?, NULL)`)
      .bind("t:tn_b:secret:sess_b:res_b", "tn_b", "ghp_b")
      .run();
    const scopeA = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(await findSessionCredentialForUrl(sql, "https://api.github.com/repos/b/repo", scopeA!)).toBeNull();
    const scopeB = await loadSessionScope(sql, { tenantId: "tn_b", sessionId: "sess_b" });
    const m = await findSessionCredentialForUrl(sql, "https://api.github.com/repos/b/repo", scopeB!);
    expect(m?.injectHeader).toEqual({ name: "authorization", value: "Bearer ghp_b" });
  });

  it("legacy host matching is tenant-scoped when OMA_TENANT is concrete", async () => {
    await addCred("tn_b", "vlt_b", "https://api.example.com", "tok_b");
    expect(await findLegacyCredentialForUrl(sql, "https://api.example.com/", "tn_a")).toBeNull();
    expect((await findLegacyCredentialForUrl(sql, "https://api.example.com/", "*"))?.injectHeader.value).toBe(
      "Bearer tok_b",
    );
  });
});

describe("oma-vault session egress policy", () => {
  it("is null (unrestricted) without an environment", async () => {
    await addSession({ id: "sess_a", tenant: "tn_a" });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(scope?.egress).toBeNull();
  });

  it("builds a limited policy from the environment row, incl. MCP hosts when allowed", async () => {
    await sql
      .prepare(`INSERT INTO environments (id, tenant_id, config) VALUES (?, ?, ?)`)
      .bind(
        "env_1",
        "tn_a",
        JSON.stringify({
          type: "cloud",
          networking: { type: "limited", allowed_hosts: ["api.github.com"], allow_mcp_servers: true },
        }),
      )
      .run();
    await addSession({ id: "sess_a", tenant: "tn_a", envId: "env_1", mcpUrls: ["https://mcp.linear.app/sse"] });
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    expect(scope?.egress?.allowedHosts.sort()).toEqual(["api.github.com", "mcp.linear.app"]);
  });

  it("does not read another tenant's environment row", async () => {
    await sql
      .prepare(`INSERT INTO environments (id, tenant_id, config) VALUES (?, ?, ?)`)
      .bind("env_b", "tn_b", JSON.stringify({ networking: { type: "unrestricted" } }))
      .run();
    await sql
      .prepare(
        `INSERT INTO sessions (id, tenant_id, environment_id, vault_ids, environment_snapshot) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        "sess_a",
        "tn_a",
        "env_b",
        "[]",
        JSON.stringify({ id: "env_b", name: "x", config: { type: "cloud", networking: { type: "limited", allowed_hosts: [] } } }),
      )
      .run();
    const scope = await loadSessionScope(sql, { tenantId: "tn_a", sessionId: "sess_a" });
    // Falls back to the session's own snapshot (limited, nothing allowed).
    expect(scope?.egress).toEqual({ allowedHosts: [] });
  });
});
