// Account-wide view of Daytona boxes for cleanup jobs (the orphan sweeper in
// apps/main-node). Deliberately tiny: list every box with the facts a
// cleanup decision needs, and delete one box by id. The DECISION about which
// boxes are orphans lives with the host, which knows the database; this file
// only guarantees that a delete acts on the box the decision was made about.

import type { DaytonaClient, DaytonaModule, DaytonaSandboxInstance } from "./daytona-types";
import { isDaytonaBoxGone, loadDaytonaModule } from "./daytona-types";

export interface ProviderBox {
  id: string;
  /** SDK SandboxState string (started | stopped | archived | error | …). */
  state: string | null;
  labels: Record<string, string>;
  /** Epoch ms, or null when the provider did not report a creation time. */
  createdAtMs: number | null;
}

export interface DaytonaBoxInventoryOptions {
  /** Daytona API key. Falls back to DAYTONA_API_KEY env var. */
  apiKey?: string;
  /** Daytona API URL (self-host). Falls back to DAYTONA_API_URL. */
  apiUrl?: string;
  /** Test seam / pre-loaded SDK. Defaults to `await import("@daytonaio/sdk")`. */
  daytonaModule?: DaytonaModule;
}

export class DaytonaBoxInventory {
  private clientPromise: Promise<{ client: DaytonaClient; mod: DaytonaModule }> | null = null;

  constructor(private readonly options: DaytonaBoxInventoryOptions = {}) {}

  /** Every box in the provider account, including ones OMA did not create. */
  async list(): Promise<ProviderBox[]> {
    const { client } = await this.connect();
    const boxes: ProviderBox[] = [];
    for await (const sb of client.list()) boxes.push(toProviderBox(sb));
    return boxes;
  }

  /**
   * Delete one box. The box is re-read first and its labels must still match
   * `expectLabels` (the identity the caller's decision relied on; `null`
   * means the label must be absent) — a box that was relabelled or claimed
   * since it was listed is refused, not deleted. A box that is already gone
   * is reported as `"gone"`, not an error.
   */
  async delete(id: string, expectLabels: Record<string, string | null>): Promise<"deleted" | "gone"> {
    const { client, mod } = await this.connect();
    let sb: DaytonaSandboxInstance;
    try {
      sb = await client.get(id);
    } catch (err) {
      if (isDaytonaBoxGone(err, mod)) return "gone";
      throw err;
    }
    // `get` also resolves names; only the exact id may be deleted.
    if (sb.id !== id) throw new Error(`refusing to delete box ${id}: lookup returned ${sb.id}`);
    for (const [key, value] of Object.entries(expectLabels)) {
      if ((sb.labels?.[key] ?? null) !== value) {
        throw new Error(`refusing to delete box ${id}: label ${key} changed since it was listed`);
      }
    }
    try {
      await client.delete(sb, 60);
    } catch (err) {
      if (isDaytonaBoxGone(err, mod)) return "gone";
      throw err;
    }
    return "deleted";
  }

  private connect(): Promise<{ client: DaytonaClient; mod: DaytonaModule }> {
    if (!this.clientPromise) {
      this.clientPromise = (async () => {
        const apiKey = this.options.apiKey ?? process.env.DAYTONA_API_KEY;
        if (!apiKey) throw new Error("DAYTONA_API_KEY is required to inspect sandboxes");
        const mod = this.options.daytonaModule ?? (await loadDaytonaModule());
        const client = new mod.Daytona({ apiKey, apiUrl: this.options.apiUrl ?? process.env.DAYTONA_API_URL });
        return { client, mod };
      })().catch((err) => {
        this.clientPromise = null;
        throw err;
      });
    }
    return this.clientPromise;
  }
}

function toProviderBox(sb: DaytonaSandboxInstance): ProviderBox {
  const created = typeof sb.createdAt === "string" ? Date.parse(sb.createdAt) : sb.createdAt;
  return {
    id: sb.id,
    state: sb.state ?? null,
    labels: { ...(sb.labels ?? {}) },
    createdAtMs: typeof created === "number" && Number.isFinite(created) ? created : null,
  };
}
