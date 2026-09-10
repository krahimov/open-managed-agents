import { describe, expect, it } from 'vitest';
import { agentComputerEnabled, agentComputerSpec } from '../src/lib/agent-computer-config';
import { buildSandboxEnvForEnvironment } from '../src/lib/environment-runtime-config';
import type { EnvironmentConfig } from '@open-managed-agents/shared';

describe('Modal environment configuration', () => {
  it('selects Modal for an agent computer and does not reuse a Daytona snapshot', () => {
    const env = { SANDBOX_PROVIDER: 'modal', SANDBOX_SCOPE: 'agent', DAYTONA_SNAPSHOT: 'daytona-desktop' };
    expect(agentComputerEnabled(env)).toBe(true);
    expect(agentComputerSpec(env)).toMatchObject({ provider: 'modal', snapshot: undefined, workdir: '/workspace' });
    expect(agentComputerEnabled({ ...env, SANDBOX_SCOPE: 'session' })).toBe(false);
  });
  it('maps the environment snapshot to the selected provider', () => {
    const environment = { config: { sandbox: { provider: 'modal', scope: 'agent', snapshot: 'im-modal', desktop: true } } } as EnvironmentConfig;
    const env = buildSandboxEnvForEnvironment({ SANDBOX_PROVIDER: 'daytona', DAYTONA_SNAPSHOT: 'daytona-base' }, environment);
    expect(agentComputerSpec(env)).toMatchObject({ provider: 'modal', snapshot: 'im-modal', desktop: true });
    expect(env.DAYTONA_SNAPSHOT).toBe('daytona-base');
  });
});
