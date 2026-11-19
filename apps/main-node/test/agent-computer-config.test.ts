// Drift guard for the agent computer's frozen machine config.
//
// Every computer stores the spec it was created with; `acquire()` compares
// it with the host's current spec through `canonicalSpec` and throws
// MachineConfigMismatchError on any difference. So a change to the default
// spec (e.g. adding an apt package to the default list) breaks every
// existing computer. Tooling that should reach existing computers belongs in
// bootstrapAgentComputer (see the python step in machines/browser.ts), not
// here. Update the fixture only together with a migration for stored rows.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { canonicalSpec } from "@open-managed-agents/sandbox/machines/manager";
import { agentComputerBrowserEnabled, agentComputerEnabled, agentComputerSpec } from "../src/lib/agent-computer-config";
import { buildSandboxEnvForEnvironment } from "../src/lib/environment-runtime-config";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/agent-computer-canonical-spec.json", import.meta.url), "utf8"),
) as Record<"default" | "snapshot", unknown>;

describe("agentComputerSpec canonical config", () => {
  it("default env matches the pinned fixture byte for byte", () => {
    expect(canonicalSpec(agentComputerSpec({}))).toBe(JSON.stringify(fixture.default));
  });

  it("snapshot env (bootstrap_tools off) matches the pinned fixture", () => {
    const spec = agentComputerSpec({ DAYTONA_SNAPSHOT: "daytona-small", DAYTONA_BOOTSTRAP_TOOLS: "false" });
    expect(canonicalSpec(spec)).toBe(JSON.stringify(fixture.snapshot));
  });
});

describe("agent computer support per environment", () => {
  const computerEnv = { config: { sandbox: { provider: "daytona", scope: "agent", browser: true, desktop: true } } } as never;
  it("is on for an agent whose default environment is an agent-scoped Daytona box, on any deployment", () => {
    const env = buildSandboxEnvForEnvironment({ SANDBOX_PROVIDER: "subprocess" }, computerEnv);
    expect(agentComputerEnabled(env)).toBe(true);
    expect(agentComputerBrowserEnabled(env)).toBe(true);
  });
  it("is off for session sandboxes, and the browser follows the environment", () => {
    expect(agentComputerEnabled(buildSandboxEnvForEnvironment({}, null))).toBe(false);
    expect(agentComputerEnabled(buildSandboxEnvForEnvironment({}, { config: { sandbox: { provider: "daytona" } } } as never))).toBe(false);
    const headless = buildSandboxEnvForEnvironment({}, { config: { sandbox: { provider: "daytona", scope: "agent", browser: false } } } as never);
    expect(agentComputerEnabled(headless)).toBe(true);
    expect(agentComputerBrowserEnabled(headless)).toBe(false);
  });
});
