/**
 * Composio's tool router reaches every app through a handful of meta tools
 * on one MCP server:
 *
 *   COMPOSIO_MULTI_EXECUTE_TOOL { tools: [{ tool_slug: "HUBSPOT_SEARCH_DEALS", arguments }] }
 *   COMPOSIO_SEARCH_TOOLS       { queries: [{ use_case: "find deals closing soon" }] }
 *   COMPOSIO_MANAGE_CONNECTIONS { toolkits: ["hubspot"] }
 *   COMPOSIO_REMOTE_WORKBENCH / COMPOSIO_REMOTE_BASH_TOOL / COMPOSIO_GET_TOOL_SCHEMAS
 *
 * Shown as sent, every row reads "Composio · COMPOSIO_MULTI_EXECUTE_TOOL"
 * and nobody can tell HubSpot from Slack. The console reads the call here
 * so the row names the app and the action it ran. The call's input is never
 * changed: an open card and an approval still show exactly what was sent.
 */

export interface ComposioAction {
  /** "HUBSPOT_SEARCH_DEALS". */
  slug: string;
  /** Composio toolkit slug, lower-cased: "hubspot". Composio toolkit slugs are bare alphanumerics. */
  toolkit: string;
  /** "Search deals": the rest of the slug in words, without the app's name repeated. */
  action: string;
  arguments: Record<string, unknown>;
}

export type ComposioCall =
  | { kind: "execute"; actions: ComposioAction[] }
  | { kind: "search"; queries: string[]; toolkits: string[] }
  | { kind: "connections"; toolkits: string[] }
  | { kind: "workbench" }
  | { kind: "schemas"; actions: ComposioAction[] };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Arguments that arrived as a JSON string are decoded; anything else unusable becomes {}. */
function argsOf(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return {};
}

/** A list that may arrive as an array, a JSON string of one, or a single item. */
function listOf(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // not JSON
    }
  }
  return raw === undefined || raw === null ? [] : [raw];
}

/** The meta tool's own name: "mcp__composio__COMPOSIO_SEARCH_TOOLS" → "COMPOSIO_SEARCH_TOOLS". */
function metaName(name: string): string {
  const m = /^mcp__.+?__(.+)$/.exec(name);
  return (m ? m[1] : name).toUpperCase();
}

const ACRONYMS = new Set(["CRM", "URL", "ID", "API", "PR", "CSV", "PDF", "SQL", "DM", "UTM", "SMS", "HTML", "JSON"]);

/** "LIST_LINEAR_ISSUES" (toolkit "linear") → "List issues". */
export function actionWords(rest: string, toolkit: string): string {
  const words = rest
    .split(/_+/)
    .filter(Boolean)
    .filter((w) => w.toLowerCase() !== toolkit);
  if (!words.length) return rest.replace(/_+/g, " ").toLowerCase() || "Run";
  const out = words.map((w, i) => {
    const up = w.toUpperCase();
    if (ACRONYMS.has(up)) return up;
    if (up.endsWith("S") && ACRONYMS.has(up.slice(0, -1))) return `${up.slice(0, -1)}s`;
    const lower = w.toLowerCase();
    return i === 0 ? lower[0].toUpperCase() + lower.slice(1) : lower;
  });
  return out.join(" ");
}

/** "HUBSPOT_SEARCH_DEALS" → the HubSpot action it names. Null when it isn't a slug. */
export function parseToolSlug(slug: unknown, args?: unknown): ComposioAction | null {
  if (typeof slug !== "string") return null;
  const s = slug.trim().toUpperCase();
  const idx = s.indexOf("_");
  if (idx <= 0 || idx === s.length - 1 || !/^[A-Z0-9]+$/.test(s.slice(0, idx))) return null;
  const toolkit = s.slice(0, idx).toLowerCase();
  return { slug: s, toolkit, action: actionWords(s.slice(idx + 1), toolkit), arguments: argsOf(args) };
}

function toolkitsOf(raw: unknown): string[] {
  const out: string[] = [];
  for (const t of listOf(raw)) {
    const v = typeof t === "string" ? t : isRecord(t) && typeof t.toolkit === "string" ? t.toolkit : isRecord(t) && typeof t.name === "string" ? t.name : null;
    const k = v?.trim().toLowerCase();
    if (k && !out.includes(k)) out.push(k);
  }
  return out;
}

/**
 * What a Composio meta-tool call did, read from its name and input.
 * Null for any other tool, and for an execute call whose input names no
 * action (it stays the plain call it was).
 */
export function readComposioCall(name: unknown, input: unknown): ComposioCall | null {
  if (typeof name !== "string") return null;
  const meta = metaName(name);
  if (!meta.startsWith("COMPOSIO_")) return null;
  const inp = isRecord(input) ? input : {};

  if (meta === "COMPOSIO_MULTI_EXECUTE_TOOL" || meta === "COMPOSIO_EXECUTE_TOOL") {
    const entries = meta === "COMPOSIO_EXECUTE_TOOL" ? [inp] : listOf(inp.tools);
    const records = entries.filter(isRecord);
    const actions = records
      .map((t) => parseToolSlug(t.tool_slug ?? t.slug ?? t.action, t.arguments ?? t.params ?? t.input))
      .filter((a): a is ComposioAction => a !== null);
    // Every entry must be read, or the row (and an approval headline) would
    // name less than the batch does: such a call stays the plain call it was.
    return actions.length && actions.length === entries.length ? { kind: "execute", actions } : null;
  }
  if (meta === "COMPOSIO_SEARCH_TOOLS") {
    const queries: string[] = [];
    const toolkits: string[] = [];
    for (const q of listOf(inp.queries ?? inp.query ?? inp.use_case)) {
      const text = typeof q === "string" ? q : isRecord(q) && typeof q.use_case === "string" ? q.use_case : null;
      if (text?.trim()) queries.push(text.trim());
      if (isRecord(q)) for (const k of toolkitsOf(q.toolkits ?? q.toolkit)) if (!toolkits.includes(k)) toolkits.push(k);
    }
    for (const k of toolkitsOf(inp.toolkits)) if (!toolkits.includes(k)) toolkits.push(k);
    // Nothing to say yet (a call still streaming in): leave it as it is.
    return queries.length || toolkits.length ? { kind: "search", queries, toolkits } : null;
  }
  if (meta === "COMPOSIO_MANAGE_CONNECTIONS" || meta === "COMPOSIO_INITIATE_CONNECTION") {
    return { kind: "connections", toolkits: toolkitsOf(inp.toolkits ?? inp.toolkit) };
  }
  if (meta === "COMPOSIO_REMOTE_WORKBENCH" || meta === "COMPOSIO_REMOTE_BASH_TOOL") return { kind: "workbench" };
  if (meta === "COMPOSIO_GET_TOOL_SCHEMAS") {
    const actions = listOf(inp.tool_slugs ?? inp.tools)
      .map((t) => parseToolSlug(typeof t === "string" ? t : isRecord(t) ? t.tool_slug : null))
      .filter((a): a is ComposioAction => a !== null);
    return { kind: "schemas", actions };
  }
  return null;
}
