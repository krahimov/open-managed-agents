// In-process MCP servers behind the `mcpBinding.fetch` seam buildTools()
// uses, so tests drive the real @ai-sdk/mcp client (initialize,
// tools/list, tools/call, DELETE on close) without a network.

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** MCP ToolAnnotations (readOnlyHint …), listed as the server sends them. */
  annotations?: Record<string, unknown>;
}

export interface FakeMcpServer {
  tools: FakeMcpTool[];
  /** tools/call handler → CallToolResult. */
  call?: (name: string, args: Record<string, unknown>) => unknown;
}

export interface FakeMcpBinding {
  fetch: (req: Request) => Promise<Response>;
  /** tools/call requests seen, per server. */
  calls: Array<{ server: string; name: string; args: Record<string, unknown> }>;
  /** DELETE requests (client.close()) seen, per server. */
  closed: string[];
}

export function fakeMcpBinding(servers: Record<string, FakeMcpServer>): FakeMcpBinding {
  const calls: FakeMcpBinding["calls"] = [];
  const closed: string[] = [];
  const fetch = async (req: Request): Promise<Response> => {
    const server = req.headers.get("x-oma-mcp-server") ?? "";
    const spec = servers[server];
    if (!spec) return new Response("unknown server", { status: 404 });
    // No server-initiated stream.
    if (req.method === "GET") return new Response(null, { status: 405 });
    if (req.method === "DELETE") {
      closed.push(server);
      return new Response(null, { status: 200 });
    }
    const msg = (await req.json()) as { id?: number; method: string; params?: Record<string, unknown> };
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown) =>
      Response.json({ jsonrpc: "2.0", id: msg.id, result }, { headers: { "mcp-session-id": `fake-${server}` } });
    switch (msg.method) {
      case "initialize":
        return reply({
          protocolVersion: msg.params?.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: server, version: "1.0.0" },
        });
      case "tools/list":
        return reply({
          tools: spec.tools.map((t) => ({
            name: t.name,
            description: t.description ?? "",
            inputSchema: t.inputSchema ?? { type: "object", properties: {} },
            ...(t.annotations ? { annotations: t.annotations } : {}),
          })),
        });
      case "tools/call": {
        const name = String(msg.params?.name);
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        calls.push({ server, name, args });
        return reply(spec.call?.(name, args) ?? { content: [{ type: "text", text: `${name} ok` }] });
      }
      default:
        return Response.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not found" } });
    }
  };
  return { fetch, calls, closed };
}

/** A synthetic MCP tool whose definition is roughly `tokens` tokens (chars/4). */
export function syntheticMcpTool(name: string, tokens: number): FakeMcpTool {
  const properties: Record<string, unknown> = {};
  // ~6 properties with long descriptions, like Notion's page/database schemas.
  const perProp = Math.max(1, Math.floor((tokens * 4) / 6) - 60);
  for (let i = 0; i < 6; i++) {
    properties[`field_${i}`] = {
      type: "string",
      description: `Field ${i} of ${name}. ` + "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(Math.ceil(perProp / 57)).slice(0, perProp),
    };
  }
  return {
    name,
    description: `${name.replace(/_/g, " ")} — synthetic tool for size tests.`,
    inputSchema: { type: "object", properties, required: ["field_0"] },
  };
}
