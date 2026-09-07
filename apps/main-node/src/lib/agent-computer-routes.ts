import { Hono } from 'hono';
import type { AgentMachineRow, AgentMachineSpec } from '@open-managed-agents/sandbox/machines';

interface MachineControl {
  get(tenantId: string, agentId: string): Promise<AgentMachineRow | null>;
  start(tenantId: string, agentId: string, spec: AgentMachineSpec): Promise<AgentMachineRow>;
  stop(tenantId: string, agentId: string): Promise<AgentMachineRow | null>;
}

export interface AgentComputerRouteDeps {
  machines: MachineControl;
  supported: boolean;
  spec(): AgentMachineSpec;
  agentExists(tenantId: string, agentId: string): Promise<boolean>;
  screenshot(tenantId: string, agentId: string): Promise<Uint8Array>;
  logError?(error: unknown): void;
}

/** Return only user-facing state, never provider references or lease owners. */
export function publicMachine(row: AgentMachineRow | null) {
  if (!row) return null;
  return {
    id: row.id, state: row.state, desiredState: row.desiredState,
    provider: row.provider, image: row.image, workdir: row.workdir,
    browserEnabled: row.browserEnabled, generation: row.generation,
    lastActiveAt: row.lastActiveAt, lastStartedAt: row.lastStartedAt,
    lastStoppedAt: row.lastStoppedAt, idleStopMinutes: row.idleStopMinutes,
    errorReason: row.state === 'error' ? 'Computer operation failed. Check server logs and retry.' : null,
  };
}

export function buildAgentComputerRoutes(deps: AgentComputerRouteDeps) {
  const app = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  app.use('/:id/machine/*', async (c, next) => {
    if (!await deps.agentExists(c.get('tenant_id'), c.req.param('id')!)) {
      return c.json({ error: 'Agent not found' }, 404);
    }
    await next();
  });
  app.onError((err, c) => {
    const code = (err as Error & { code?: string }).code;
    if (code === 'machine_config_mismatch') {
      return c.json({ error: 'This agent already has a computer with a different configuration. Use its original environment settings.', code }, 409);
    }
    if (code === 'machine_busy' || code === 'machine_locked') {
      return c.json({ error: code === 'machine_busy' ? 'Computer is busy with active work. Wait for it to finish before stopping.' : 'Another computer operation is in progress. Retry shortly.', code }, 409);
    }
    deps.logError?.(err);
    return c.json({ error: 'Computer operation failed. Check server logs and retry.' }, 502);
  });
  app.get('/:id/machine', async c => {
    const machine = await deps.machines.get(c.get('tenant_id'), c.req.param('id'));
    return c.json({ supported: deps.supported || !!machine, machine: publicMachine(machine) });
  });
  app.post('/:id/machine/start', async c => {
    const existing = await deps.machines.get(c.get('tenant_id'), c.req.param('id'));
    if (!deps.supported && !existing) return c.json({ error: 'Agent computers are not enabled on this deployment.' }, 501);
    const machine = await deps.machines.start(c.get('tenant_id'), c.req.param('id'), existing?.config ?? deps.spec());
    return c.json({ machine: publicMachine(machine) });
  });
  app.post('/:id/machine/stop', async c => {
    const existing = await deps.machines.get(c.get('tenant_id'), c.req.param('id'));
    if (!deps.supported && !existing) return c.json({ error: 'Agent computers are not enabled on this deployment.' }, 501);
    const machine = await deps.machines.stop(c.get('tenant_id'), c.req.param('id'));
    return c.json({ machine: publicMachine(machine) });
  });
  app.get('/:id/machine/screenshot', async c => {
    const machine = await deps.machines.get(c.get('tenant_id'), c.req.param('id'));
    if (!machine || machine.state !== 'running') return c.json({ error: 'Computer is not running' }, 409);
    if (!machine.browserEnabled) return c.json({ error: 'Browser is disabled on this computer' }, 409);
    const bytes = await deps.screenshot(c.get('tenant_id'), c.req.param('id'));
    return new Response(Buffer.from(bytes), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' } });
  });
  return app;
}
