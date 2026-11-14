import type { EnvironmentChoice } from "../lib/default-environment";

/**
 * CONTRACT (step 0 baseline). Owner: C6a (with components/DesktopViewer.tsx).
 * Mounted on the agent's Overview tab. Renders nothing yet.
 *
 * Port of main's components/AgentComputerPanel.tsx in Muse's language. The
 * agent's persistent cloud computer: `GET /v1/agents/:id/machine`
 * ({ machine, supported }), polled every 3s while it is changing state and
 * every 10s while running. Shows its state in plain words (Creating,
 * Setting up, Running, Stopped, ...), the last screenshot (fetched with the
 * bearer and tenant headers, never a bare <img src>), start / stop /
 * recreate controls, and the live desktop (DesktopViewer over noVNC, lazy
 * chunk) when the machine has `desktopEnabled`. Renders nothing when
 * `supported` is false or the endpoint is not on the server. With
 * `localRuntime` it says a cloud computer does not apply. When the default
 * environment is not a computer environment (isAgentComputerEnvironment)
 * and no machine exists, it explains how to get one (AGENT_COMPUTER_LABEL).
 *
 * C6a also exports from this file what AgentDetail's delete needs:
 * agentMachineQueryKey, loadAgentMachine and deleteAgentConfirmText (see
 * main's file), so the delete ConfirmDialog says for certain whether a
 * computer and its disk go with the agent.
 */
export interface AgentComputerPanelProps {
  agentId: string;
  /** The agent runs on the user's own machine (`_oma.runtime_binding`),
   *  so a cloud computer does not apply to it. */
  localRuntime?: boolean;
  /** The agent's default environment: undefined while it loads, null when
   *  the agent has none (or it could not be loaded). */
  defaultEnvironment?: EnvironmentChoice | null;
}

export function AgentComputerPanel(_props: AgentComputerPanelProps) {
  return null;
}
