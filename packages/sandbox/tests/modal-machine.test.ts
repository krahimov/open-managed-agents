import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentMachineManager, type MachineDriver } from '../src/machines/manager';
import { InMemoryAgentMachineStore, MachineBusyError, MachineConfigMismatchError, type AgentMachineSpec } from '../src/machines/ports';
import { FakeDaytona, fakeDaytonaModule } from './fake-daytona';
import { isDaytonaNotFound } from '../src/adapters/daytona-types';

const spec: AgentMachineSpec = { provider: 'modal', image: 'node:22-bookworm', workdir: '/workspace', aptPackages: [], bootstrapTools: false, browser: false, idleStopMinutes: 5, sdkMode: 'off' };
const managers: AgentMachineManager[] = [];
afterEach(async () => { await Promise.all(managers.splice(0).map(m => m.dispose())); });

function fixture() {
  const store = new InMemoryAgentMachineStore();
  const cloud = new FakeDaytona();
  const driver: MachineDriver = {
    client: async () => ({
      // Modal releases names on termination; Daytona's fake retains stopped
      // disks and names, so emulate Modal's name lifecycle here.
      create: async (params, options) => {
        for (const box of cloud.sandboxes.values()) if (box.state === 'stopped') box.name = `${box.name}-terminated-${box.id}`;
        return cloud.create(params, options);
      },
      get: id => cloud.get(id), list: labels => cloud.list(labels), delete: async box => { const found = cloud.sandboxes.get(box.id); if (found) await cloud.delete(found); },
    }),
    isNotFound: isDaytonaNotFound,
    checkpoint: vi.fn(async () => 'im-checkpoint-1'),
    deleteCheckpoint: vi.fn(async () => {}),
  };
  const make = () => {
    const manager = new AgentMachineManager({ store, drivers: { modal: driver }, daytonaModule: fakeDaytonaModule(cloud), apiKey: 'test', bootstrap: async () => {}, tickIntervalMs: 0 });
    managers.push(manager); return manager;
  };
  const manager = make();
  return { store, cloud, driver, manager, make, acquire: () => manager.acquire({ tenantId: 'tenant1', agentId: 'agent1', spec }) };
}

describe('Modal machine lifecycle', () => {
  it('commits the checkpoint before termination, then restores a new generation after host restart', async () => {
    const f = fixture(); const first = await f.acquire();
    vi.spyOn(first.sb, 'stop').mockImplementation(async () => {
      expect((await f.manager.get('tenant1', 'agent1'))?.snapshot).toBe('im-checkpoint-1');
      first.sb.state = 'stopped';
    });
    await f.manager.stop('tenant1', 'agent1');
    await f.manager.dispose();
    const second = await f.make().acquire({ tenantId: 'tenant1', agentId: 'agent1', spec });
    expect(second.sb.id).not.toBe(first.sb.id);
    expect(second.generation).toBe(2);
    expect(f.cloud.createCalls[1]).toMatchObject({ snapshot: 'im-checkpoint-1' });
    expect(f.cloud.createCalls[1]).not.toHaveProperty('image');
  });

  it('keeps the only live disk when snapshot creation fails', async () => {
    const f = fixture(); const box = await f.acquire();
    f.driver.checkpoint = async () => { throw new Error('snapshot unavailable'); };
    await expect(f.manager.stop('tenant1', 'agent1')).rejects.toThrow('snapshot unavailable');
    expect(box.sb.state).toBe('started');
    expect((await f.manager.get('tenant1', 'agent1'))?.snapshot).toBeNull();
    expect((await f.acquire()).sb.id).toBe(box.sb.id);
  });

  it('does not terminate if persisting the checkpoint fails', async () => {
    const f = fixture(); const box = await f.acquire();
    const original = f.store.update.bind(f.store);
    vi.spyOn(f.store, 'update').mockImplementation(async (id, patch, now) => {
      if (patch.snapshot) throw new Error('database unavailable');
      return original(id, patch, now);
    });
    await expect(f.manager.stop('tenant1', 'agent1')).rejects.toThrow('database unavailable');
    expect(box.sb.state).toBe('started');
  });

  it('recovers the termination-to-state-update crash using the committed snapshot', async () => {
    const f = fixture(); const box = await f.acquire();
    const row = (await f.manager.get('tenant1', 'agent1'))!;
    await f.store.update(row.id, { snapshot: 'im-durable', state: 'stopping' }, Date.now());
    await box.sb.stop();
    const recovered = await f.make().acquire({ tenantId: 'tenant1', agentId: 'agent1', spec });
    expect(recovered.generation).toBe(2);
    expect(f.cloud.createCalls[1]).toMatchObject({ snapshot: 'im-durable' });
  });

  it('rejects replacing an expired computer with an empty disk', async () => {
    const f = fixture(); const box = await f.acquire(); await box.sb.stop();
    await expect(f.acquire()).rejects.toThrow('without a checkpoint');
    expect(f.cloud.createCalls).toHaveLength(1);
  });

  it('cannot switch an existing agent to another provider', async () => {
    const f = fixture(); await f.acquire();
    await expect(f.manager.acquire({ tenantId: 'tenant1', agentId: 'agent1', spec: { ...spec, provider: 'daytona' } })).rejects.toBeInstanceOf(MachineConfigMismatchError);
    expect(f.cloud.createCalls).toHaveLength(1);
  });

  it('refuses checkpointing active work', async () => {
    const f = fixture();
    const p = f.manager.provider({ tenantId: 'tenant1', agentId: 'agent1', sessionId: 'session1', spec });
    await p.setTurnActive(true);
    await expect(f.manager.stop('tenant1', 'agent1')).rejects.toBeInstanceOf(MachineBusyError);
    expect(f.driver.checkpoint).not.toHaveBeenCalled();
  });

  it('removes a superseded owned checkpoint', async () => {
    const f = fixture(); await f.acquire();
    const row = (await f.manager.get('tenant1', 'agent1'))!;
    await f.store.update(row.id, { snapshot: 'im-old' }, Date.now());
    await f.manager.stop('tenant1', 'agent1');
    expect(f.driver.deleteCheckpoint).toHaveBeenCalledWith('im-old');
  });
});
