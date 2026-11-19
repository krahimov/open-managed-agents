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
    supported: vi.fn(async (_tenant: string, _agent: string) => true), spec: vi.fn(() => spec),
    agentExists: vi.fn(async (tenant: string, agent: string) => tenant === 'tenant-a' && agent === 'agent-a'),
    machines: {
      get: vi.fn(async (): Promise<typeof row | null> => row),
      start: vi.fn(async () => row),
      stop: vi.fn(async (): Promise<typeof row | null> => row),
    },
    screenshot: vi.fn(async (): Promise<Uint8Array | null> => Uint8Array.from([137, 80, 78, 71])),
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

describe('agent computer support is decided per agent', () => {
  it('lets a new computer agent start its computer before any session created it', async () => {
    const { app, deps, row } = setup();
    deps.machines.get.mockResolvedValue(null);
    const status = await app.request('/agents/agent-a/machine');
    expect(await status.json()).toEqual({ supported: true, machine: null });
    expect(deps.supported).toHaveBeenCalledWith('tenant-a', 'agent-a');
    const response = await app.request('/agents/agent-a/machine/start', { method: 'POST' });
    expect(response.status).toBe(200);
    expect(deps.spec).toHaveBeenCalledWith('tenant-a', 'agent-a');
    expect(deps.machines.start).toHaveBeenCalledWith('tenant-a', 'agent-a', row.config);
  });

  it('refuses Start for an agent whose environment has no computer', async () => {
    const { app, deps } = setup();
    deps.machines.get.mockResolvedValue(null);
    deps.supported.mockResolvedValue(false);
    expect(await (await app.request('/agents/agent-a/machine')).json()).toEqual({ supported: false, machine: null });
    expect((await app.request('/agents/agent-a/machine/start', { method: 'POST' })).status).toBe(501);
    expect((await app.request('/agents/agent-a/machine/stop', { method: 'POST' })).status).toBe(501);
    expect(deps.machines.start).not.toHaveBeenCalled();
  });

  it('keeps an existing computer supported whatever the environment says now', async () => {
    const { app, deps } = setup();
    deps.supported.mockResolvedValue(false);
    expect((await (await app.request('/agents/agent-a/machine')).json()).supported).toBe(true);
    expect((await app.request('/agents/agent-a/machine/start', { method: 'POST' })).status).toBe(200);
  });
});

describe('screenshots while a session attaches', () => {
  it('serves the picture while the computer is starting or setting up', async () => {
    const { app, deps, row } = setup();
    for (const state of ['starting', 'bootstrapping'] as const) {
      row.state = state;
      const response = await app.request('/agents/agent-a/machine/screenshot');
      expect(response.status).toBe(200);
      expect(deps.screenshot).toHaveBeenLastCalledWith('tenant-a', 'agent-a', row);
    }
  });

  it('answers 409, not a failure, when the box does not answer yet', async () => {
    const { app, deps, row } = setup();
    row.state = 'starting';
    deps.screenshot.mockResolvedValue(null);
    const response = await app.request('/agents/agent-a/machine/screenshot');
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe('Computer is not running');
  });

  it('never wakes a computer that is being created or stopped', async () => {
    const { app, deps, row } = setup();
    for (const state of ['creating', 'recreating', 'stopping', 'stopped', 'error'] as const) {
      row.state = state;
      expect((await app.request('/agents/agent-a/machine/screenshot')).status).toBe(409);
    }
    expect(deps.screenshot).not.toHaveBeenCalled();
  });
});
