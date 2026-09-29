// GET /v1/agents/:id/setup_session — backs the console's "Setup chat" button,
// which reopens an agent's setup conversation (metadata.oma_setup) instead of
// starting a fresh one.
import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/http-routes";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";
import { createInMemorySessionService } from "@open-managed-agents/sessions-store/test-fakes";

const TENANT = "tnt_setup_route";

function setup() {
  const { service: agents } = createInMemoryAgentService();
  const { service: sessions } = createInMemorySessionService();
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/agents", buildAgentRoutes({ services: { agents, sessions } as never }));
  const newSession = (agentId: string, metadata?: Record<string, unknown>) =>
    sessions.create({ tenantId: TENANT, agentId, environmentId: "env_1", metadata });
  return { app, agents, sessions, newSession };
}

async function getSetupSession(app: Hono<never>, agentId: string) {
  const res = await app.request(`/v1/agents/${agentId}/setup_session`);
  return { status: res.status, body: (await res.json()) as { data: { id: string } | null } };
}

describe("GET /v1/agents/:id/setup_session", () => {
  it("returns null when the agent has no setup session", async () => {
    const { app, agents, newSession } = setup();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "a", model: "m" } });
    await newSession(agent.id);
    const { status, body } = await getSetupSession(app as never, agent.id);
    expect(status).toBe(200);
    expect(body.data).toBeNull();
  });

  it("finds the setup session even behind later working sessions", async () => {
    const { app, agents, newSession } = setup();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "a", model: "m" } });
    const { session: setupSession } = await newSession(agent.id, { oma_setup: true });
    for (let i = 0; i < 3; i++) await newSession(agent.id);
    const other = await agents.create({ tenantId: TENANT, input: { name: "b", model: "m" } });
    await newSession(other.id, { oma_setup: true });

    const { status, body } = await getSetupSession(app as never, agent.id);
    expect(status).toBe(200);
    expect(body.data?.id).toBe(setupSession.id);
  });

  it("skips terminated setup sessions", async () => {
    const { app, agents, sessions, newSession } = setup();
    const agent = await agents.create({ tenantId: TENANT, input: { name: "a", model: "m" } });
    const { session } = await newSession(agent.id, { oma_setup: true });
    await sessions.update({ tenantId: TENANT, sessionId: session.id, status: "terminated" });
    const { body } = await getSetupSession(app as never, agent.id);
    expect(body.data).toBeNull();
  });

  it("404s for an unknown agent", async () => {
    const { app } = setup();
    const { status } = await getSetupSession(app as never, "agent_missing");
    expect(status).toBe(404);
  });
});
