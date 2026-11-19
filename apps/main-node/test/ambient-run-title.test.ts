import { describe, expect, it } from "vitest";
import { ambientRunTitle, webhookRunSuffix } from "@open-managed-agents/agents-store";

const at = Date.UTC(2026, 10, 18, 9, 5);

describe("webhookRunSuffix", () => {
  it("prefers a short human value from the event data, in field order", () => {
    expect(webhookRunSuffix("test-3842931265d9", { build: "1287", version: "v2" })).toBe("1287");
    expect(webhookRunSuffix("evt", { version: " v2.4.1 " })).toBe("v2.4.1");
    expect(webhookRunSuffix("evt", { release: "2026.11" })).toBe("2026.11");
    expect(webhookRunSuffix("test-3842931265d9", { tag: "nightly" })).toBe("nightly");
    expect(webhookRunSuffix("test-3842931265d9", { environment: "staging" })).toBe("staging");
    expect(webhookRunSuffix("evt", { build: 1287 })).toBe("1287");
  });

  it("skips values that are not short single-line names", () => {
    const id = "test-3842931265d9";
    expect(webhookRunSuffix(id, { build: "x".repeat(33) })).toBeNull();
    expect(webhookRunSuffix(id, { build: "a\nb" })).toBeNull();
    expect(webhookRunSuffix(id, { build: "  " })).toBeNull();
    expect(webhookRunSuffix(id, { build: { id: 1 } })).toBeNull();
    expect(webhookRunSuffix(id, { build: 1.5, version: true })).toBeNull();
    expect(webhookRunSuffix(id, { build: ["v1"], environment: "prod" })).toBe("prod");
  });

  it("keeps a chosen event id ahead of values many deliveries share", () => {
    expect(webhookRunSuffix("deploy-1287", { environment: "production" })).toBe("deploy-1287");
    expect(webhookRunSuffix("deploy-1288", { tag: "nightly", environment: "production" })).toBe("deploy-1288");
    expect(webhookRunSuffix("deploy-1287", { version: "v2.4.1", environment: "production" })).toBe("v2.4.1");
    expect(webhookRunSuffix("run-0a1b2c3d4e5f", { tag: "nightly", environment: "production" })).toBe("nightly");
  });

  it("never titles a run with text that draws as something else", () => {
    const id = "test-3842931265d9";
    for (const sneaky of ["\u202egnp.eciovni", "v1\u2028Approved by admin", "v1\u2029x", "a\u200bb", "x\u2066y\u2069", "v\ufeff1"]) {
      expect(webhookRunSuffix(id, { tag: sneaky })).toBeNull();
      expect(webhookRunSuffix(sneaky, {})).toBeNull();
    }
    expect(webhookRunSuffix("incident\n1", {})).toBeNull();
    expect(webhookRunSuffix("café-1", {})).toBe("café-1");
  });

  it("falls back to the caller's event id only when someone chose it", () => {
    expect(webhookRunSuffix("incident-1", {})).toBe("incident-1");
    expect(webhookRunSuffix("deploy-2026-11-18", undefined)).toBe("deploy-2026-11-18");
    for (const generated of ["test-3842931265d9", "run-0a1b2c3d4e5f", "6f1c9a2e-8b7d-4c3e-9f10-2a3b4c5d6e7f", "9f86d081884c7d659a2feaa0c55ad015"]) {
      expect(webhookRunSuffix(generated, { message: "Test event from the console" })).toBeNull();
    }
  });

  it("titles a console test event by its data or its time, never the generated id", () => {
    expect(ambientRunTitle("Deploy finished", { at, suffix: webhookRunSuffix("test-3842931265d9", { build: "1287" }) }))
      .toBe("Deploy finished · 1287");
    expect(ambientRunTitle("Deploy finished", { at, suffix: webhookRunSuffix("test-3842931265d9", {}) }))
      .toBe("Deploy finished · Nov 18, 09:05 UTC");
  });
});
