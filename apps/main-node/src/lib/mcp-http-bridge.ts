/**
 * In-process streamable-HTTP MCP bridge for harnesses whose vendor SDK has no
 * in-process MCP transport (codex-sdk). The Claude Agent SDK lets us host
 * platform-tool handlers directly via createSdkMcpServer; the Codex CLI can
 * only reach MCP servers over stdio or HTTP — so this spins up a loopback
 * HTTP server per turn whose tool handlers run in THIS process (and can
 * therefore append session events, update the agent row, schedule wakeups…).
 *
 * Security: binds 127.0.0.1 on an ephemeral port, requires a per-bridge
 * random bearer token (passed to the codex child via mcp_servers
 * http_headers), and lives only for the duration of one turn.
 *
 * Stateless MCP: a fresh McpServer + transport per request
 * (sessionIdGenerator: undefined) — the codex client does initialize +
 * tools/list + tools/call as independent POSTs, which this handles fine.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

export interface BridgeTool {
  name: string;
  description: string;
  /** zod raw shape ({ field: z.string()... }) — cast internally so the
   *  workspace zod and the MCP SDK's bundled zod don't fight nominally. */
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
}

export interface McpHttpBridge {
  url: string;
  /** Headers the MCP client must send (bearer auth). */
  headers: Record<string, string>;
  close: () => Promise<void>;
}

export async function startMcpHttpBridge(
  serverName: string,
  tools: BridgeTool[],
): Promise<McpHttpBridge> {
  const token = randomBytes(24).toString("hex");

  const buildServer = () => {
    const server = new McpServer({ name: serverName, version: "1.0.0" });
    for (const t of tools) {
      server.registerTool(
        t.name,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { description: t.description, inputSchema: t.inputSchema as any },
        (async (args: Record<string, unknown>) => {
          try {
            const r = await t.handler(args ?? {});
            return {
              content: [{ type: "text" as const, text: r.text }],
              ...(r.isError ? { isError: true } : {}),
            };
          } catch (err) {
            return {
              content: [
                { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
              ],
              isError: true,
            };
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        }) as any,
      );
    }
    return server;
  };

  const httpServer = http.createServer((req, res) => {
    void (async () => {
      if ((req.headers.authorization ?? "") !== `Bearer ${token}`) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unauthorized" }));
        return;
      }
      if (req.method !== "POST") {
        // Stateless bridge: no standalone SSE stream, no session to delete.
        res.writeHead(405, { allow: "POST" });
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown;
      try {
        body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32700, message: "parse error" },
            id: null,
          }),
        );
        return;
      }
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32603, message: "internal error" },
          id: null,
        }),
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    headers: { Authorization: `Bearer ${token}` },
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        // Don't let lingering keep-alive sockets hold the turn open.
        httpServer.closeAllConnections?.();
      }),
  };
}
