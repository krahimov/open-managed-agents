import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";

const app = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>();

interface ProviderModel {
  id: string;
  name: string;
}

const OPENAI_PREFERRED_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano"];
const ANTHROPIC_PREFERRED_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-opus-4-6"];

// POST /v1/models/list — fetch models from official provider API using caller's key
// Body: { provider: "ant" | "oai", api_key: string }
app.post("/list", async (c) => {
  const body = await c.req.json<{ provider?: string; api_key?: string }>();
  const provider = body.provider || "ant";
  const apiKey = body.api_key || "";

  if (!apiKey) return c.json({ error: "api_key is required" }, 400);

  try {
    const models = await fetchModels(provider, apiKey);
    return c.json({ data: models });
  } catch (err) {
    return c.json({ error: `Failed to fetch models: ${(err as Error).message}` }, 502);
  }
});

async function fetchModels(provider: string, apiKey: string): Promise<ProviderModel[]> {
  if (provider === "ant") {
    const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{ id: string; display_name: string }>;
    };
    return sortProviderModels(
      data.data.map((m) => ({ id: m.id, name: m.display_name || m.id })),
      ANTHROPIC_PREFERRED_MODELS,
    );
  }

  if (provider === "oai") {
    const res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}`);
    const data = (await res.json()) as {
      data: Array<{ id: string }>;
    };
    const chatPrefixes = ["gpt-", "o1", "o3", "o4", "chatgpt-"];
    return sortProviderModels(
      data.data
      .filter((m) => chatPrefixes.some((p) => m.id.startsWith(p)))
        .map((m) => ({ id: m.id, name: m.id })),
      OPENAI_PREFERRED_MODELS,
    );
  }

  return [];
}

function sortProviderModels(models: ProviderModel[], preferred: string[]): ProviderModel[] {
  const rank = new Map(preferred.map((id, index) => [id, index]));
  return [...models].sort((a, b) => {
    const ar = rank.get(a.id);
    const br = rank.get(b.id);
    if (ar !== undefined || br !== undefined) {
      return (ar ?? Number.MAX_SAFE_INTEGER) - (br ?? Number.MAX_SAFE_INTEGER);
    }
    return a.id.localeCompare(b.id);
  });
}

export default app;
