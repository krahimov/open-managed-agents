import type { AgentMachineSpec } from '@open-managed-agents/sandbox/machines';

type Env = Readonly<Record<string, string | undefined>>;

export function agentComputerSpec(env: Env): AgentMachineSpec {
  const provider = env.SANDBOX_PROVIDER === 'modal' ? 'modal' : 'daytona';
  const workdir = env.DAYTONA_WORKDIR ?? '/workspace';
  if (workdir !== '/workspace') {
    throw new Error('Agent computers currently require DAYTONA_WORKDIR=/workspace');
  }
  const idle = Number(env.MACHINE_IDLE_STOP_MINUTES ?? 30);
  if (!Number.isFinite(idle) || idle < 1) throw new Error('MACHINE_IDLE_STOP_MINUTES must be positive');
  if (env.MACHINE_DESKTOP === 'true' && env.MACHINE_BROWSER === 'false') throw new Error('Desktop computers require the browser to be enabled');
  return {
    provider,
    image: env.SANDBOX_IMAGE ?? 'node:22-bookworm',
    snapshot: (provider === 'modal' ? env.MODAL_IMAGE_ID : env.DAYTONA_SNAPSHOT) || undefined,
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
  return ['daytona', 'modal'].includes(env.SANDBOX_PROVIDER ?? '') && env.SANDBOX_SCOPE === 'agent';
}
