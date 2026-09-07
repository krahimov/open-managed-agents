import { describe, it, expect } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { DesktopGateway } from '../src/lib/desktop-gateway';

describe('desktop gateway', () => {
  it('expires and consumes tickets once, preserving tenant and agent binding', () => {
    let now = 1;
    const gateway = new DesktopGateway(async () => { throw new Error('unused'); }, 'https://test.example', () => now);
    const issued = gateway.issue('tenant-a', 'agent-a');
    const ticket = new URL(issued, 'http://localhost').searchParams.get('ticket')!;
    expect(gateway.consume(ticket)).toMatchObject({ tenantId: 'tenant-a', agentId: 'agent-a' });
    expect(gateway.consume(ticket)).toBeUndefined();
    const expired = new URL(gateway.issue('tenant-a', 'agent-a'), 'http://localhost').searchParams.get('ticket')!;
    now += 30_001;
    expect(gateway.consume(expired)).toBeUndefined();
  });

  it('proxies binary RFB traffic with provider headers only upstream and releases the viewer', async () => {
    const upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(upstream, 'listening');
    const port = (upstream.address() as { port: number }).port;
    let receivedHeader: string | undefined;
    upstream.on('connection', (ws, req) => {
      receivedHeader = req.headers['x-daytona-preview-token'] as string;
      ws.send(Buffer.from('RFB 003.008\n'));
      ws.on('message', data => ws.send(data));
    });
    let released = false;
    const server = createServer();
    const gateway = new DesktopGateway(async (tenant, agent) => {
      expect([tenant, agent]).toEqual(['tenant-a', 'agent-a']);
      return { url: `ws://127.0.0.1:${port}`, headers: { 'x-daytona-preview-token': 'provider-secret' }, release: async () => { released = true; } };
    }, 'https://test.example');
    gateway.attach(server);
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const appPort = (server.address() as { port: number }).port;
    const url = `ws://127.0.0.1:${appPort}${gateway.issue('tenant-a', 'agent-a')}`;
    const client = new WebSocket(url, { origin: 'https://test.example' });
    try {
      const [hello] = await once(client, 'message');
      expect(String(hello)).toBe('RFB 003.008\n');
      expect(receivedHeader).toBe('provider-secret');
      client.send(Buffer.from([1, 2, 3]));
      const [reply] = await once(client, 'message');
      expect(Buffer.from(reply)).toEqual(Buffer.from([1, 2, 3]));
      client.close(); await once(client, 'close');
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(released).toBe(true);
      const reused = new WebSocket(url, { origin: 'https://test.example' });
      const [error] = await once(reused, 'error');
      expect(error.message).toContain('401');
      const foreign = new WebSocket(`ws://127.0.0.1:${appPort}${gateway.issue('tenant-a', 'agent-a')}`, { origin: 'https://foreign.example' });
      const [denied] = await once(foreign, 'error');
      expect(denied.message).toContain('403');
    } finally { client.terminate(); gateway.close(); await new Promise<void>(resolve => server.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve())); }
  });
});
