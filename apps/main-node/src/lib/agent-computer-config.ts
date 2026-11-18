import type { AgentMachineSpec } from '@open-managed-agents/sandbox/machines';
import type { EnvironmentConfig } from '@open-managed-agents/shared';
import { buildSandboxEnvForEnvironment } from './environment-runtime-config.js';

type Env = Readonly<Record<string, string | undefined>>;

export function agentComputerSpec(env: Env): AgentMachineSpec {
  const workdir = env.DAYTONA_WORKDIR ?? '/workspace';
  if (workdir !== '/workspace') {
    throw new Error('Agent computers currently require DAYTONA_WORKDIR=/workspace');
  }
  const idle = Number(env.MACHINE_IDLE_STOP_MINUTES ?? 30);
  if (!Number.isFinite(idle) || idle < 1) throw new Error('MACHINE_IDLE_STOP_MINUTES must be positive');
  if (env.MACHINE_DESKTOP === 'true' && env.MACHINE_BROWSER === 'false') throw new Error('Desktop computers require the browser to be enabled');
  return {
    image: env.SANDBOX_IMAGE ?? 'node:22-bookworm',
    snapshot: env.DAYTONA_SNAPSHOT || undefined,
    workdir,
    aptPackages: (env.DAYTONA_BOOTSTRAP_APT_PACKAGES ?? 'build-essential,ca-certificates,coreutils,curl,file,findutils,gawk,git,grep,jq,less,procps,python3,python3-pip,python3-venv,ripgrep,sed,unzip,zip').split(',').map(s => s.trim()).filter(Boolean),
    bootstrapTools: env.DAYTONA_BOOTSTRAP_TOOLS !== 'false',
    browser: env.MACHINE_BROWSER !== 'false',
    ...(env.MACHINE_DESKTOP === 'true' ? { desktop: true } : {}),
    idleStopMinutes: Math.floor(idle),
    sdkMode: 'off',
  };
}

export function agentComputerEnabled(env: Env): boolean {
  return env.SANDBOX_PROVIDER === 'daytona' && env.SANDBOX_SCOPE === 'agent';
}

/**
 * Sandbox env an agent's computer is built from outside a session: its
 * default environment's sandbox config layered over the server env, the
 * same layering `buildSandbox` gives a session started without an explicit
 * environment. So an environment with `sandbox.scope: "agent"` enables the
 * computer even when the server sets no SANDBOX_SCOPE, and its spec is the
 * one the agent's sessions acquire (the machine config is frozen on first
 * creation). Null when the default environment no longer exists.
 */
export async function agentComputerEnv(
  base: Env,
  agent: { metadata?: Record<string, unknown> | null },
  loadEnvironment: (environmentId: string) => Promise<EnvironmentConfig | null>,
): Promise<Env | null> {
  const environmentId = agent.metadata?.default_environment_id;
  if (typeof environmentId !== 'string' || !environmentId) return buildSandboxEnvForEnvironment({ ...base });
  const environment = await loadEnvironment(environmentId);
  return environment ? buildSandboxEnvForEnvironment({ ...base }, environment) : null;
}
