import { asSchema } from "ai";
import type { ContentBlock } from "@modelcontextprotocol/sdk/types.js";
import type { HarnessContext } from "@open-managed-agents/agent/harness/interface";
import type { BridgeTool } from "./mcp-http-bridge.js";

/** Keep model execution on the host and every computer operation on the session sandbox. */
export async function codexComputerTools(ctx: HarnessContext): Promise<BridgeTool[]> {
  return Promise.all(Object.entries(ctx.tools ?? {}).filter(([, t]) => typeof t.execute === "function").map(async ([name, t]) => {
    const schema = asSchema(t.inputSchema);
    if (t.needsApproval) throw new Error(`Codex computer tools cannot enforce approval for ${name}; use the default harness.`);
    return {
      name, description: t.description ?? name, inputSchema: {},
      jsonSchema: await schema.jsonSchema as Record<string, unknown>,
      handler: async (input: Record<string, unknown>) => {
        const validated = schema.validate ? await schema.validate(input) : { success: true as const, value: input };
        if (!validated.success) throw new Error(`Invalid arguments for ${name}: ${validated.error}`);
        const toolCallId = crypto.randomUUID();
        const output = await t.execute(validated.value, { toolCallId, messages: [], abortSignal: ctx.runtime.abortSignal });
        const result = t.toModelOutput ? await t.toModelOutput({ toolCallId, input, output }) : null;
        if (result?.type === "content") {
          const content: ContentBlock[] = result.value.map((part: { type: string; text?: string; data?: string; mediaType?: string }) => {
            if (part.type === "image-data") return { type: "image", data: part.data!, mimeType: part.mediaType! };
            if (part.type === "text") return { type: "text", text: part.text ?? "" };
            return { type: "text", text: "Unsupported non-image attachment; use the file tools to read its content." };
          });
          return { content };
        }
        return { text: result?.type === "text" ? result.value : typeof output === "string" ? output : JSON.stringify(output) ?? "(no output)" };
      },
    };
  }));
}

/** No application secrets are inherited by the model subprocess. */
export function computerCodexEnv(base: NodeJS.ProcessEnv, authHome: string): Record<string, string> {
  const out: Record<string, string> = { CODEX_HOME: authHome };
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (base[key]) out[key] = base[key]!;
  }
  return out;
}

export const COMPUTER_CODEX_FEATURES = {
  shell_tool: false, unified_exec: false, view_image: false,
  multi_agent: false, multi_agent_v2: false, plugins: false, hooks: false,
  apps: false, browser_use: false, computer_use: false, in_app_browser: false,
  image_generation: false, memories: false, shell_snapshot: false,
  skill_search: false, skill_mcp_dependency_install: false,
  code_mode: false, code_mode_host: true, tool_suggest: false,
};
