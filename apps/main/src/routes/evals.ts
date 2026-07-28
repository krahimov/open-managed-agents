// CF eval routes — wires buildEvalRoutes from @open-managed-agents/http-routes
// against the per-request Services bundle. Same wire shape as before.
//
// Route bodies live in packages/http-routes/src/evals. We re-build the
// inner Hono sub-app per request because per-request Services resolution
// is per-tenant and inexpensive — same pattern as apps/main/src/index.ts
// uses for buildAgentRoutes (see invokePackage).

import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import type { Services } from "@open-managed-agents/services";
import { buildEvalRoutes } from "@open-managed-agents/http-routes";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// Forward each route through a per-request build of the package's Hono app.
async function dispatch(c: import("hono").Context<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>) {
  const services = c.var.services;
  const sub = buildEvalRoutes({
    evals: services.evals,
    agents: services.agents,
    environments: services.environments,
    // CONFIG_KV-backed store — same one the eval runner tick writes stored
    // trajectories through, so GET /trajectories/:id round-trips.
    kv: services.kv,
  });
  // Strip the /v1/evals (or /v1/oma/evals) mount prefix so the package's
  // routes (declared as `/runs`, `/runs/:id`) match.
  const url = new URL(c.req.url);
  const stripped = url.pathname.replace(/^\/v1\/(?:oma\/)?evals/, "") || "/";
  url.pathname = stripped;
  const wrapped = new Hono<{ Variables: { tenant_id: string } }>();
  wrapped.use("*", async (innerC, next) => {
    innerC.set("tenant_id" as never, c.var.tenant_id as never);
    await next();
  });
  wrapped.route("/", sub as Parameters<typeof wrapped.route>[1]);
  // Re-construct the request with the stripped URL. ArrayBuffer-clone the
  // body so the sub-app sees an unconsumed stream (the outer Request's
  // body could have been touched by middleware).
  const init: RequestInit = {
    method: c.req.method,
    headers: c.req.raw.headers,
  };
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    init.body = await c.req.raw.clone().arrayBuffer();
  }
  return wrapped.fetch(new Request(url, init), c.env, c.executionCtx);
}

// Save-as-eval drafting (evals-design §8) rebuilds the task from the
// session's event log and runs the Node judge resolver — both live only in
// apps/main-node (its POST /v1/evals/draft_task_from_session). Registered
// before the catch-all so this runtime answers with the suites' 501
// posture instead of a bare 404; the console detects it and drops to
// hand-authoring the task.
app.post("/draft_task_from_session", (c) =>
  c.json({ error: "task drafting from a session is unavailable on this runtime" }, 501),
);

app.all("*", dispatch);

export default app;
