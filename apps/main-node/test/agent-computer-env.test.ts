// Agent computer support and spec outside a session come from the agent's
// default environment, layered over the server env exactly as a session's
// sandbox is. Prod sets no SANDBOX_SCOPE; its computers come from
// environments with `sandbox.scope: "agent"`, so a server-env-only check
// answered 501 to POST /machine/start for every new agent.

import { describe, expect, it, vi } from "vitest";
import type { EnvironmentConfig } from "@open-managed-agents/shared";
import { canonicalSpec } from "@open-managed-agents/sandbox/machines/manager";
import {
  agentComputerEnabled,
  agentComputerEnv,
  agentComputerSpec,
} from "../src/lib/agent-computer-config";
import { buildSandboxEnvForEnvironment } from "../src/lib/environment-runtime-config";

const serverEnv = { SANDBOX_PROVIDER: "subprocess", DAYTONA_API_KEY: "key" };

const computerEnvironment = {
  id: "env-computer",
  name: "agent-computer",
  config: {
    type: "cloud",
    sandbox: {
      provider: "daytona",
      scope: "agent",
      snapshot: "oma-computer",
      browser: true,
      desktop: true,
    },
  },
} as unknown as EnvironmentConfig;

const sessionEnvironment = {
  id: "env-session",
  name: "sandbox",
  config: { type: "cloud", sandbox: { provider: "daytona" } },
} as unknown as EnvironmentConfig;

const environments: Record<string, EnvironmentConfig> = {
  "env-computer": computerEnvironment,
  "env-session": sessionEnvironment,
};
const load = async (id: string) => environments[id] ?? null;

describe("agentComputerEnv", () => {
  it("enables the computer from an agent-scope default environment without SANDBOX_SCOPE", async () => {
    expect(agentComputerEnabled(serverEnv)).toBe(false);
    const env = await agentComputerEnv(serverEnv, { metadata: { default_environment_id: "env-computer" } }, load);
    expect(env).not.toBeNull();
    expect(agentComputerEnabled(env!)).toBe(true);
  });

  it("builds the same spec a session in that environment acquires", async () => {
    const env = await agentComputerEnv(serverEnv, { metadata: { default_environment_id: "env-computer" } }, load);
    const spec = agentComputerSpec(env!);
    expect(spec).toMatchObject({ snapshot: "oma-computer", browser: true, desktop: true });
    const sessionSpec = agentComputerSpec(buildSandboxEnvForEnvironment(serverEnv, computerEnvironment));
    expect(canonicalSpec(spec)).toBe(canonicalSpec(sessionSpec));
  });

  it("stays disabled for a session-scope default environment", async () => {
    const env = await agentComputerEnv(serverEnv, { metadata: { default_environment_id: "env-session" } }, load);
    expect(agentComputerEnabled(env!)).toBe(false);
  });

  it("falls back to the server env when the agent has no default environment", async () => {
    const loadSpy = vi.fn(load);
    expect(agentComputerEnabled((await agentComputerEnv(serverEnv, { metadata: {} }, loadSpy))!)).toBe(false);
    const global = { SANDBOX_PROVIDER: "daytona", SANDBOX_SCOPE: "agent" };
    expect(agentComputerEnabled((await agentComputerEnv(global, {}, loadSpy))!)).toBe(true);
    expect(loadSpy).not.toHaveBeenCalled();
  });

  it("keeps a server-wide agent scope when the default environment names none", async () => {
    const global = { SANDBOX_PROVIDER: "daytona", SANDBOX_SCOPE: "agent" };
    const env = await agentComputerEnv(global, { metadata: { default_environment_id: "env-session" } }, load);
    expect(agentComputerEnabled(env!)).toBe(true);
  });

  it("is null when the default environment no longer exists", async () => {
    expect(await agentComputerEnv(serverEnv, { metadata: { default_environment_id: "env-gone" } }, load)).toBeNull();
  });
});
