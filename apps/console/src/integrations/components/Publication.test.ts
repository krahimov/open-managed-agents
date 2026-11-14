import { describe, expect, it } from "vitest";

import { overallStatus, overallStatusLabel } from "./Publication";
import type { PublicationStatus } from "./StatusPill";

const pubs = (...statuses: PublicationStatus[]) => statuses.map((status) => ({ status }));

describe("a workspace's header status", () => {
  it("counts the agents in the urgent state when others are live", () => {
    expect(overallStatus(pubs("live", "awaiting_install"))).toBe("awaiting_install");
    expect(overallStatusLabel(pubs("live", "awaiting_install"))).toBe("1 of 2 waiting for install");
    expect(overallStatusLabel(pubs("live", "needs_reauth", "needs_reauth"))).toBe("2 of 3 need reconnecting");
    expect(overallStatusLabel(pubs("live", "live", "needs_reauth"))).toBe("1 of 3 needs reconnecting");
    expect(overallStatusLabel(pubs("live", "pending_setup"))).toBe("1 of 2 not set up yet");
  });

  it("keeps the plain label when it is true of every agent", () => {
    expect(overallStatusLabel(pubs("awaiting_install"))).toBeUndefined();
    expect(overallStatusLabel(pubs("awaiting_install", "awaiting_install"))).toBeUndefined();
    expect(overallStatusLabel(pubs("live", "live"))).toBeUndefined();
    expect(overallStatusLabel([])).toBeUndefined();
  });

  it("does not count unpublished agents", () => {
    expect(overallStatusLabel(pubs("awaiting_install", "unpublished"))).toBeUndefined();
    expect(overallStatusLabel(pubs("live", "awaiting_install", "unpublished"))).toBe("1 of 2 waiting for install");
  });
});
