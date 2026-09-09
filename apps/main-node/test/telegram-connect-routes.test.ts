import { Hono } from "hono";
import { describe, it, expect, vi } from "vitest";
import { buildTelegramConnectRoutes } from "../src/lib/telegram-connect-routes.js";

// Provider HTTP is stubbed; identity binding and actual bot signatures have separate DB tests.
vi.mock("@open-managed-agents/http-routes", () => ({
  buildVaultRoutes: () => new Hono().post("/:id/credentials/composio_accounts/link", c => c.json({ redirect_url: "https://provider.example/consent" })),
}));
vi.mock("../src/lib/node-oauth-routes.js", () => ({
  buildNodeOAuthRoutes: () => new Hono().get("/authorize", c => c.redirect("https://mcp.example/consent")),
}));
function fixture(mcp = false) {
  const values = new Map<string, string>();
  const agent = { id: "agent-a", metadata: { default_vault_ids: ["vault-a"] } };
  const identity = { tenantId: "tenant-a", userId: "user-a", agent, event: { service: "linear", ...(mcp ? { mcp_server_url: "https://mcp.example/mcp" } : {}) } };
  const graft = vi.fn(async () => true);
  const appendEvent = vi.fn(async () => ({ status: 202 }));
  const d: any = {
    telegram: { miniAppConnection: vi.fn(async (proof, sid, rid) => proof === "valid" && sid === "session-a" && rid === "request-a" ? identity : null) },
    services: {
      kv: { get: async (k: string) => values.get(k) ?? null, put: async (k: string, v: string) => { values.set(k, v); } },
      vaults: { list: vi.fn(async () => [{ id: "vault-a", name: "Apps" }]), create: vi.fn(async () => ({ id: "vault-new" })) },
      agents: { update: vi.fn(async () => agent) },
    },
    router: { appendEvent },
    graftRoutes: new Hono().post("/:id/composio/graft", async c => await graft() ? c.json({ attached_server: true }) : c.json({ error: "No active account" }, 409)),
    baseUrl: "https://orrery.example",
    composio: { resolveApiKey: vi.fn(async () => "test-composio-key") },
  };
  const app = buildTelegramConnectRoutes(d);
  const request = (action: string, body: unknown = {}, proof = "valid", origin = d.baseUrl) => app.request(`/session-a/request-a/${action}`, {
    method: "POST", headers: { "content-type": "application/json", "x-telegram-init-data": proof, origin }, body: JSON.stringify(body),
  });
  return { d, values, request, graft, appendEvent, identity };
}
describe("scoped Telegram connection routes", () => {
  it("needs signed identity even if a browser supplies an Orrery cookie", async () => {
    const f = fixture();
    expect((await f.request("view", {}, "")).status).toBe(401);
    expect(f.d.services.vaults.list).not.toHaveBeenCalled();
    expect((await f.request("view", {}, "valid", "https://evil.example")).status).toBe(403);
    const response = await f.request("view");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ service: "linear", vaults: [{ id: "vault-a" }] });
  });
  it("rejects a different vault and malformed bodies before making provider changes", async () => {
    const f = fixture();
    expect((await f.request("authorize", { vault_id: "someone-elses-vault" })).status).toBe(404);
    for (const body of [null, { vault_id: 3 }, { tenant_id: "another" }]) expect((await f.request("authorize", body)).status).toBe(400);
    expect(f.d.services.vaults.create).not.toHaveBeenCalled();
  });
  it("reports missing Composio configuration without creating a vault", async () => {
    const f = fixture(); f.d.composio.resolveApiKey.mockResolvedValue(null);
    expect((await f.request("authorize")).status).toBe(503);
    expect(f.d.services.vaults.create).not.toHaveBeenCalled();
  });
  it("does not grant access until Composio verifies an active account; retries complete only once", async () => {
    const f = fixture();
    const flow = await (await f.request("authorize", { vault_id: "vault-a" })).json();
    f.graft.mockResolvedValue(false);
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(409);
    expect(f.appendEvent).not.toHaveBeenCalled();
    f.graft.mockResolvedValue(true);
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(200);
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(200);
    expect(f.appendEvent).toHaveBeenCalledTimes(2);
    expect(f.appendEvent.mock.calls[0]).toMatchObject(["session-a", { type: "system.access_granted", request_id: "request-a", vault_id: "vault-a" }]);
  });
  it("does not report completion when the session router rejects the notification", async () => {
    const f = fixture();
    const flow = await (await f.request("authorize", { vault_id: "vault-a" })).json();
    f.appendEvent.mockResolvedValueOnce({ status: 202 }).mockResolvedValueOnce({ status: 503 });
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(503);
    expect(JSON.parse(f.values.get(`telegram_connect:${flow.flow_id}`)!).done).toBeUndefined();
  });
  it("requires an MCP callback receipt before attaching the vault or waking the agent", async () => {
    const f = fixture(true);
    const flow = await (await f.request("authorize", { vault_id: "vault-a" })).json();
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(409);
    expect(f.d.services.agents.update).not.toHaveBeenCalled();
    f.values.set(`telegram_oauth:${flow.flow_id}`, "complete");
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(200);
    expect(f.d.services.agents.update).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-a", agentId: "agent-a" }));
    expect(f.appendEvent).toHaveBeenCalledTimes(2);
  });
  it("rejects expired flows, altered scope, unlinked identities and another session's request", async () => {
    const f = fixture();
    const flow = await (await f.request("authorize", { vault_id: "vault-a" })).json();
    expect((await f.request("complete", { flow_id: "A".repeat(32) })).status).toBe(403);
    const key = `telegram_connect:${flow.flow_id}`;
    const original = JSON.parse(f.values.get(key)!);
    for (const field of ["tenantId", "userId", "sessionId", "requestId", "vaultId"]) {
      f.values.set(key, JSON.stringify({ ...original, [field]: "different" }));
      expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(403);
    }
    f.d.telegram.miniAppConnection.mockResolvedValue(null);
    expect((await f.request("complete", { flow_id: flow.flow_id })).status).toBe(401);
    expect(f.appendEvent).not.toHaveBeenCalled();
  });
});
