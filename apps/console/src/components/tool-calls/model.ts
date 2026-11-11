import type { Event } from "../../lib/events";
import { buildToolCallIndex, isErrorResult, type ToolCallStatus } from "../../lib/tool-status";
import { parseSearchMcpTools, unwrapCallMcpTool } from "../../lib/deferred-mcp";

/**
 * Pure view-model for the tool-call timeline shared by SessionChat and
 * SessionDetail. Turns the raw event log into render items:
 *
 *   event  a message / system card / error the host renders itself
 *   work   a run of consecutive tool calls + thinking blocks (no visible
 *          event between them), rendered as compact rows
 *   fold   "Worked for 2m 8s" header for a finished turn; the turn's work
 *          (and intermediate assistant messages) carry its `foldId` and are
 *          hidden while it is collapsed, the final answer stays visible
 *
 * Pattern adapted from T3 Code's work log (pingdotgg/t3code, MIT): the
 * implementation is ours, the shape (turn fold, grouped summaries, one-line
 * rows, expandable detail) is theirs.
 */

export type ToolKind =
  | "command"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "web_search"
  | "web_fetch"
  | "tool_search"
  | "access"
  | "skill"
  | "schedule"
  | "agent"
  | "mcp"
  | "other";

export interface ToolDescriptor {
  kind: ToolKind;
  /** Leading words, e.g. "Ran", "Read", "Slack · search channels". */
  verb: string;
  /** Command / path / query shown after the verb. */
  target?: string;
  targetMono?: boolean;
  /** MCP server display name ("Slack"). */
  server?: string;
  /** MCP tool display name ("search channels"). */
  tool?: string;
  /** File path for read/write/edit — groups count unique files. */
  path?: string;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  descriptor: ToolDescriptor;
  status: ToolCallStatus;
  output?: string;
  denyMessage?: string;
  durationMs?: number;
}

export type WorkStep =
  | { kind: "tool"; key: string; call: ToolCall }
  | { kind: "thinking"; key: string; text: string }
  | { kind: "orphan"; key: string; output: string; failed: boolean };

export type TimelineItem =
  | { kind: "event"; key: string; event: Event; foldId?: string }
  | { kind: "work"; key: string; steps: WorkStep[]; foldId?: string }
  | { kind: "fold"; key: string; id: string; label: string; failed: boolean };

const USE_TYPES = new Set(["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"]);
const RESULT_TYPES = new Set(["agent.tool_result", "agent.mcp_tool_result"]);
/** Bookkeeping events that never render and must not split a work group. */
const SILENT_TYPES = new Set([
  "user.tool_confirmation",
  "user.custom_tool_result",
  "user.interrupt",
  "system.access_granted",
  "session.status_running",
  "session.status_idle",
  "session.status_rescheduled",
  "session.status_terminated",
]);

export function isToolUse(ev: Event): boolean {
  return USE_TYPES.has(ev.type);
}

function resultUseId(ev: Event): string | undefined {
  if (ev.type === "agent.tool_result") return ev.tool_use_id;
  if (ev.type === "agent.mcp_tool_result") return ev.mcp_tool_use_id;
  return undefined;
}

/** Event time in epoch ms: `processed_at` (ISO, ms precision) first, then
 *  the legacy `ts` (CF: epoch seconds, Node: epoch ms). */
export function eventTimeMs(e: Event): number | null {
  const pa = (e.data as { processed_at?: string } | undefined)?.processed_at
    ?? (e as { processed_at?: string }).processed_at;
  if (typeof pa === "string") {
    const t = Date.parse(pa);
    if (Number.isFinite(t)) return t;
  }
  if (typeof e.ts === "number") return e.ts > 1e12 ? e.ts : e.ts * 1000;
  if (typeof e.ts === "string") {
    const t = Date.parse(e.ts);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** T3-style elapsed label: 850ms · 4.2s · 38s · 2m 8s · 1h 3m. */
export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 10_000) return `${Math.round(ms / 100) / 10}s`;
  const total = Math.round(ms / 1000);
  if (total < 60) return `${total}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------- labels

const SERVER_NAMES: Record<string, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  hubspot: "HubSpot",
  posthog: "PostHog",
  openai: "OpenAI",
  oma: "OMA",
  gmail: "Gmail",
  googledrive: "Google Drive",
  google_drive: "Google Drive",
  clickup: "ClickUp",
};

export function serverDisplayName(raw: string): string {
  const key = raw.toLowerCase();
  if (SERVER_NAMES[key]) return SERVER_NAMES[key];
  return raw
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((w) => SERVER_NAMES[w.toLowerCase()] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** "slack_search_channels" → "search channels" (server prefix dropped). */
export function humanizeToolName(raw: string, server?: string): string {
  let name = raw;
  if (server) {
    const prefix = server.toLowerCase().replace(/[^a-z0-9]/g, "");
    const parts = name.split(/[_\-]/);
    if (parts.length > 1 && parts[0].toLowerCase() === prefix) name = parts.slice(1).join("_");
  }
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-]+/g, " ")
    .trim()
    .toLowerCase();
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

function oneLine(s: string, max = 120): string {
  const line = s.split("\n").find((l) => l.trim())?.trim() ?? "";
  const collapsed = line.replace(/\s+/g, " ");
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** Sandbox paths are rooted at /workspace — show them relative. */
export function displayPath(p: string): string {
  return p.replace(/^\/workspace\/?/, "") || p;
}

const PREFERRED_ARGS = ["query", "q", "command", "url", "path", "file_path", "channel", "name", "title", "text", "message", "prompt", "description", "id"];

function primaryArg(input: Record<string, unknown>): string | undefined {
  for (const k of PREFERRED_ARGS) {
    const v = str(input[k]);
    if (v) return oneLine(v, 80);
  }
  for (const v of Object.values(input)) {
    const s = str(v);
    if (s) return oneLine(s, 80);
  }
  return undefined;
}

/** A call_mcp_tool call as its deferred target (name + arguments), so it
 *  renders like a direct MCP call; any other call unchanged. */
export function unwrapToolCall(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
  const target = unwrapCallMcpTool(name, input);
  return target ? { name: target.name, input: target.arguments } : { name, input };
}

export function describeTool(
  name: string,
  input: Record<string, unknown> = {},
  mcpServerName?: string,
): ToolDescriptor {
  // Deferred-server meta tools (an MCP server's own tool may share the name).
  if (!mcpServerName) {
    const target = unwrapCallMcpTool(name, input);
    if (target) return describeTool(target.name, target.arguments);
    const search = parseSearchMcpTools(name, input);
    if (search) {
      const where = search.server ? serverDisplayName(search.server) : "all";
      return { kind: "tool_search", verb: `Searched ${where} tools for`, target: `"${oneLine(search.query, 80)}"` };
    }
  }
  const mcpMatch = /^mcp__(.+?)__(.+)$/.exec(name);
  const server = mcpServerName ?? mcpMatch?.[1];
  if (server) {
    const toolRaw = mcpMatch && !mcpServerName ? mcpMatch[2] : name.replace(/^mcp__.+?__/, "");
    const serverLabel = serverDisplayName(server);
    const tool = humanizeToolName(toolRaw, server);
    return { kind: "mcp", verb: `${serverLabel} · ${tool}`, target: primaryArg(input), server: serverLabel, tool };
  }

  const n = name.toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  switch (n) {
    case "bash":
    case "shell":
    case "exec":
    case "commandexecution":
      return { kind: "command", verb: "Ran", target: oneLine(str(input.command) ?? str(input.cmd) ?? ""), targetMono: true };
    case "read":
    case "readfile":
      return { kind: "read", verb: "Read", target: path && displayPath(path), targetMono: true, path };
    case "write":
    case "writefile":
      return { kind: "write", verb: "Wrote", target: path && displayPath(path), targetMono: true, path };
    case "edit":
    case "multiedit":
    case "strreplace":
    case "applypatch":
    case "notebookedit":
      return { kind: "edit", verb: "Edited", target: path && displayPath(path), targetMono: true, path };
    case "glob":
    case "ls":
      return { kind: "search", verb: "Listed files", target: str(input.pattern) ?? (path && displayPath(path)), targetMono: true };
    case "grep":
      return { kind: "search", verb: "Searched for", target: str(input.pattern), targetMono: true };
    case "websearch":
      return { kind: "web_search", verb: "Searched the web", target: str(input.query) && oneLine(str(input.query)!) };
    case "webfetch":
      return { kind: "web_fetch", verb: "Fetched", target: str(input.url)?.replace(/^https?:\/\//, "") };
    case "requestaccess":
      return { kind: "access", verb: "Requested access to", target: str(input.service) && serverDisplayName(str(input.service)!) };
    case "findskill":
      return { kind: "skill", verb: "Searched skills", target: str(input.query) };
    case "requestskill":
      return { kind: "skill", verb: "Requested skill", target: str(input.skill_name), targetMono: true };
    case "skill":
      return { kind: "skill", verb: "Used skill", target: str(input.skill) ?? str(input.name), targetMono: true };
    case "task":
    case "agent":
    case "generalsubagent":
      return { kind: "agent", verb: "Delegated", target: primaryArg(input) };
  }
  if (/schedule|ambientrule|wakeup/.test(n)) {
    return { kind: "schedule", verb: capitalize(humanizeToolName(name)), target: primaryArg(input) };
  }
  if (/subagent/.test(n)) return { kind: "agent", verb: capitalize(humanizeToolName(name)), target: primaryArg(input) };
  return { kind: "other", verb: capitalize(humanizeToolName(name)), target: primaryArg(input) };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ---------------------------------------------------------------- output

function prettyIfJson(s: string): string {
  const t = s.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return s;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return s;
  }
}

/** Flatten a tool result's `content` (string | content blocks | object). */
export function resultText(result: Event | undefined): string | undefined {
  if (!result) return undefined;
  const content = (result as { content?: unknown }).content;
  if (content === undefined || content === null) return undefined;
  if (typeof content === "string") return prettyIfJson(content);
  if (Array.isArray(content)) {
    const parts = content.map((b) => {
      const block = b as { type?: string; text?: unknown };
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "image") return "[image]";
      return JSON.stringify(b, null, 2);
    });
    return prettyIfJson(parts.join("\n"));
  }
  return JSON.stringify(content, null, 2);
}

export type DiffLine = { op: " " | "-" | "+"; text: string };

/** Line diff of an edit (LCS on the changed middle, 2 lines of context). */
export function lineDiff(before: string, after: string, context = 2): DiffLine[] {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const out: DiffLine[] = a.slice(Math.max(0, start - context), start).map((text) => ({ op: " ", text }));
  if (midA.length * midB.length <= 250_000) {
    const dp: number[][] = Array.from({ length: midA.length + 1 }, () => new Array(midB.length + 1).fill(0));
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) { out.push({ op: " ", text: midA[i] }); i++; j++; }
      else if (j < midB.length && (i >= midA.length || dp[i][j + 1] >= dp[i + 1][j])) { out.push({ op: "+", text: midB[j] }); j++; }
      else { out.push({ op: "-", text: midA[i] }); i++; }
    }
  } else {
    midA.forEach((text) => out.push({ op: "-", text }));
    midB.forEach((text) => out.push({ op: "+", text }));
  }
  a.slice(endA, Math.min(a.length, endA + context)).forEach((text) => out.push({ op: " ", text }));
  return out;
}

/** Diff the call's input describes, when it describes one. */
export function callDiff(call: Pick<ToolCall, "descriptor" | "input">): DiffLine[] | null {
  const { input } = call;
  if (call.descriptor.kind === "edit") {
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    const lines: DiffLine[] = [];
    for (const e of edits as Array<Record<string, unknown>>) {
      const oldS = str(e.old_string) ?? (typeof e.old_string === "string" ? "" : undefined);
      const newS = typeof e.new_string === "string" ? e.new_string : undefined;
      if (oldS === undefined || newS === undefined) continue;
      if (lines.length) lines.push({ op: " ", text: "⋯" });
      lines.push(...lineDiff(oldS, newS));
    }
    return lines.length ? lines : null;
  }
  if (call.descriptor.kind === "write" && typeof input.content === "string") {
    return input.content.split("\n").map((text) => ({ op: "+", text }));
  }
  return null;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === "+") added++;
    else if (l.op === "-") removed++;
  }
  return { added, removed };
}

export function thinkingPreview(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").replace(/[*_`]/g, "").trim()).find(Boolean);
  return line ? oneLine(line, 160) : "Thought";
}

// ---------------------------------------------------------------- groups

type Action = "change" | "command" | "code-search" | "read" | "web-search" | "fetch" | "tool-search" | "other";
const ACTION_ORDER: Action[] = ["change", "command", "code-search", "read", "web-search", "fetch", "tool-search", "other"];
const ACTION_KIND: Record<Action, ToolKind> = {
  change: "edit",
  command: "command",
  "code-search": "search",
  read: "read",
  "web-search": "web_search",
  fetch: "web_fetch",
  "tool-search": "tool_search",
  other: "other",
};

function actionOf(kind: ToolKind): Action {
  switch (kind) {
    case "write":
    case "edit": return "change";
    case "command": return "command";
    case "search": return "code-search";
    case "read": return "read";
    case "web_search": return "web-search";
    case "web_fetch": return "fetch";
    case "tool_search": return "tool-search";
    default: return "other";
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const times = (n: number) => (n === 1 ? "" : ` ${n} times`);

function actionLabel(action: Action, count: number): string {
  switch (action) {
    case "change": return `Changed ${plural(count, "file", "files")}`;
    case "command": return `Ran ${plural(count, "command", "commands")}`;
    case "code-search": return `Searched code${times(count)}`;
    case "read": return `Read ${plural(count, "file", "files")}`;
    case "web-search": return `Searched the web${times(count)}`;
    case "fetch": return `Fetched ${plural(count, "page", "pages")}`;
    case "tool-search": return `Searched tools${times(count)}`;
    case "other": return `Used ${plural(count, "tool", "tools")}`;
  }
}

function joinNames(names: string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Read 3 files, ran 2 commands" — at most three actions + a remainder,
 *  MCP servers named first ("Used Slack and Linear"). */
export function summarizeSteps(steps: WorkStep[]): {
  label: string;
  kind: ToolKind;
  failed: number;
  denied: number;
  running: boolean;
} {
  const calls = steps.flatMap((s) => (s.kind === "tool" ? [s.call] : []));
  const orphanFailures = steps.filter((s) => s.kind === "orphan" && s.failed).length;
  const failed = calls.filter((c) => c.status === "failed").length + orphanFailures;
  const denied = calls.filter((c) => c.status === "denied").length;
  const running = calls.some((c) => c.status === "running" || c.status === "responded");
  if (calls.length === 0) {
    const thoughts = steps.filter((s) => s.kind === "thinking").length;
    return { label: thoughts > 1 ? `Thought ${thoughts} times` : "Thought", kind: "other", failed, denied, running };
  }
  const servers = [...new Set(calls.flatMap((c) => (c.descriptor.kind === "mcp" && c.descriptor.server ? [c.descriptor.server] : [])))];
  const buckets = new Map<Action, ToolCall[]>();
  for (const c of calls) {
    if (c.descriptor.kind === "mcp") continue;
    const a = actionOf(c.descriptor.kind);
    buckets.set(a, [...(buckets.get(a) ?? []), c]);
  }
  const count = (a: Action, cs: ToolCall[]) =>
    a === "change" || a === "read"
      ? new Set(cs.map((c) => c.descriptor.path ?? c.id)).size
      : cs.length;
  const selected = ACTION_ORDER.filter((a) => buckets.has(a)).slice(0, servers.length ? 2 : 3);
  const labels: string[] = [];
  if (servers.length) labels.push(`Used ${joinNames(servers)}`);
  for (const a of selected) labels.push(actionLabel(a, count(a, buckets.get(a)!)));
  const covered = calls.filter((c) => c.descriptor.kind === "mcp").length
    + selected.reduce((n, a) => n + buckets.get(a)!.length, 0);
  const rest = calls.length - covered;
  if (rest > 0) labels.push(`${plural(rest, "other action", "other actions")}`);
  const label = labels
    .map((l, i) => (i === 0 ? l : l.charAt(0).toLowerCase() + l.slice(1)))
    .join(", ");
  const kind: ToolKind = servers.length ? "mcp" : ACTION_KIND[selected[0] ?? "other"];
  return { label, kind, failed, denied, running };
}

// ---------------------------------------------------------------- timeline

export interface BuildOptions {
  /** Host-specific events that never render (e.g. setup harness markers).
   *  Treated like bookkeeping: dropped, and they don't split work groups. */
  isSilent?: (ev: Event) => boolean;
  /** Tool calls to drop entirely, with their results. */
  hideTool?: (use: Event) => boolean;
}

export interface Timeline {
  items: TimelineItem[];
  /** Start of the turn still in progress (no closing idle yet), for the
   *  live "Working for …" row. */
  openTurnStartMs: number | null;
}

interface Turn {
  id: string;
  startMs: number | null;
  endMs: number | null;
  closed: boolean;
  interrupted: boolean;
  itemIdx: number[];
}

export function eventKey(ev: Event, i: number): string {
  return ev.id ?? (ev.seq != null ? `seq:${ev.seq}` : `idx-${ev.type}-${i}`);
}

export function buildTimeline(events: Event[], opts: BuildOptions = {}): Timeline {
  const index = buildToolCallIndex(events);
  const hiddenUseIds = new Set<string>();
  const useIds = new Set<string>();
  const useTimes = new Map<string, number>();
  for (const ev of events) {
    if (!isToolUse(ev) || typeof ev.id !== "string") continue;
    useIds.add(ev.id);
    const t = eventTimeMs(ev);
    if (t !== null) useTimes.set(ev.id, t);
    if (opts.hideTool?.(ev)) hiddenUseIds.add(ev.id);
  }

  const items: TimelineItem[] = [];
  const turns: Turn[] = [];
  let turn: Turn | null = null;
  const newTurn = (id: string, startMs: number | null): Turn => {
    const t: Turn = { id, startMs, endMs: null, closed: false, interrupted: false, itemIdx: [] };
    turns.push(t);
    return t;
  };
  const pushStep = (step: WorkStep) => {
    const last = items[items.length - 1];
    if (last?.kind === "work" && turn && turn.itemIdx[turn.itemIdx.length - 1] === items.length - 1) {
      last.steps.push(step);
      return;
    }
    items.push({ kind: "work", key: `work:${step.key}`, steps: [step] });
    turn?.itemIdx.push(items.length - 1);
  };

  events.forEach((ev, i) => {
    const key = eventKey(ev, i);
    const t = eventTimeMs(ev);
    const bookkeeping = SILENT_TYPES.has(ev.type) || ev.type.startsWith("span.") || opts.isSilent?.(ev) === true;
    if (ev.type === "user.message") turn = newTurn(key, t);
    else if (!turn || turn.closed) {
      // Trailing status/span events after a turn closed don't open a new one.
      if (bookkeeping) return;
      turn = newTurn(key, t);
    }
    const cur = turn!;

    if (ev.type === "session.status_idle") {
      const stop = (ev.stop_reason as { type?: string } | undefined)?.type;
      if (stop !== "requires_action") { cur.closed = true; cur.endMs = t; }
      return;
    }
    if (ev.type === "session.status_terminated") { cur.closed = true; cur.endMs = t; return; }
    if (ev.type === "user.interrupt") { cur.interrupted = true; return; }
    if (bookkeeping) return;

    if (isToolUse(ev)) {
      const id = typeof ev.id === "string" ? ev.id : key;
      if (hiddenUseIds.has(id)) return;
      const info = index.info(typeof ev.id === "string" ? ev.id : undefined);
      // call_mcp_tool presents as its deferred target. An agent.mcp_tool_use
      // name is the server's own tool name, never a meta tool.
      const raw = (ev.input ?? {}) as Record<string, unknown>;
      const { name, input } = ev.type === "agent.mcp_tool_use"
        ? { name: ev.name ?? "tool", input: raw }
        : unwrapToolCall(ev.name ?? "tool", raw);
      const resultMs = info.result ? eventTimeMs(info.result) : null;
      const durationMs = resultMs !== null && t !== null && resultMs >= t ? resultMs - t : undefined;
      pushStep({
        kind: "tool",
        key,
        call: {
          id,
          name,
          input,
          descriptor: describeTool(name, input, ev.type === "agent.mcp_tool_use" ? ev.mcp_server_name : undefined),
          status: info.status,
          output: info.denyMessage ?? resultText(info.result),
          ...(info.denyMessage ? { denyMessage: info.denyMessage } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
        },
      });
      return;
    }
    if (RESULT_TYPES.has(ev.type)) {
      const uid = resultUseId(ev);
      if (uid && useIds.has(uid)) return; // folded into its call row
      pushStep({ kind: "orphan", key, output: resultText(ev) ?? "", failed: isErrorResult(ev) });
      return;
    }
    if (ev.type === "agent.thinking") {
      const text = String((ev as { text?: unknown }).text ?? "");
      if (text.trim()) pushStep({ kind: "thinking", key, text });
      return;
    }

    items.push({ kind: "event", key, event: ev });
    cur.itemIdx.push(items.length - 1);
    if (ev.type === "session.error") { cur.closed = true; cur.endMs = t; }
  });

  // Fold finished turns. Inserting headers shifts indices, so collect first.
  const folds: Array<{ before: number; item: TimelineItem }> = [];
  for (const tr of turns) {
    if (!tr.closed) continue;
    const idx = tr.itemIdx;
    let terminal = -1;
    for (const i of idx) {
      const it = items[i];
      if (it.kind === "event" && it.event.type === "agent.message") terminal = i;
    }
    const hidden: number[] = [];
    let failed = false;
    for (const i of idx) {
      const it = items[i];
      if (it.kind === "work") {
        const s = summarizeSteps(it.steps);
        const parked = it.steps.some((st) => st.kind === "tool" && (st.call.status === "awaiting_approval" || st.call.status === "awaiting_client"));
        // Failed or denied work after the final answer stays in view.
        if (parked || (i > terminal && s.failed + s.denied > 0)) continue;
        if (s.failed + s.denied > 0) failed = true;
        hidden.push(i);
      } else if (it.kind === "event" && it.event.type === "agent.message" && i !== terminal && i < terminal) {
        hidden.push(i);
      }
    }
    if (!hidden.some((i) => items[i].kind === "work")) continue;
    for (const i of hidden) (items[i] as { foldId?: string }).foldId = tr.id;
    const elapsed = tr.startMs !== null && tr.endMs !== null && tr.endMs >= tr.startMs
      ? formatElapsed(tr.endMs - tr.startMs)
      : null;
    const label = tr.interrupted
      ? elapsed ? `Stopped after ${elapsed}` : "Stopped"
      : elapsed ? `Worked for ${elapsed}` : "Worked";
    folds.push({ before: hidden[0], item: { kind: "fold", key: `fold:${tr.id}`, id: tr.id, label, failed } });
  }
  for (const f of folds.sort((a, b) => b.before - a.before)) items.splice(f.before, 0, f.item);

  const open = [...turns].reverse().find((tr) => !tr.closed);
  const last = turns[turns.length - 1];
  return { items, openTurnStartMs: open && open === last ? open.startMs : null };
}
