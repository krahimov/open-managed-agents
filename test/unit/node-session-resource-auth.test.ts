import { describe, expect, it } from "vitest";
import { InMemoryKvStore } from "@open-managed-agents/kv-store/adapters/in-memory";
import { createNodeSessionSecretService } from "../../apps/main-node/src/lib/node-session-secrets";
import { withSessionProxyContext } from "../../packages/sandbox/src/adapters/outbound-proxy";

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

  it("adds non-secret session identity to the outbound proxy URL", () => {
    const scoped = withSessionProxyContext("http://127.0.0.1:14322", {
      tenantId: "tn_a",
      sessionId: "sess_1",
    });

    const url = new URL(scoped);
    expect(url.username).toBe("oma");
    expect(Buffer.from(url.password, "base64url").toString("utf8")).toBe("tn_a|sess_1");
    expect(url.origin).toBe("http://127.0.0.1:14322");
  });
});
