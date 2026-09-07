import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import WebSocket, { WebSocketServer } from 'ws';

interface Ticket { tenantId: string; agentId: string; expires: number }
export interface DesktopConnection { url: string; headers: Record<string, string>; release(): Promise<void> }

/** Short-lived, single-use tickets bridge authenticated HTTP to browser WS.
 * Daytona preview credentials never reach the browser or URL logs. */
export class DesktopGateway {
  private tickets = new Map<string, Ticket>();
  private sockets = new Set<WebSocket>();
  constructor(private connect: (tenantId: string, agentId: string) => Promise<DesktopConnection>, private origin: string, private now = Date.now) {}

  issue(tenantId: string, agentId: string): string {
    for (const [key, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(key);
    if (this.tickets.size >= 1000) throw new Error('Too many pending desktop connections');
    const token = randomBytes(32).toString('base64url');
    this.tickets.set(token, { tenantId, agentId, expires: this.now() + 30_000 });
    return `/v1/computer-desktop/ws?ticket=${token}`;
  }

  consume(token: string): Ticket | undefined {
    const ticket = this.tickets.get(token);
    this.tickets.delete(token);
    return ticket && ticket.expires > this.now() ? ticket : undefined;
  }

  attach(server: Server): void {
    const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/v1/computer-desktop/ws') { socket.destroy(); return; }
      // Browser-origin binding prevents another website using an authenticated session.
      if (req.headers.origin !== this.origin) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
      const ticket = this.consume(url.searchParams.get('ticket') ?? '');
      if (!ticket) { socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n'); return; }
      socket.on('error', () => {});
      void (async () => {
        let connection: DesktopConnection | undefined;
        let upstream: WebSocket | undefined;
        let client: WebSocket | undefined;
        let released = false;
        const cleanup = () => {
          if (released) return;
          released = true;
          upstream?.terminate();
          client?.terminate();
          if (client) this.sockets.delete(client);
          if (upstream) this.sockets.delete(upstream);
          void connection?.release().catch(() => {});
        };
        try {
          connection = await this.connect(ticket.tenantId, ticket.agentId);
          if (socket.destroyed) { cleanup(); return; }
          // Accept the client before upstream data can arrive. noVNC queues until RFB starts.
          wss.handleUpgrade(req, socket, head, ws => { client = ws; });
          if (!client) throw new Error('Desktop websocket upgrade failed');
          this.sockets.add(client);
          upstream = new WebSocket(connection.url, ['binary'], { headers: connection.headers, handshakeTimeout: 15000, maxPayload: 16 * 1024 * 1024 });
          this.sockets.add(upstream);
          client.on('close', cleanup); client.on('error', cleanup);
          upstream.on('close', cleanup);
          upstream.on('error', () => {
            console.warn('[agent-computer] desktop upstream connection failed', { agentId: ticket.agentId });
            cleanup();
          });
          // RFB clients send only after the upstream's server-version message.
          client.on('message', (data, binary) => {
            if (upstream?.readyState !== WebSocket.OPEN || upstream.bufferedAmount > 8 * 1024 * 1024) { cleanup(); return; }
            upstream.send(data, { binary });
          });
          upstream.on('message', (data, binary) => {
            if (client?.readyState !== WebSocket.OPEN || client.bufferedAmount > 16 * 1024 * 1024) { cleanup(); return; }
            client.send(data, { binary });
          });
        } catch {
          console.warn('[agent-computer] desktop connection setup failed', { agentId: ticket.agentId });
          cleanup(); socket.destroy();
        }
      })();
    });
  }

  close(): void { for (const socket of this.sockets) socket.terminate(); this.tickets.clear(); }
}
