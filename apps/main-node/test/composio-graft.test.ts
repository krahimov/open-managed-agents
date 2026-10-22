import { describe, expect, it, vi } from "vitest";
import { graftComposioToolkit, COMPOSIO_TOOL_ROUTER_URL } from "../src/lib/composio-graft";

// "No active <toolkit> account" after a successful Composio sign-in had three
// causes: slug mismatch (google-drive vs googledrive), the account being
// looked up under a different key/user than the link created it with, and
// reading too early (INITIATED, not ACTIVE yet).

type Account = { id: string; status: string; toolkit: { slug: string } };

function fixture(opts: { accounts?: Account[][]; key?: { apiKey: string; source: "tenant" | "platform" | "vault" } | null; vaultCreds?: any[]; agentMeta?: any } = {}) {
  const creds: any[] = opts.vaultCreds ?? [];
  const reads = opts.accounts ?? [[{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "googledrive" } }]];
  let read = 0;
  const listConnectedAccounts = vi.fn(async (_deps: any, q: { userId: string }) => ({ items: reads[Math.min(read++, reads.length - 1)], userId: q.userId }));
  const createToolRouterSession = vi.fn(async (_deps: any, input: any) => ({ session_id: "trs_new", mcp: { url: "https://backend.composio.dev/tool_router/trs_new/mcp" }, input }));
  const agent = { id: "agent-1", name: "Drive bot", metadata: opts.agentMeta ?? {}, mcp_servers: [] as any[] };
  const updates: any[] = [];
  const deps = {
    resolveKey: vi.fn(async () => (opts.key === undefined ? { apiKey: "cmp_workspace", source: "tenant" as const } : opts.key)),
    credentials: {
      list: async () => creds,
      create: async (o: any) => { creds.push({ id: `cred-${creds.length + 1}`, display_name: o.displayName, auth: o.auth }); return {}; },
      archive: async (o: any) => { creds.find((c) => c.id === o.credentialId).archived_at = "now"; return {}; },
    },
    sessions: { get: async () => ({ agent_id: "agent-1" }) },
    agents: { get: async () => agent, update: async (o: any) => { updates.push(o.input); return {}; } },
    composio: { listConnectedAccounts, createToolRouterSession } as any,
    sleep: async () => {},
    activeWaitMs: 50,
  };
  const graft = (toolkit: string, extra: Record<string, unknown> = {}) =>
    graftComposioToolkit(deps as any, { tenantId: "t1", sessionId: "s1", toolkit, vaultId: "v1", ...extra });
  return { graft, deps, creds, updates, listConnectedAccounts, createToolRouterSession };
}

describe("graftComposioToolkit", () => {
  it("matches a human toolkit name to Composio's slug (google-drive → googledrive)", async () => {
    const f = fixture();
    const r = await f.graft("google-drive");
    expect(r).toMatchObject({ ok: true, toolkits: ["googledrive"], connected_accounts: { googledrive: "ca_1" } });
  });

  it("waits for a just-authorized account to turn ACTIVE instead of failing on the first read", async () => {
    const f = fixture({ accounts: [
      [{ id: "ca_1", status: "INITIATED", toolkit: { slug: "gmail" } }],
      [{ id: "ca_1", status: "INITIATED", toolkit: { slug: "gmail" } }],
      [{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }],
    ] });
    expect(await f.graft("gmail")).toMatchObject({ ok: true, connected_accounts: { gmail: "ca_1" } });
    expect(f.listConnectedAccounts).toHaveBeenCalledTimes(3);
  });

  it("explains, and changes nothing, when the account never turns active", async () => {
    const f = fixture({ accounts: [[{ id: "ca_1", status: "INITIATED", toolkit: { slug: "gmail" } }]] });
    const r = await f.graft("gmail");
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect((r as any).error).toMatch(/doesn't show an active gmail connection yet.*Retry/);
    expect(f.creds).toHaveLength(0);
    expect(f.updates).toHaveLength(0);
  });

  it("looks the account up under the Composio user the vault's tool router uses (same as the link)", async () => {
    const f = fixture({ vaultCreds: [{ id: "cred-0", display_name: "Composio Tool Router", auth: { type: "composio_mcp", composio_user_id: "custom-user-7", composio_toolkits: ["gmail"] } }],
      accounts: [[{ id: "ca_g", status: "ACTIVE", toolkit: { slug: "gmail" } }, { id: "ca_d", status: "ACTIVE", toolkit: { slug: "googledrive" } }]] });
    const r = await f.graft("googledrive");
    expect(f.listConnectedAccounts.mock.calls[0][1]).toEqual({ userId: "custom-user-7" });
    expect(r).toMatchObject({ ok: true, toolkits: ["gmail", "googledrive"], connected_accounts: { gmail: "ca_g", googledrive: "ca_d" } });
    // The previous router credential is replaced, not duplicated.
    expect(f.creds.filter((c) => !c.archived_at)).toHaveLength(1);
    expect(f.creds.find((c) => !c.archived_at).auth).toMatchObject({ composio_user_id: "custom-user-7", api_key: "cmp_workspace", composio_toolkits: ["gmail", "googledrive"] });
  });

  it("prefers the exact account the popup just created", async () => {
    const f = fixture({ accounts: [[{ id: "ca_old", status: "ACTIVE", toolkit: { slug: "gmail" } }, { id: "ca_new", status: "ACTIVE", toolkit: { slug: "gmail" } }]] });
    expect(await f.graft("gmail", { connectedAccountId: "ca_new" })).toMatchObject({ connected_accounts: { gmail: "ca_new" } });
  });

  it("wires the agent: tool-router server, vault, toolkits; the platform key is stored as an env pointer", async () => {
    const f = fixture({ key: { apiKey: "cmp_operator", source: "platform" } });
    const r = await f.graft("gmail", {});
    expect(r).toMatchObject({ ok: false }); // default account fixture is googledrive
    const g = fixture({ key: { apiKey: "cmp_operator", source: "platform" }, accounts: [[{ id: "ca_1", status: "ACTIVE", toolkit: { slug: "gmail" } }]] });
    expect(await g.graft("Gmail")).toMatchObject({ ok: true, attached_server: true });
    expect(g.updates[0].mcp_servers).toEqual([{ name: "composio", type: "url", url: COMPOSIO_TOOL_ROUTER_URL }]);
    expect(g.updates[0].metadata).toMatchObject({ default_vault_ids: ["v1"], composio_toolkits: ["gmail"] });
    expect(g.creds[0].auth).toMatchObject({ api_key_env: "COMPOSIO_API_KEY" });
    expect(g.creds[0].auth.api_key).toBeUndefined();
  });

  it("503s without any Composio key, 400s without a toolkit", async () => {
    expect(await fixture({ key: null }).graft("gmail")).toMatchObject({ ok: false, status: 503 });
    expect(await fixture().graft("  ")).toMatchObject({ ok: false, status: 400 });
  });
});
