import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { bodyLimit } from "hono/body-limit";
import { buildVaultRoutes, type RouteServices } from "@open-managed-agents/http-routes";
import type { SessionRouter } from "@open-managed-agents/session-runtime";
import { TelegramOnboarding } from "./telegram-onboarding.js";
import { buildNodeOAuthRoutes } from "./node-oauth-routes.js";

type Vars = { Variables: { tenant_id: string; user_id?: string } };
interface Deps {
  telegram: TelegramOnboarding;
  services: RouteServices;
  router: SessionRouter;
  graftRoutes: Hono<Vars>;
  baseUrl: string;
  composio: { apiKey?: string; resolveApiKey: (tenantId: string) => Promise<string | null> };
}
interface Flow {
  tenantId: string;
  userId: string;
  sessionId: string;
  requestId: string;
  vaultId: string;
  done?: boolean;
}

/** Private dispatch to existing provider handlers. Neither the path nor tenant is client supplied. */
async function dispatch(routes: Hono<Vars>, tenantId: string, url: URL, body?: unknown) {
  const app = new Hono<Vars>();
  app.use("*", async (c, next) => { c.set("tenant_id", tenantId); await next(); });
  app.route("/", routes);
  return app.request(url.toString(), body === undefined ? undefined : {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

/** No general Orrery session or API key is issued. Every operation verifies Telegram and ownership. */
export function buildTelegramConnectRoutes(d: Deps) {
  const app = new Hono();
  const completing = new Set<string>();
  const bodySchema = z.object({ vault_id: z.string().min(1).max(256).optional(), flow_id: z.string().max(64).optional() }).strict();
  app.use("*", bodyLimit({ maxSize: 32768 }));
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    // The proof travels only in a custom header; no URL secrets or browser cookies are accepted.
    if (c.req.header("origin") && c.req.header("origin") !== new URL(d.baseUrl).origin)
      return c.json({ error: "Invalid origin" }, 403);
    await next();
  });
  app.post("/:sid/:request/:action", async c => {
    const sid = c.req.param("sid"), requestId = c.req.param("request"), action = c.req.param("action");
    const identity = await d.telegram.miniAppConnection(c.req.header("x-telegram-init-data") ?? "", sid, requestId);
    if (!identity) {
      console.info(JSON.stringify({ op: "telegram.connect_identity_rejected" }));
      return c.json({ error: "Open a fresh Connect button in your linked Telegram chat. This connection request could not be verified." }, 401);
    }
    const { tenantId, userId, agent } = identity;
    const event = identity.event as unknown as { service: string; auth_kind?: string; mcp_server_url?: string };
    const service = event.service.toLowerCase();
    const vaults = (await d.services.vaults.list({ tenantId, includeArchived: false })).filter(v => !v.archived_at);
    if (action === "view") return c.json({
      service, reason: (identity.event as unknown as { reason?: string }).reason,
      vaults: vaults.map(v => ({ id: v.id, name: v.name })),
      vault_ids: agent.metadata?.default_vault_ids ?? [],
    });
    const parsed = bodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "Invalid connection request" }, 400);
    const body = parsed.data;
    if (action === "authorize") {
      if (event.auth_kind === "mcp_api_key" || event.auth_kind === "llm_provider")
        return c.json({ error: "This integration needs an API key. Add it in Orrery’s credential vault, then return to Telegram." }, 409);
      if (!event.mcp_server_url && !d.composio.apiKey && !await d.composio.resolveApiKey(tenantId))
        return c.json({ error: "Composio is not configured on this Orrery workspace. Connect Composio in Orrery or ask the operator to configure it, then retry." }, 503);
      if (body.vault_id && !vaults.some(v => v.id === body.vault_id)) return c.json({ error: "Vault not found" }, 404);
      const vaultId = body.vault_id || (await d.services.vaults.create({ tenantId, name: "Connected Apps" })).id;
      const flowId = randomBytes(24).toString("base64url");
      const flow: Flow = { tenantId, userId, sessionId: sid, requestId, vaultId };
      await d.services.kv.put(`telegram_connect:${flowId}`, JSON.stringify(flow), { expirationTtl: 900 });
      let url: string;
      if (event.mcp_server_url) {
        const authorize = new URL("/authorize", d.baseUrl);
        authorize.searchParams.set("mcp_server_url", event.mcp_server_url);
        authorize.searchParams.set("vault_id", vaultId);
        authorize.searchParams.set("redirect_uri", `${new URL(d.baseUrl).origin}/composio/callback?toolkit=${encodeURIComponent(service)}`);
        const response = await dispatch(buildNodeOAuthRoutes({ services: d.services, env: process.env, completionKey: `telegram_oauth:${flowId}` }), tenantId, authorize);
        const location = response.headers.get("location");
        if (!location) return c.json({ error: "The provider could not start OAuth. Check that its MCP OAuth app is configured on this deployment." }, 502);
        url = location;
      } else {
        const response = await dispatch(buildVaultRoutes({ services: d.services, composio: d.composio }), tenantId,
          new URL(`/${encodeURIComponent(vaultId)}/credentials/composio_accounts/link`, d.baseUrl),
          { toolkit: service, callback_url: `${new URL(d.baseUrl).origin}/composio/callback?toolkit=${encodeURIComponent(service)}` });
        const result = await response.json() as { redirect_url?: string; error?: string };
        if (!response.ok || !result.redirect_url) return c.json({ error: result.error || "Could not start provider authorization" }, 503);
        url = result.redirect_url;
      }
      if (new URL(url).protocol !== "https:") return c.json({ error: "Provider returned an invalid authorization URL" }, 502);
      console.info(JSON.stringify({ op: "telegram.connect_authorization_started", service, session_id: sid }));
      return c.json({ url, flow_id: flowId });
    }
    if (action !== "complete") return c.json({ error: "Unknown connection operation" }, 404);
    const flowId = body.flow_id ?? "";
    if (!/^[A-Za-z0-9_-]{32}$/.test(flowId)) return c.json({ error: "Invalid connection flow" }, 400);
    const raw = await d.services.kv.get(`telegram_connect:${flowId}`);
    const flow: Flow | null = raw ? JSON.parse(raw) : null;
    if (!flow || flow.tenantId !== tenantId || flow.userId !== userId || flow.sessionId !== sid || flow.requestId !== requestId || !vaults.some(v => v.id === flow.vaultId))
      return c.json({ error: "Connection expired. Open a new Connect button." }, 403);
    if (flow.done) return c.json({ connected: true });
    if (completing.has(flowId)) return c.json({ error: "Connection verification is already running" }, 409);
    completing.add(flowId);
    try {
      if (event.mcp_server_url) {
        if (await d.services.kv.get(`telegram_oauth:${flowId}`) !== "complete")
          return c.json({ error: "Provider authorization is not complete yet. Finish consent, then check again." }, 409);
        const old = Array.isArray(agent.metadata?.default_vault_ids) ? agent.metadata.default_vault_ids as string[] : [];
        await d.services.agents.update({ tenantId, agentId: agent.id, input: { metadata: { default_vault_ids: [...new Set([...old, flow.vaultId])] } } });
      } else {
        const response = await dispatch(d.graftRoutes, tenantId, new URL(`/${encodeURIComponent(sid)}/composio/graft`, d.baseUrl), { toolkit: service, vault_id: flow.vaultId });
        if (!response.ok) return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
      }
      const grant = await d.router.appendEvent(sid, { type: "system.access_granted", request_id: requestId, service, vault_id: flow.vaultId, ...(event.mcp_server_url ? { mcp_server_url: event.mcp_server_url } : {}) });
      if (grant.status >= 400) return c.json({ error: "The connection was saved, but its grant could not be recorded. Retry verification." }, 503);
      const notification = await d.router.appendEvent(sid, { type: "user.message", content: [{ type: "text", text: `[access granted] ${service} is connected and the selected vault is attached to this agent. Continue setup; new work sessions will use the saved connections.` }] });
      if (notification.status >= 400) return c.json({ error: "The connection was saved, but the agent could not be notified. Retry verification." }, 503);
      await d.services.kv.put(`telegram_connect:${flowId}`, JSON.stringify({ ...flow, done: true }), { expirationTtl: 900 });
      console.info(JSON.stringify({ op: "telegram.connect_verified", service, session_id: sid }));
      return c.json({ connected: true });
    } finally { completing.delete(flowId); }
  });
  return app;
}
