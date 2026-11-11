// `_oma.mcp_tool_loading` (auto | eager | deferred) on the agents API:
// accepted on create/update, validated, returned under `_oma`, cleared
// with null — same envelope as the other OMA-only fields.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { buildAgentRoutes } from "@open-managed-agents/http-routes";
import { createInMemoryAgentService } from "@open-managed-agents/agents-store/test-fakes";

const TENANT = "tnt_test";

function app() {
  const { service } = createInMemoryAgentService();
  const a = new Hono<{ Variables: { tenant_id: string } }>();
  a.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  a.route("/v1/agents", buildAgentRoutes({ services: { agents: service } as never }));
  const json = (method: string, path: string, body: unknown) =>
    a.request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { a, json, service };
}

type AgentBody = { id: string; version: number; _oma?: { mcp_tool_loading?: string } };

describe("_oma.mcp_tool_loading on the agents API", () => {
  it("is absent by default, round-trips on create and update, and clears with null", async () => {
    const { a, json, service } = app();
    const plain = (await (await json("POST", "/v1/agents", { name: "a", model: "m" })).json()) as AgentBody;
    expect(plain._oma?.mcp_tool_loading).toBeUndefined();
    expect(plain).not.toHaveProperty("mcp_tool_loading");

    const eager = (await (
      await json("POST", "/v1/agents", { name: "b", model: "m", _oma: { mcp_tool_loading: "eager" } })
    ).json()) as AgentBody;
    expect(eager._oma?.mcp_tool_loading).toBe("eager");
    expect((await service.get({ tenantId: TENANT, agentId: eager.id }))?.mcp_tool_loading).toBe("eager");

    expect((await json("PUT", `/v1/agents/${plain.id}`, { _oma: { mcp_tool_loading: "deferred" } })).status).toBe(200);
    const got = (await (await a.request(`/v1/agents/${plain.id}`)).json()) as AgentBody;
    expect(got._oma?.mcp_tool_loading).toBe("deferred");
    expect(got.version).toBe(plain.version + 1);

    // Same value again → no new version.
    const same = (await (await json("PUT", `/v1/agents/${plain.id}`, { _oma: { mcp_tool_loading: "deferred" } })).json()) as AgentBody;
    expect(same.version).toBe(got.version);

    const cleared = (await (await json("PUT", `/v1/agents/${plain.id}`, { _oma: { mcp_tool_loading: null } })).json()) as AgentBody;
    expect(cleared._oma?.mcp_tool_loading).toBeUndefined();
  });

  it("rejects unknown values", async () => {
    const { json } = app();
    const res = await json("POST", "/v1/agents", { name: "x", model: "m", _oma: { mcp_tool_loading: "lazy" } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/mcp_tool_loading must be one of auto\|eager\|deferred/);
  });
});
