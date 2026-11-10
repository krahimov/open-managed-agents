// Which environment a new agent / new session starts with when the user has
// not chosen one.
//
// An environment whose sandbox scope is "agent" gives the agent a PERSISTENT
// cloud computer (its own always-allocated disk, browser, desktop). That is
// a deliberate, billable choice, so it is never a default: preselecting
// "whatever is first in the list" silently handed persistent computers to
// agents that only needed a throwaway per-session sandbox.

export interface EnvironmentChoice {
  id: string;
  config?: { sandbox?: { scope?: string | null; [key: string]: unknown } | null } | null;
}

export function isAgentComputerEnvironment(env: EnvironmentChoice): boolean {
  return env.config?.sandbox?.scope === "agent";
}

/** The first ordinary (per-session sandbox) environment, in list order.
 *  Empty when the workspace only has agent-computer environments — the user
 *  then picks one explicitly instead of getting one by default. */
export function pickDefaultEnvironmentId(environments: readonly EnvironmentChoice[]): string {
  return environments.find((env) => !isAgentComputerEnvironment(env))?.id ?? "";
}

/** Tag every environment picker (new agent, new session) shows next to an
 *  agent-computer environment, so the billable choice is visible wherever
 *  it is made. */
export const AGENT_COMPUTER_LABEL = "persistent agent computer";
