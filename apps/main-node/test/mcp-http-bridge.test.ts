// Loopback streamable-HTTP MCP bridge — real JSON-RPC over HTTP, auth guard,
// tool listing and invocation (what the codex child does at turn start).

import { describe, it, expect, afterEach } from "vitest";
import { z } from "zod";
import { startMcpHttpBridge, type McpHttpBridge } from "../src/lib/mcp-http-bridge.js";

let bridge: McpHttpBridge | null = null;
afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

async function rpc(
  b: McpHttpBridge,
  body: Record<string, unknown>,
  headers: Record<string, string> = b.headers,
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const res = await fetch(b.url, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  // Streamable HTTP may answer as SSE — unwrap the first data: frame.
  const raw = text.startsWith("event:") || text.startsWith("data:")
    ? text.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim() ?? ""
    : text;
  let json: Record<string, unknown> | null = null;
  try {
    json = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

describe("startMcpHttpBridge", () => {
  it("rejects requests without the bearer token", async () => {
    bridge = await startMcpHttpBridge("oma_platform", []);
    const { status } = await rpc(bridge, INIT, {});
    expect(status).toBe(401);
  });

  it("initializes, lists, and calls tools whose handlers run in-process", async () => {
    const seen: Array<Record<string, unknown>> = [];
    bridge = await startMcpHttpBridge("oma_platform", [
      {
        name: "echo_upper",
        description: "Uppercase the input",
        inputSchema: { text: z.string() },
        handler: async (args) => {
          seen.push(args);
          return { text: String(args.text).toUpperCase() };
        },
      },
    ]);

    const init = await rpc(bridge, INIT);
    expect(init.status).toBe(200);
    expect((init.json?.result as Record<string, unknown>)?.serverInfo).toMatchObject({
      name: "oma_platform",
    });

    const list = await rpc(bridge, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list.json?.result as { tools?: Array<{ name: string }> })?.tools ?? [];
    expect(tools.map((t) => t.name)).toEqual(["echo_upper"]);

    const call = await rpc(bridge, {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "echo_upper", arguments: { text: "hi there" } },
    });
    const content = (call.json?.result as { content?: Array<{ type: string; text: string }> })?.content;
    expect(content).toEqual([{ type: "text", text: "HI THERE" }]);
    expect(seen).toEqual([{ text: "hi there" }]);
  });

  it("surfaces handler throws as isError tool results, not transport failures", async () => {
    bridge = await startMcpHttpBridge("oma_platform", [
      {
        name: "boom",
        description: "Always fails",
        inputSchema: {},
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    ]);
    const call = await rpc(bridge, {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "boom", arguments: {} },
    });
    const result = call.json?.result as { isError?: boolean; content?: Array<{ text: string }> };
    expect(result?.isError).toBe(true);
    expect(result?.content?.[0]?.text).toContain("kaboom");
  });
});
