import { describe, expect, it } from "vitest";

import { defaultAgent } from "./default-agent";

const agents = [
  { id: "dq", created_at: "2026-10-01T00:00:00Z" },
  { id: "triage", created_at: "2026-10-02T00:00:00Z" },
  { id: "incident-2", created_at: "2026-11-10T00:00:00Z" },
  { id: "old", created_at: "2026-09-01T00:00:00Z", archived_at: "2026-10-01T00:00:00Z" },
];

describe("defaultAgent", () => {
  it("opens on the agent used most when the sessions were read", () => {
    const usage = new Map([
      ["dq", 9],
      ["triage", 4],
    ]);
    expect(defaultAgent({ agents, usage, remembered: null })?.id).toBe("dq");
    // What was remembered does not override what is known now.
    expect(defaultAgent({ agents, usage, remembered: "triage" })?.id).toBe("dq");
  });

  it("does not switch to the newest agent when the sessions could not be read", () => {
    expect(defaultAgent({ agents, usage: null, remembered: "dq" })?.id).toBe("dq");
  });

  it("does not keep a remembered agent that is archived or gone", () => {
    expect(defaultAgent({ agents, usage: null, remembered: "old" })?.id).toBe("incident-2");
    expect(defaultAgent({ agents, usage: null, remembered: "deleted" })?.id).toBe("incident-2");
  });

  it("with nothing known and nothing remembered, still opens on an agent", () => {
    expect(defaultAgent({ agents, usage: null, remembered: null })?.id).toBe("incident-2");
    expect(defaultAgent({ agents: [], usage: null, remembered: "dq" })).toBeUndefined();
  });
});
