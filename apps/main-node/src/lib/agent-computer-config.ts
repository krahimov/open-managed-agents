import type { SandboxExecutor } from '@open-managed-agents/sandbox';
import type { AgentMachineSpec } from '@open-managed-agents/sandbox/machines';

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

/** `env` is the deployment env with the agent's default environment applied
 *  (buildSandboxEnvForEnvironment), so the answer is per agent. */
export function agentComputerEnabled(env: Env): boolean {
  return env.SANDBOX_PROVIDER === 'daytona' && env.SANDBOX_SCOPE === 'agent';
}

/** The agent's computer has its own Chromium, so browser tools are part of
 *  the agent's default toolset (see getEnabledTools' browserByDefault). */
export function agentComputerBrowserEnabled(env: Env): boolean {
  return agentComputerEnabled(env) && env.MACHINE_BROWSER !== 'false';
}

/** The agent-computer system-prompt section for a session (see
 *  agentComputerGuidanceFor), read off the tools the session registered so
 *  it names only what the agent can call; undefined off a computer. */
export function agentComputerPromptOptions(
  sandbox: Pick<SandboxExecutor, 'sandboxCapabilities'> | null | undefined,
  tools: unknown,
): { browser: boolean; desktop: boolean } | undefined {
  if (sandbox?.sandboxCapabilities?.().scope !== 'agent') return undefined;
  const names = tools && typeof tools === 'object' ? tools : {};
  return { browser: 'browser_navigate' in names, desktop: 'computer_screenshot' in names };
}
