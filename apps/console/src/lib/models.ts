/**
 * Model display helpers. Agents store a raw model id ("claude-opus-4-8",
 * "gpt-5.5-mini"); people read "Opus 4.8" and "GPT-5.5 mini". The raw id
 * stays available in a tooltip (see <ModelBadge>).
 */

export type ModelProvider = "anthropic" | "openai" | "google" | "other";

export interface ModelInfo {
  /** Raw id as stored on the agent. */
  id: string;
  provider: ModelProvider;
  /** Short human label: "Opus 4.8". */
  label: string;
  /** Provider display name: "Anthropic". */
  providerLabel: string;
}

const PROVIDER_LABEL: Record<ModelProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  other: "Custom",
};

/** CSS colour for a provider mark. Matches the usage-chart series. */
export const PROVIDER_COLOR: Record<ModelProvider, string> = {
  anthropic: "var(--chart-anthropic)",
  openai: "var(--chart-openai)",
  google: "var(--chart-5)",
  other: "var(--chart-other)",
};

export function modelId(model: string | { id: string } | null | undefined): string {
  if (!model) return "";
  return typeof model === "string" ? model : model.id ?? "";
}

export function providerOf(id: string): ModelProvider {
  const m = id.toLowerCase();
  if (m.includes("claude") || m.startsWith("anthropic")) return "anthropic";
  if (/^(gpt|o[1-9]|chatgpt|codex|openai)/.test(m) || m.includes("gpt-")) return "openai";
  if (m.includes("gemini") || m.startsWith("google")) return "google";
  return "other";
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function describeModel(model: string | { id: string } | null | undefined): ModelInfo {
  const id = modelId(model);
  const provider = providerOf(id);
  let label = id;
  if (provider === "anthropic") {
    // claude-opus-4-8 → Opus 4.8 ; claude-3-5-sonnet-20241022 → Sonnet 3.5
    const family = /(opus|sonnet|haiku)/i.exec(id)?.[1];
    const nums = id
      .replace(/-\d{8}$/, "")
      .split("-")
      .filter((p) => /^\d+$/.test(p));
    if (family) label = `${cap(family.toLowerCase())}${nums.length ? ` ${nums.join(".")}` : ""}`;
  } else if (provider === "openai") {
    // gpt-5.5-mini → GPT-5.5 mini
    label = id.replace(/^gpt-/i, "GPT-").replace(/-(mini|nano|pro|turbo|codex)\b/gi, " $1");
  } else if (provider === "google") {
    label = id.replace(/^gemini-/i, "Gemini ").replace(/-/g, " ");
  }
  return { id, provider, label: label || "No model", providerLabel: PROVIDER_LABEL[provider] };
}
