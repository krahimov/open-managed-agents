import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { buildAgentComputerRoutes } from '../src/lib/agent-computer-routes';
import { agentComputerSpec } from '../src/lib/agent-computer-config';
import { newAgentMachineRow, MachineBusyError } from '@open-managed-agents/sandbox/machines';

function setup() {
  const spec = agentComputerSpec({});
  const row = newAgentMachineRow({ id: 'machine-1', tenantId: 'tenant-a', agentId: 'agent-a', provider: 'daytona', spec, now: 1 });
  row.state = 'running'; row.providerRef = 'private-provider-reference';
  const deps = {
    supported: true, spec: () => spec,
    agentExists: vi.fn(async (tenant: string, agent: string) => tenant === 'tenant-a' && agent === 'agent-a'),
    machines: { get: vi.fn(async () => row), start: vi.fn(async () => row), stop: vi.fn(async () => row) },
    screenshot: vi.fn(async () => Uint8Array.from([137, 80, 78, 71])),
    desktopTicket: vi.fn(() => "/v1/computer-desktop/ws?ticket=test"),
  };
  const app = new Hono<{Variables: {tenant_id: string}}>();
  app.use('*', async(c,next) => { c.set('tenant_id', c.req.header('x-test-tenant') ?? 'tenant-a'); await next(); });
  app.route('/agents',buildAgentComputerRoutes(deps));
  return { app, deps, row };
}

describe('agent computer routes', () => {
  it('does not expose machine state, screenshot or mutations across tenants', async () => {
    const {app,deps} = setup();
    for (const [path,method] of [['','GET'],['/start','POST'],['/stop','POST'],['/screenshot','GET'],['/desktop-ticket','POST']]) {
      const response = await app.request(`/agents/agent-a/machine${path}`, {method, headers: {'x-test-tenant':'tenant-b'}});
      expect(response.status).toBe(404);
    }
    expect(deps.machines.get).not.toHaveBeenCalled();
    expect(deps.machines.start).not.toHaveBeenCalled();
    expect(deps.screenshot).not.toHaveBeenCalled();
    expect(deps.desktopTicket).not.toHaveBeenCalled();
  });
  it('returns user-facing state without provider references or configuration', async () => {
    const {app} = setup();
    const response = await app.request('/agents/agent-a/machine');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.machine.state).toBe('running');
    expect(body.machine.providerRef).toBeUndefined();
    expect(body.machine.config).toBeUndefined();
  });
  it('refuses stop while work is active', async () => {
    const {app,deps} = setup();
    deps.machines.stop.mockRejectedValue(new MachineBusyError());
    const response = await app.request('/agents/agent-a/machine/stop', {method:'POST'});
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('machine_busy');
  });
  it('does not wake a stopped computer to take a screenshot', async () => {
    const {app,deps,row} = setup(); row.state = 'stopped';
    expect((await app.request('/agents/agent-a/machine/screenshot')).status).toBe(409);
    expect(deps.screenshot).not.toHaveBeenCalled();
    expect(deps.desktopTicket).not.toHaveBeenCalled();
  });
  it('serves screenshots without caching', async () => {
    const {app} = setup();
    const response = await app.request('/agents/agent-a/machine/screenshot');
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.from([137,80,78,71]));
  });
});

it('issues desktop tickets only for the owning running desktop', async () => {
  const { app, deps, row } = setup();
  expect((await app.request('/agents/agent-a/machine/desktop-ticket', {method:'POST'})).status).toBe(409);
  expect(deps.desktopTicket).not.toHaveBeenCalled();
  row.config.desktop = true;
  const response = await app.request('/agents/agent-a/machine/desktop-ticket', {method:'POST'});
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(deps.desktopTicket).toHaveBeenCalledWith('tenant-a', 'agent-a');
});

describe('per-agent computer support', () => {
  function perAgent() {
    const spec = agentComputerSpec({ DAYTONA_SNAPSHOT: 'oma-computer', MACHINE_DESKTOP: 'true' });
    const row = newAgentMachineRow({ id: 'machine-1', tenantId: 'tenant-a', agentId: 'agent-a', provider: 'daytona', spec, now: 1 });
    const deps = {
      // agent-a's default environment is an agent computer; agent-b's is not.
      supported: vi.fn(async (_tenant: string, agent: string) => agent === 'agent-a'),
      spec: vi.fn(async () => spec),
      agentExists: vi.fn(async (tenant: string, agent: string) => tenant === 'tenant-a' && ['agent-a', 'agent-b'].includes(agent)),
      machines: { get: vi.fn(async () => null as typeof row | null), start: vi.fn(async () => row), stop: vi.fn(async () => row) },
      screenshot: vi.fn(async () => Uint8Array.from([])),
    };
    const app = new Hono<{Variables: {tenant_id: string}}>();
    app.use('*', async(c,next) => { c.set('tenant_id', 'tenant-a'); await next(); });
    app.route('/agents', buildAgentComputerRoutes(deps));
    return { app, deps, spec, row };
  }

  it('starts a first computer for an agent whose environment enables it', async () => {
    const { app, deps, spec } = perAgent();
    expect(await (await app.request('/agents/agent-a/machine')).json()).toEqual({ supported: true, machine: null });
    const response = await app.request('/agents/agent-a/machine/start', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(deps.supported).toHaveBeenCalledWith('tenant-a', 'agent-a');
    expect(deps.machines.start).toHaveBeenCalledWith('tenant-a', 'agent-a', spec);
  });

  it('refuses a first computer for an agent whose environment does not enable it', async () => {
    const { app, deps } = perAgent();
    expect(await (await app.request('/agents/agent-b/machine')).json()).toEqual({ supported: false, machine: null });
    expect((await app.request('/agents/agent-b/machine/start', { method: 'POST' })).status).toBe(501);
    expect((await app.request('/agents/agent-b/machine/stop', { method: 'POST' })).status).toBe(501);
    expect(deps.spec).not.toHaveBeenCalled();
    expect(deps.machines.start).not.toHaveBeenCalled();
  });

  it('keeps an existing computer controllable without re-deciding support', async () => {
    const { app, deps, row } = perAgent();
    deps.machines.get.mockResolvedValue(row);
    expect((await (await app.request('/agents/agent-b/machine')).json()).supported).toBe(true);
    expect((await app.request('/agents/agent-b/machine/start', { method: 'POST' })).status).toBe(200);
    expect(deps.machines.start).toHaveBeenCalledWith('tenant-a', 'agent-b', row.config);
    expect(deps.supported).not.toHaveBeenCalled();
    expect(deps.spec).not.toHaveBeenCalled();
  });
});
