// Node eval-runner sandbox binding — adapts the in-process SessionRouter to
// the SandboxFetcher (HTTP-shaped) surface tickEvalRuns speaks.
//
// On CF the eval runner fetches into the SessionDO binding; on Node the same
// six paths dispatch straight into NodeSessionRouter, which fronts the
// registry/harness/sandbox. This is what turns the scheduler's former
// `getSandboxBinding: async () => null` stub into a working eval path.
//
// Paths mirrored from packages/evals-runner/src/tick.ts `fwd()` call sites:
//   PUT  /sessions/:id/init
//   POST /sessions/:id/event
//   POST /sessions/:id/exec
//   GET  /sessions/:id/status
//   GET  /sessions/:id/events?limit&order&after_seq
//   GET  /sessions/:id/full-status

import type { SessionRouter, SessionInitParams } from "@open-managed-agents/session-runtime";
import type { SandboxFetcher } from "@open-managed-agents/evals-runner";
import type { SessionEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("eval-sandbox-fetcher");

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export function buildEvalSandboxFetcher(router: SessionRouter): SandboxFetcher {
  return {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const req = input instanceof Request ? input : new Request(input, init);
      const url = new URL(req.url);
      const m = /^\/sessions\/([^/]+)(\/[a-z-]+)?$/.exec(url.pathname);
      if (!m) return json(404, { error: `unknown eval sandbox path: ${url.pathname}` });
      const sessionId = m[1];
      const op = m[2] ?? "";

      try {
        switch (`${req.method} ${op}`) {
          case "PUT /init": {
            const body = (await req.json()) as {
              agent_id: string;
              environment_id: string;
              title?: string;
              tenant_id: string;
              vault_ids?: string[];
            };
            const params: SessionInitParams = {
              agentId: body.agent_id,
              environmentId: body.environment_id,
              title: body.title ?? "",
              tenantId: body.tenant_id,
              ...(body.vault_ids ? { vaultIds: body.vault_ids } : {}),
            };
            await router.init(sessionId, params);
            return json(200, { ok: true });
          }
          case "POST /event": {
            const ev = (await req.json()) as SessionEvent;
            const res = await router.appendEvent(sessionId, ev);
            return new Response(res.body, {
              status: res.status,
              headers: { "Content-Type": "application/json" },
            });
          }
          case "POST /exec": {
            const body = (await req.json()) as { command: string; timeout_ms?: number };
            const res = await router.exec(sessionId, body);
            return json(200, res);
          }
          case "GET /status": {
            const full = await router.getFullStatus(sessionId);
            if (!full) return json(404, { error: "session not found" });
            return json(200, { status: full.status });
          }
          case "GET /events": {
            const afterSeqRaw = url.searchParams.get("after_seq");
            const limitRaw = url.searchParams.get("limit");
            const page = await router.getEvents(sessionId, {
              ...(afterSeqRaw !== null ? { afterSeq: Number(afterSeqRaw) } : {}),
              ...(limitRaw !== null ? { limit: Number(limitRaw) } : {}),
            });
            return json(200, page);
          }
          case "GET /full-status": {
            const full = await router.getFullStatus(sessionId);
            if (!full) return json(404, { error: "session not found" });
            return json(200, full);
          }
          default:
            return json(404, { error: `unknown eval sandbox op: ${req.method} ${op}` });
        }
      } catch (err) {
        log.warn(
          { err, op: "eval_sandbox_fetcher.dispatch_failed", session_id: sessionId, path: url.pathname },
          "eval sandbox dispatch failed",
        );
        const msg = err instanceof Error ? err.message : String(err);
        return json(500, { error: msg.slice(0, 500) });
      }
    },
  };
}
