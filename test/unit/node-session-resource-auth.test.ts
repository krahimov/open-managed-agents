import { describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { createNodeSessionSecretService } from "../../apps/main-node/src/lib/node-session-secrets";

describe("node session resource auth helpers", () => {
  it("stores and cascades local session resource secrets by tenant/session/resource", async () => {
    const kv = new InMemoryKvStore();
    const secrets = createNodeSessionSecretService(kv);

    await secrets.put({
      tenantId: "tn_a",
      sessionId: "sess_1",
      resourceId: "res_1",
      value: "tok_1",
    });
    await secrets.put({
      tenantId: "tn_a",
      sessionId: "sess_1",
      resourceId: "res_2",
      value: "tok_2",
    });
    await secrets.put({
      tenantId: "tn_a",
      sessionId: "sess_2",
      resourceId: "res_3",
      value: "tok_3",
    });

    await expect(
      secrets.get({ tenantId: "tn_a", sessionId: "sess_1", resourceId: "res_1" }),
    ).resolves.toBe("tok_1");

    await expect(
      secrets.deleteAllForSession({ tenantId: "tn_a", sessionId: "sess_1" }),
    ).resolves.toBe(2);
    await expect(
      secrets.get({ tenantId: "tn_a", sessionId: "sess_1", resourceId: "res_1" }),
    ).resolves.toBeNull();
    await expect(
      secrets.get({ tenantId: "tn_a", sessionId: "sess_2", resourceId: "res_3" }),
    ).resolves.toBe("tok_3");
  });

  // Signed proxy-token coverage (withSessionProxyContext) lives in
  // packages/sandbox/tests/local-subprocess-env.test.ts — it is Node-only
  // (node:crypto / node:fs) and runs in the Node vitest pool.
});
