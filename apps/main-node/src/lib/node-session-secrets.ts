import type { KvStore } from "@open-managed-agents/kv-store";
import { listAll } from "@open-managed-agents/kv-store";

export interface NodeSessionSecretService {
  put(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
    value: string;
  }): Promise<void>;
  get(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<string | null>;
  deleteOne(opts: {
    tenantId: string;
    sessionId: string;
    resourceId: string;
  }): Promise<void>;
  deleteAllForSession(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<number>;
}

export function createNodeSessionSecretService(kv: KvStore): NodeSessionSecretService {
  return {
    async put({ tenantId, sessionId, resourceId, value }) {
      await kv.put(secretKey(tenantId, sessionId, resourceId), value);
    },

    async get({ tenantId, sessionId, resourceId }) {
      return kv.get(secretKey(tenantId, sessionId, resourceId));
    },

    async deleteOne({ tenantId, sessionId, resourceId }) {
      await kv.delete(secretKey(tenantId, sessionId, resourceId));
    },

    async deleteAllForSession({ tenantId, sessionId }) {
      const keys = await listAll(kv, secretPrefix(tenantId, sessionId));
      await Promise.all(keys.map((key) => kv.delete(key.name)));
      return keys.length;
    },
  };
}

function secretKey(tenantId: string, sessionId: string, resourceId: string): string {
  return `${secretPrefix(tenantId, sessionId)}${resourceId}`;
}

function secretPrefix(tenantId: string, sessionId: string): string {
  return `t:${tenantId}:secret:${sessionId}:`;
}
