import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool, jsonSchema } from "ai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { codexComputerTools, computerCodexEnv } from "../src/lib/codex-computer-tools.js";
import { startMcpHttpBridge } from "../src/lib/mcp-http-bridge.js";

describe("Codex computer bridge", () => {
  it("calls remote tools with validated inputs and preserves screenshot image blocks", async () => {
    const seen: number[] = [];
    const tools = await codexComputerTools({ runtime: {}, tools: {
      computer_click: tool({ inputSchema: z.object({ x: z.number() }), execute: async ({x}) => { seen.push(x); return "clicked"; } }),
      computer_screenshot: tool({ inputSchema: z.object({}), execute: async () => "image", toModelOutput: () => ({ type: "content", value: [{ type: "image-data", data: "aGVsbG8=", mediaType: "image/png" }] }) }),
      custom_schema: tool({ inputSchema: jsonSchema({ type: "object", properties: { value: {type: "string"} } }), execute: async a => a }),
    } } as never);
    const bridge = await startMcpHttpBridge("test", tools);
    const client = new Client({ name: "test", version: "1" });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(bridge.url), { requestInit: { headers: bridge.headers } }));
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(3);
      expect((await client.callTool({ name: "computer_click", arguments: { x: 12 } })).content).toEqual([{type:"text",text:"clicked"}]);
      expect(seen).toEqual([12]);
      expect((await client.callTool({ name: "computer_click", arguments: { x: "wrong" } })).isError).toBe(true);
      expect(seen).toEqual([12]);
      expect((await client.callTool({ name: "computer_screenshot", arguments: {} })).content).toEqual([{type:"image",data:"aGVsbG8=",mimeType:"image/png"}]);
      const unauth = await fetch(bridge.url, {method:"POST",body:"{}"});
      expect(unauth.status).toBe(401);
    } finally { await client.close(); await bridge.close(); }
  });
  it("never gives the Codex child service credentials", () => {
    const env = computerCodexEnv({ PATH:"/bin", HOME:"/home/node", DAYTONA_API_KEY:"secret", OMA_CODEX_AUTH_JSON:"secret", DATABASE_PATH:"secret", OPENAI_API_KEY:"secret" }, "/data/auth");
    expect(env).toEqual({PATH:"/bin",HOME:"/home/node",CODEX_HOME:"/data/auth"});
  });
  it("rejects tools that need an approval callback", async () => {
    await expect(codexComputerTools({ runtime:{}, tools:{ dangerous: {inputSchema:z.object({}),needsApproval:true, execute:async()=>"no"} } } as never)).rejects.toThrow(/approval/);
  });
});
