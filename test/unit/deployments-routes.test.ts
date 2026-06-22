// Deployments — management CRUD + public gateway behavior.
//
// Pure package-level tests: in-memory KV, a stub agents service, and a
// recording stub sessions app. No D1 / DO / sandbox involved — the gateway
// contract (key auth, agent pinning, event allowlist, ownership, CORS,
// response sanitization) is what's under test.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  buildDeploymentRoutes,
  buildPublicGatewayRoutes,
} from "@open-managed-agents/http-routes";
import { InMemoryKvStore } from "@open-managed-agents/kv-store";

const TENANT = "tenant_a";

interface RecordedRequest {
  method: string;
  path: string;
  tenantId: string | undefined;
  body: unknown;
}

function makeStubSessionsApp(recorded: RecordedRequest[]) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  const record = async (c: {
    req: { method: string; path: string; json(): Promise<unknown> };
    var: { tenant_id?: string };
  }) => {
    recorded.push({
      method: c.req.method,
      path: c.req.path,
      tenantId: c.var.tenant_id,
      body:
        c.req.method === "POST" ? await c.req.json().catch(() => null) : null,
    });
  };
  app.post("/", async (c) => {
    await record(c);
    const body = (recorded[recorded.length - 1]!.body ?? {}) as {
      title?: string;
    };
    return c.json(
      {
        type: "session",
        id: "sess_stub_1",
        status: "idle",
        title: body.title ?? null,
        created_at: "2026-01-01T00:00:00Z",
        updated_at: "2026-01-01T00:00:00Z",
        // Internals the public client must never see:
        agent: { id: "agent_1", system: "TOP SECRET PROMPT" },
        vault_ids: ["vlt_secret"],
      },
      201,
    );
  });
  app.get("/:id", async (c) => {
    await record(c);
    return c.json({
      type: "session",
      id: c.req.param("id"),
      status: "running",
      title: "t",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      agent: { id: "agent_1", system: "TOP SECRET PROMPT" },
    });
  });
  app.post("/:id/events", async (c) => {
    await record(c);
    return c.json({ ok: true, ids: ["sevt_1"] });
  });
  app.get("/:id/events", async (c) => {
    await record(c);
    return c.json({ data: [{ type: "agent.message", id: "sevt_2" }] });
  });
  app.get("/:id/events/stream", async (c) => {
    await record(c);
    return new Response("data: {}\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  });
  return app;
}

function makeHarness() {
  const kv = new InMemoryKvStore();
  const recorded: RecordedRequest[] = [];
  const agents = {
    get: async ({ agentId }: { tenantId: string; agentId: string }) =>
      agentId === "agent_1" ? { id: "agent_1", name: "Agent One" } : null,
  };
  const services = { kv, agents } as never;

  const mgmt = new Hono<{ Variables: { tenant_id: string } }>();
  mgmt.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  mgmt.route("/", buildDeploymentRoutes({ services }));

  const gateway = new Hono();
  gateway.route(
    "/",
    buildPublicGatewayRoutes({
      kv,
      sessionsApp: makeStubSessionsApp(recorded),
    }),
  );

  return { kv, recorded, mgmt, gateway };
}

async function createDeployment(
  mgmt: Hono<{ Variables: { tenant_id: string } }>,
  body: Record<string, unknown> = {},
) {
  const res = await mgmt.request("/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agent_id: "agent_1", ...body }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as {
    id: string;
    key: string;
    key_prefix: string;
    agent_id: string;
    [k: string]: unknown;
  };
}

describe("deployments — management routes", () => {
  let h: ReturnType<typeof makeHarness>;
  beforeEach(() => {
    h = makeHarness();
  });

  it("creates a deployment and returns the publishable key exactly once", async () => {
    const dep = await createDeployment(h.mgmt, { name: "Support bot" });
    expect(dep.key.startsWith("oma_pk_")).toBe(true);
    expect(dep.key_prefix).toBe(dep.key.slice(0, 11));
    expect(dep.name).toBe("Support bot");
    expect(dep).not.toHaveProperty("key_hash");

    const list = await h.mgmt.request("/");
    const { data } = (await list.json()) as { data: Array<Record<string, unknown>> };
    expect(data).toHaveLength(1);
    expect(data[0]).not.toHaveProperty("key");
    expect(data[0]).not.toHaveProperty("key_hash");
  });

  it("404s when the agent does not exist", async () => {
    const res = await h.mgmt.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: "agent_missing" }),
    });
    expect(res.status).toBe(404);
  });

  it("updates name / origins / disabled", async () => {
    const dep = await createDeployment(h.mgmt);
    const res = await h.mgmt.request(`/${dep.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Renamed",
        allowed_origins: ["https://app.example.com"],
        disabled: true,
      }),
    });
    expect(res.status).toBe(200);
    const updated = (await res.json()) as Record<string, unknown>;
    expect(updated.name).toBe("Renamed");
    expect(updated.allowed_origins).toEqual(["https://app.example.com"]);
    expect(updated.disabled).toBe(true);
  });

  it("rotate_key mints a new key and invalidates the old", async () => {
    const dep = await createDeployment(h.mgmt);
    const res = await h.mgmt.request(`/${dep.id}/rotate_key`, { method: "POST" });
    expect(res.status).toBe(200);
    const rotated = (await res.json()) as { key: string };
    expect(rotated.key).not.toBe(dep.key);

    const oldKeyRes = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${dep.key}` },
      body: "{}",
    });
    expect(oldKeyRes.status).toBe(401);

    const newKeyRes = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${rotated.key}` },
      body: "{}",
    });
    expect(newKeyRes.status).toBe(201);
  });

  it("delete removes the deployment and kills its key", async () => {
    const dep = await createDeployment(h.mgmt);
    const del = await h.mgmt.request(`/${dep.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await h.mgmt.request(`/${dep.id}`);
    expect(get.status).toBe(404);
    const useKey = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${dep.key}` },
      body: "{}",
    });
    expect(useKey.status).toBe(401);
  });
});

describe("deployments — public gateway", () => {
  let h: ReturnType<typeof makeHarness>;
  let dep: Awaited<ReturnType<typeof createDeployment>>;
  beforeEach(async () => {
    h = makeHarness();
    dep = await createDeployment(h.mgmt);
  });

  const authed = (key = dep?.key) => ({ authorization: `Bearer ${key}` });

  it("401s without a key, with a malformed key, and with an unknown key", async () => {
    for (const headers of [
      {},
      { authorization: "Bearer oma_not_a_pk" },
      { authorization: "Bearer oma_pk_doesnotexist000000000000000" },
    ]) {
      const res = await h.gateway.request("/sessions", {
        method: "POST",
        headers,
        body: "{}",
      });
      expect(res.status).toBe(401);
    }
  });

  it("401s when the deployment is disabled", async () => {
    await h.mgmt.request(`/${dep.id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    const res = await h.gateway.request("/sessions", {
      method: "POST",
      headers: authed(),
      body: "{}",
    });
    expect(res.status).toBe(401);
  });

  it("creates a session pinned to the deployed agent, sanitizes the response", async () => {
    const res = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        title: "Hi",
        // Attempts to override the pin must be ignored:
        agent: "agent_evil",
        environment_id: "env_evil",
        vault_ids: ["vlt_evil"],
      }),
    });
    expect(res.status).toBe(201);
    const session = (await res.json()) as Record<string, unknown>;
    expect(session.id).toBe("sess_stub_1");
    expect(session).not.toHaveProperty("agent");
    expect(session).not.toHaveProperty("vault_ids");

    const create = h.recorded.find((r) => r.method === "POST" && r.path === "/");
    expect(create).toBeDefined();
    expect(create!.tenantId).toBe(TENANT);
    const body = create!.body as Record<string, unknown>;
    expect(body.agent).toBe("agent_1");
    expect(body).not.toHaveProperty("vault_ids");
    expect(body).not.toHaveProperty("environment_id");
  });

  it("pins agent version and environment when the deployment carries them", async () => {
    const pinned = await createDeployment(h.mgmt, {
      agent_version: 3,
      environment_id: "env_prod",
    });
    const res = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { authorization: `Bearer ${pinned.key}` },
      body: "{}",
    });
    expect(res.status).toBe(201);
    const create = h.recorded.find((r) => r.method === "POST" && r.path === "/");
    const body = create!.body as Record<string, unknown>;
    expect(body.agent).toEqual({ id: "agent_1", version: 3 });
    expect(body.environment_id).toBe("env_prod");
  });

  it("allows user events through, rejects non-user event types", async () => {
    await h.gateway.request("/sessions", {
      method: "POST",
      headers: authed(),
      body: "{}",
    });

    const ok = await h.gateway.request("/sessions/sess_stub_1/events", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({
        events: [
          { type: "user.message", content: [{ type: "text", text: "hi" }] },
        ],
      }),
    });
    expect(ok.status).toBe(200);

    for (const type of ["agent.message", "session.status_idle", "user.define_outcome"]) {
      const bad = await h.gateway.request("/sessions/sess_stub_1/events", {
        method: "POST",
        headers: { ...authed(), "content-type": "application/json" },
        body: JSON.stringify({ events: [{ type }] }),
      });
      expect(bad.status).toBe(400);
    }
  });

  it("404s session routes for sessions the deployment did not create", async () => {
    // No session bound yet — direct probe of someone else's session id.
    const res = await h.gateway.request("/sessions/sess_foreign/events", {
      method: "POST",
      headers: { ...authed(), "content-type": "application/json" },
      body: JSON.stringify({ events: [{ type: "user.message" }] }),
    });
    expect(res.status).toBe(404);

    // A second deployment can't read the first one's session.
    await h.gateway.request("/sessions", {
      method: "POST",
      headers: authed(),
      body: "{}",
    });
    const other = await createDeployment(h.mgmt, { name: "other" });
    const cross = await h.gateway.request("/sessions/sess_stub_1", {
      headers: { authorization: `Bearer ${other.key}` },
    });
    expect(cross.status).toBe(404);
  });

  it("sanitizes GET /sessions/:id and proxies events + stream", async () => {
    await h.gateway.request("/sessions", {
      method: "POST",
      headers: authed(),
      body: "{}",
    });

    const get = await h.gateway.request("/sessions/sess_stub_1", {
      headers: authed(),
    });
    expect(get.status).toBe(200);
    const session = (await get.json()) as Record<string, unknown>;
    expect(session.status).toBe("running");
    expect(session).not.toHaveProperty("agent");

    const events = await h.gateway.request("/sessions/sess_stub_1/events", {
      headers: authed(),
    });
    expect(events.status).toBe(200);
    expect(((await events.json()) as { data: unknown[] }).data).toHaveLength(1);

    const stream = await h.gateway.request(
      "/sessions/sess_stub_1/events/stream",
      { headers: authed() },
    );
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
  });

  it("CORS: default is *, allowlist echoes allowed origins only", async () => {
    const open = await h.gateway.request("/sessions", {
      method: "POST",
      headers: { ...authed(), origin: "https://anywhere.dev" },
      body: "{}",
    });
    expect(open.headers.get("access-control-allow-origin")).toBe("*");

    const restricted = await createDeployment(h.mgmt, {
      allowed_origins: ["https://app.example.com"],
    });
    const allowedRes = await h.gateway.request("/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${restricted.key}`,
        origin: "https://app.example.com",
      },
      body: "{}",
    });
    expect(allowedRes.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );

    const deniedRes = await h.gateway.request("/sessions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${restricted.key}`,
        origin: "https://evil.example.com",
      },
      body: "{}",
    });
    expect(deniedRes.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("answers OPTIONS preflight without a key", async () => {
    const res = await h.gateway.request("/sessions", {
      method: "OPTIONS",
      headers: { origin: "https://app.example.com" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "x-deployment-key",
    );
  });
});
