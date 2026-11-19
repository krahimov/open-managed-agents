import { describe, expect, it } from "vitest";

import { AMBIENT_TRIGGER_SOURCES, canRunTriggerNow, offeredTriggerSources, triggerSourceFires } from "./ambient-controls";
import { sessionSource, sessionTrigger, sessionTriggerLabel } from "./sessions";

describe("trigger sources a server fires", () => {
  it("offers every source when the server does not say", () => {
    expect(offeredTriggerSources(null)).toEqual([...AMBIENT_TRIGGER_SOURCES]);
    expect(offeredTriggerSources(undefined)).toEqual([...AMBIENT_TRIGGER_SOURCES]);
    expect(triggerSourceFires("slack", null)).toBe(true);
  });

  it("offers only what the server lists, in the console's order", () => {
    const node = new Set(["webhook", "schedule"]);
    expect(offeredTriggerSources(node)).toEqual(["schedule", "webhook"]);
    expect(triggerSourceFires("schedule", node)).toBe(true);
    expect(triggerSourceFires("slack", node)).toBe(false);
    expect(triggerSourceFires(undefined, node)).toBe(false);
  });

  it("never offers nothing", () => {
    expect(offeredTriggerSources(new Set(["carrier-pigeon"]))).toEqual(["schedule"]);
  });

  it("runs on demand only schedules and webhooks", () => {
    expect(canRunTriggerNow("schedule")).toBe(true);
    expect(canRunTriggerNow("webhook")).toBe(true);
    expect(canRunTriggerNow("manual")).toBe(false);
  });
});

describe("a session a trigger started", () => {
  it("comes from a trigger, not the console", () => {
    const s = { metadata: { ambient: { rule_id: "amb_1", rule_name: "Morning sweep", source: "schedule" } } };
    expect(sessionSource(s)).toBe("trigger");
    expect(sessionTrigger(s)).toEqual({ ruleId: "amb_1", ruleName: "Morning sweep", source: "schedule", manual: false });
    expect(sessionTriggerLabel(sessionTrigger(s)!)).toBe("Morning sweep");
  });

  it("reads older runs that recorded only the rule id", () => {
    const schedule = sessionTrigger({ metadata: { ambient: { rule_id: "amb_1", wake_mode: "act" } } })!;
    expect(schedule.source).toBe("schedule");
    expect(sessionTriggerLabel(schedule)).toBe("Schedule trigger");
    const webhook = sessionTrigger({ metadata: { ambient: { rule_id: "amb_2", source: "webhook", source_event_id: "x" } } })!;
    expect(sessionTriggerLabel(webhook)).toBe("Webhook trigger");
  });

  it("is null for a session a person started", () => {
    expect(sessionTrigger({ metadata: {} })).toBeNull();
    expect(sessionSource({ metadata: {} })).toBe("console");
  });
});
