import { OMA_SETUP_HARNESS } from "@open-managed-agents/api-types";

import { attachmentsOf, type MessageAttachment } from "@/lib/attachments";
import { unwrapCallMcpTool } from "@/lib/deferred-mcp";
import type { Event } from "@/lib/events";
import type { OpenRequest } from "@/lib/session-state";
import { isErrorResult } from "@/lib/tool-status";

import { readGrant, readRequests, requestKey, type Grant } from "./requests";

/**
 * The conversation model.
 *
 * A session's wire events are a flat, low-level log (spans, tool calls,
 * results, status flips). The conversation is not: a person reads TURNS.
 * `buildConversation` folds the log into the shape the chat renders:
 *
 *   user        what a person sent (a right-aligned bubble)
 *   wakeup      the agent woke itself on a schedule (a system row, not a bubble)
 *   agent       one agent turn: prose, thinking, tool runs, approvals, errors,
 *               in the order they happened, under one header
 *   note        a centred caption between turns (stopped, ended)
 *
 * It is pure and synchronous so it can run on every stream tick and be
 * unit-tested without a DOM.
 */

// ── time ────────────────────────────────────────────────────────────────

/**
 * Milliseconds since epoch for an event, or null when it carries no usable
 * time. Stored events have `processed_at` (ISO); the Node runtime adds a
 * numeric `ts` in milliseconds, Cloudflare in seconds; events tagged on
 * arrival by the client have an ISO `ts`.
 */
export function eventTime(e: Event | undefined | null): number | null {
  if (!e) return null;
  const data = (e.data ?? undefined) as { processed_at?: unknown } | undefined;
  const pa = (e as { processed_at?: unknown }).processed_at ?? data?.processed_at;
  if (typeof pa === "string") {
    const t = Date.parse(pa);
    if (Number.isFinite(t)) return t;
  }
  const pam = (e as { processed_at_ms?: unknown }).processed_at_ms;
  if (typeof pam === "number" && pam > 0) return pam;
  const ts = e.ts as unknown;
  if (typeof ts === "number" && ts > 0) return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

/** "840ms" · "2.3s" · "38s" · "1m 12s" · "2h 4m": a duration people read at a glance. */
export function formatElapsed(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

// ── shapes ──────────────────────────────────────────────────────────────

export type ToolFlavor = "tool" | "mcp" | "custom";

export interface ToolCall {
  key: string;
  /** The call id that results and confirmations reference. */
  id?: string;
  flavor: ToolFlavor;
  name: string;
  /** MCP server name as the agent config spells it ("linear"). */
  server?: string;
  input: Record<string, unknown>;
  use: Event;
  result?: Event;
  /** Result content as text (JSON is pretty-printed). */
  output?: string;
  isError: boolean;
  /**
   * `undefined`: no result and nothing is running (an interrupted call).
   * `waiting`: a custom tool the session is parked on. The app that runs
   * the session executes it and posts its result; nobody here can.
   */
  status?: "running" | "completed" | "errored" | "denied" | "waiting";
  startedAt: number | null;
  durationMs: number | null;
  /** Set when the call needed a person: still waiting, or how it was decided. */
  approval?: "pending" | "allowed" | "denied";
  denyMessage?: string;
  /** Set when the call is one agent asking another for help (`call_agent_<id>`). */
  handoff?: Handoff;
}

/**
 * A hand-off: the runtime names the tool after the agent's id
 * (`call_agent_agent_rrtcdqruug4a13d0`), which nobody should have to read.
 * The thread the call started says who was asked, by name.
 */
export interface Handoff {
  /** The id as the tool name spells it (non-alphanumerics become `_`). */
  agentKey: string;
  agentId?: string;
  agentName?: string;
  /** The sub-agent's thread, when the runtime reported one. */
  threadId?: string;
}

const HANDOFF_TOOL = /^call_agent_(.+)$/;

/** The agent a `call_agent_*` tool name points at, as the name spells it. */
export function handoffKey(toolName: string): string | null {
  return HANDOFF_TOOL.exec(toolName)?.[1] ?? null;
}

/** How the runtime spells an agent id inside a tool name. */
export const handoffKeyOf = (agentId: string): string => agentId.replace(/[^a-zA-Z0-9_]/g, "_");

export type Block =
  | { kind: "text"; key: string; text: string; event: Event }
  | { kind: "thinking"; key: string; text: string; durationMs: number | null }
  | { kind: "tools"; key: string; calls: ToolCall[] }
  | { kind: "approval"; key: string; call: ToolCall }
  | {
      kind: "error";
      key: string;
      event: Event;
      code: string;
      message?: string;
      cause?: string;
      model?: string;
      workItemId?: string;
      at: number | null;
    }
  | { kind: "warning"; key: string; source?: string; message: string }
  | {
      kind: "card";
      key: string;
      card: "access_request" | "ambient_rule" | "mission_verdict" | "skill_request" | "memory_enabled" | "saved_login";
      event: Event;
      /**
       * For the two request cards: whether anyone has answered, read from
       * the log (see requests.ts). `open` is waiting on a person.
       */
      request?: "open" | "answered" | "passed";
      /**
       * Access request and saved login: the log holds a
       * `system.access_granted` for this request_id, so the server recorded
       * the grant (a reload keeps it connected, and the card must not nudge
       * the agent a second time). For a saved login it means the person
       * switched account.
       */
      granted?: boolean;
    }
  | {
      kind: "note";
      key: string;
      note: "wake_scheduled" | "compacted" | "thread_started" | "rescheduled";
      event: Event;
      at: number | null;
    };

export type Item =
  | {
      kind: "user";
      key: string;
      event: Event;
      text: string;
      /** file ids of attached images */
      images: string[];
      /** Files sent with the message (`metadata.attachments`), images included. */
      attachments: MessageAttachment[];
      at: number | null;
      cancelled: boolean;
      queued: boolean;
    }
  | { kind: "wakeup"; key: string; event: Event; text: string; scheduledAt?: string; at: number | null }
  /** The brief a "run until done" mission writes to open one of its iterations. */
  | { kind: "brief"; key: string; event: Event; text: string; iteration?: number; failing: string[]; at: number | null }
  | {
      kind: "agent";
      key: string;
      blocks: Block[];
      at: number | null;
      /** Wall-clock from the trigger to the turn's last event; null while unknown. */
      durationMs: number | null;
      /** All prose of the turn, for "copy". */
      text: string;
    }
  /**
   * The server's note to the agent that a request was answered ("[access
   * granted] hubspot …", "[skill attached] …" with the whole playbook). The
   * server wrote it, so it is a line in the conversation, never a bubble
   * from "you".
   */
  | { kind: "answered"; key: string; event: Event; grant: Grant; text: string; at: number | null }
  | { kind: "note"; key: string; note: "stopped" | "ended"; at: number | null };

export interface Conversation {
  items: Item[];
  /** Tool calls waiting on a person right now. */
  pendingApprovals: ToolCall[];
  /** Access and skill requests nobody has answered, oldest first. */
  openRequests: OpenRequest[];
  /** The last turn ended in an error and nothing has happened since. */
  failed: boolean;
  /**
   * While `failed`, what its error card leads with, raw: the model's own
   * error when the log has one, else the runtime's message. Read it with
   * `readFailure` so the header says what the card and every list say.
   */
  failure: string | null;
}

// ── helpers ─────────────────────────────────────────────────────────────

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function eventText(e: Event): string {
  if (typeof e.content === "string") return e.content;
  if (!Array.isArray(e.content)) return "";
  return e.content
    .filter((b) => !b.type || b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
}

/**
 * What a person typed. A message sent with files carries a second text
 * block for the agent only (where in the sandbox each file was saved), so
 * only the first block is theirs.
 */
function personText(e: Event, attachments: MessageAttachment[]): string {
  if (attachments.length === 0 || !Array.isArray(e.content)) return eventText(e);
  const first = e.content.find((b) => (!b.type || b.type === "text") && typeof b.text === "string");
  return first?.text ?? "";
}

function eventImages(e: Event): string[] {
  if (!Array.isArray(e.content)) return [];
  const ids: string[] = [];
  for (const b of e.content as Array<{ type?: string; source?: { type?: string; file_id?: string } }>) {
    if (b.type === "image" && b.source?.file_id) ids.push(b.source.file_id);
  }
  return ids;
}

export function isWakeup(e: Event): boolean {
  const md = e.metadata as { harness?: string; kind?: string } | undefined;
  return e.type === "user.message" && md?.harness === "schedule" && md?.kind === "wakeup";
}

/**
 * The opening message of a mission iteration. The supervisor writes it, not
 * a person: the goal, the workspace, the checks that must pass and what the
 * last attempt failed. It is drawn as a note from the run, never as a
 * bubble from "you".
 */
export function isMissionBrief(e: Event): boolean {
  const md = e.metadata as { kind?: string } | undefined;
  return e.type === "user.message" && md?.kind === "mission_iteration";
}

/** The check commands a brief lists under "Previous attempt failed these checks:". */
export function briefFailures(text: string): string[] {
  const at = text.indexOf("Previous attempt failed these checks:");
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of text.slice(at).split("\n").slice(1)) {
    // Commands are indented two spaces and bulleted; their output is indented further.
    const m = /^ {2}- (.+)$/.exec(line);
    if (m) out.push(m[1].trim());
  }
  return out;
}

export function resultText(result: Event | undefined): string | undefined {
  if (!result) return undefined;
  const raw = (result as { content?: unknown }).content;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    // Content-block arrays: join the text blocks; anything else is shown as JSON.
    const blocks = raw as Array<{ type?: string; text?: string }>;
    if (blocks.every((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string")) {
      return blocks.map((b) => b.text).join("\n");
    }
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

const stableKey = (e: Event, i: number): string =>
  str(e.id) ?? (typeof e.seq === "number" ? `seq-${e.seq}` : `idx-${e.type}-${i}`);

const TOOL_USE = new Set(["agent.tool_use", "agent.custom_tool_use", "agent.mcp_tool_use"]);

/**
 * What a tool-use event calls, as a person should read it. A deferred MCP
 * server (apps/agent tool-budget) is reached through the `call_mcp_tool`
 * meta tool: `{ name: "mcp__linear__create_issue", arguments: "{…}" }`.
 * That call is shown as the Linear call it is, with the arguments it
 * carries, decoded. A malformed one stays the plain tool call it was.
 */
export function readToolUse(e: Event): Pick<ToolCall, "flavor" | "name" | "server" | "input"> {
  const deferred = e.type === "agent.tool_use" ? unwrapCallMcpTool(e.name, e.input) : null;
  if (deferred) return { flavor: "mcp", name: deferred.tool, server: deferred.server, input: deferred.arguments };
  return {
    flavor: e.type === "agent.mcp_tool_use" ? "mcp" : e.type === "agent.custom_tool_use" ? "custom" : "tool",
    name: str(e.name) ?? "tool",
    server: e.type === "agent.mcp_tool_use" ? str(e.mcp_server_name) : undefined,
    input: (e.input && typeof e.input === "object" ? e.input : {}) as Record<string, unknown>,
  };
}

/**
 * Tool calls the session is parked on, by id, from its last status: an
 * idle with `requires_action`. A built-in or MCP call waits on a person's
 * decision (`confirmation`); a custom tool waits on the app that runs the
 * session to post its result (`client`). A status after that idle (the
 * session ran again, ended) means nothing is owed any more.
 */
function owedCalls(events: Event[]): Map<string, "confirmation" | "client"> {
  const owed = new Map<string, "confirmation" | "client">();
  const uses = new Map<string, Event>();
  let last: Event | undefined;
  for (const e of events) {
    if (TOOL_USE.has(e.type) && typeof e.id === "string") uses.set(e.id, e);
    else if (
      e.type === "session.status_idle" ||
      e.type === "session.status_running" ||
      e.type === "session.status_rescheduled" ||
      e.type === "session.status_terminated"
    ) {
      last = e;
    }
  }
  if (last?.type !== "session.status_idle") return owed;
  const stop = last.stop_reason as { type?: string; action_type?: string; event_ids?: unknown } | undefined;
  const parked =
    stop?.type === "requires_action" || stop?.action_type === "tool_confirmation" || stop?.action_type === "custom_tool_result";
  if (!parked) return owed;
  let ids = Array.isArray(stop?.event_ids) ? stop.event_ids.filter((x): x is string => typeof x === "string") : [];
  // Some runtimes leave event_ids out: the calls that wait by their nature.
  if (ids.length === 0) {
    ids = [...uses.values()]
      .filter((u) => u.type === "agent.custom_tool_use" || (u as { evaluated_permission?: string }).evaluated_permission === "ask")
      .map((u) => u.id as string);
  }
  for (const id of ids) {
    const use = uses.get(id);
    const client = use ? use.type === "agent.custom_tool_use" : stop?.action_type === "custom_tool_result";
    owed.set(id, client ? "client" : "confirmation");
  }
  return owed;
}

// ── the fold ────────────────────────────────────────────────────────────

/**
 * Fold one thread's events (already in server order) into conversation
 * items. `running` is the session's live status: a call with no result is
 * "running" only while the session is, and only in the last turn.
 */
export function buildConversation(events: Event[], opts: { running?: boolean } = {}): Conversation {
  // Pass 1: indexes that need look-ahead.
  const results = new Map<string, Event>();
  const confirmations = new Map<string, { result: "allow" | "deny"; message?: string }>();
  /** Custom tool calls the app has answered (`user.custom_tool_result`). */
  const clientAnswered = new Set<string>();
  let lastIdle: Event | undefined;
  let lastTriggerIdx = -1;
  events.forEach((e, i) => {
    if (e.type === "agent.tool_result" && e.tool_use_id) results.set(e.tool_use_id, e);
    else if (e.type === "agent.mcp_tool_result" && e.mcp_tool_use_id) results.set(e.mcp_tool_use_id, e);
    else if (e.type === "user.tool_confirmation" && e.tool_use_id) {
      confirmations.set(e.tool_use_id, {
        result: (e as { result?: string }).result === "deny" ? "deny" : "allow",
        message: str((e as { deny_message?: unknown }).deny_message),
      });
    } else if (e.type === "user.custom_tool_result") {
      const cid = str((e as { custom_tool_use_id?: unknown }).custom_tool_use_id);
      if (cid) clientAnswered.add(cid);
    } else if (e.type === "session.status_idle") lastIdle = e;
    if (e.type === "user.message" || e.type === "user.tool_confirmation" || e.type === "user.custom_tool_result") lastTriggerIdx = i;
  });
  const owed = owedCalls(events);
  // Anything after the idle that asked for confirmation means the session moved on.
  const idleIdx = lastIdle ? events.lastIndexOf(lastIdle) : -1;
  const movedOn = events.slice(idleIdx + 1).some((e) => e.type === "session.status_running" || e.type === "user.message");

  const requests = readRequests(events);
  /** Requests the server recorded as granted (`system.access_granted`). */
  const granted = grantedRequestIds(events);
  const requestId = (e: Event): string => str((e as { request_id?: unknown }).request_id) ?? "";

  const items: Item[] = [];
  const pendingApprovals: ToolCall[] = [];
  const pairedResults = new Set<string>();
  /** Sub-agent threads already shown as part of the hand-off that started them. */
  const claimedThreads = new Set<number>();
  /** Up to where to look for what a call set off: its result, or a few events on. */
  const reach = (i: number, result: Event | undefined) => {
    const end = result ? events.indexOf(result) : -1;
    return end > i ? end + 1 : Math.min(events.length, i + 6);
  };

  let turn: Extract<Item, { kind: "agent" }> | null = null;
  let triggerAt: number | null = null;
  let lastAt: number | null = null;
  let modelStartAt: number | null = null;
  let firstTokenAt: number | null = null;
  let pendingModelError: { error: string; model?: string } | null = null;
  let failed = false;
  let failure: string | null = null;

  const closeTurn = () => {
    if (!turn) return;
    if (triggerAt != null && lastAt != null && lastAt >= triggerAt) turn.durationMs = lastAt - triggerAt;
    turn = null;
  };
  const openTurn = (at: number | null, key: string) => {
    if (!turn) {
      turn = { kind: "agent", key: `turn-${key}`, blocks: [], at, durationMs: null, text: "" };
      items.push(turn);
    }
    return turn;
  };
  const push = (block: Block, at: number | null) => {
    const t = openTurn(at, block.key);
    // Consecutive tool calls stack into one run.
    const prev = t.blocks[t.blocks.length - 1];
    if (block.kind === "tools" && prev?.kind === "tools") prev.calls.push(...block.calls);
    else t.blocks.push(block);
    return t;
  };

  events.forEach((e, i) => {
    const at = eventTime(e);
    const key = stableKey(e, i);
    if (at != null && e.type !== "user.message") lastAt = at;

    switch (e.type) {
      case "user.message": {
        closeTurn();
        failed = false;
        failure = null;
        triggerAt = at;
        lastAt = at;
        if (isWakeup(e)) {
          const md = e.metadata as { scheduled_at?: string } | undefined;
          items.push({ kind: "wakeup", key, event: e, text: eventText(e), scheduledAt: md?.scheduled_at, at });
        } else if (readGrant(e)) {
          items.push({ kind: "answered", key, event: e, grant: readGrant(e) as Grant, text: eventText(e), at });
        } else if (isMissionBrief(e)) {
          const md = e.metadata as { mission_iteration?: number } | undefined;
          const text = eventText(e);
          items.push({
            kind: "brief",
            key,
            event: e,
            text,
            iteration: typeof md?.mission_iteration === "number" ? md.mission_iteration : undefined,
            failing: briefFailures(text),
            at,
          });
        } else {
          const meta = e as { cancelled_at_ms?: number | null };
          const attachments = attachmentsOf(e);
          items.push({
            kind: "user",
            key,
            event: e,
            text: personText(e, attachments),
            images: eventImages(e),
            attachments,
            at,
            cancelled: meta.cancelled_at_ms != null,
            queued: false,
          });
        }
        break;
      }

      case "user.interrupt":
        closeTurn();
        items.push({ kind: "note", key, note: "stopped", at });
        break;

      case "session.status_terminated":
        closeTurn();
        items.push({ kind: "note", key, note: "ended", at });
        break;

      case "span.model_request_start":
        modelStartAt = at;
        firstTokenAt = null;
        break;
      case "span.model_first_token":
        firstTokenAt = at;
        break;
      case "span.model_request_end": {
        const d = e as {
          data?: { finish_reason?: string; error_message?: string; model?: string };
          finish_reason?: string;
          error_message?: string;
          model?: string;
        };
        const finish = d.data?.finish_reason ?? d.finish_reason;
        const msg = d.data?.error_message ?? d.error_message;
        if (finish === "error" && msg) pendingModelError = { error: msg, model: d.data?.model ?? d.model };
        else if (finish && finish !== "error") pendingModelError = null;
        break;
      }

      case "agent.message": {
        // Setup-harness markers ride on empty agent.message events.
        if ((e.metadata as { harness?: string } | undefined)?.harness === OMA_SETUP_HARNESS) break;
        const text = eventText(e);
        if (!text.trim()) break;
        failed = false;
        failure = null;
        const t = push({ kind: "text", key, text, event: e }, at);
        t.text += t.text ? `\n\n${text}` : text;
        break;
      }

      case "agent.thinking": {
        const text = str((e as { text?: unknown }).text) ?? "";
        if (!text) break;
        const from = firstTokenAt ?? modelStartAt;
        const dur = from != null && at != null && at >= from && at - from < 600_000 ? at - from : null;
        push({ kind: "thinking", key, text, durationMs: dur }, at);
        break;
      }

      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use": {
        const id = str(e.id);
        const result = id ? results.get(id) : undefined;
        if (id && result) pairedResults.add(id);
        const endAt = eventTime(result);
        // A bash result that reports a non-zero exit (`exit=1\n…`) failed,
        // whatever its is_error says.
        const isError = isErrorResult(result);
        const confirmation = id ? confirmations.get(id) : undefined;
        const asks = (e as { evaluated_permission?: string }).evaluated_permission === "ask";
        const answered = !!id && clientAnswered.has(id);
        const owes = id && !result && !confirmation && !answered && !movedOn ? owed.get(id) : undefined;
        const waiting = owes === "confirmation";
        const waitingOnClient = owes === "client";
        // Answered (allowed, or the app posted the result) and still without
        // a result: it is running now, whenever it was asked.
        const resumed = confirmation?.result === "allow" || answered;
        const call: ToolCall = {
          key,
          id,
          ...readToolUse(e),
          use: e,
          result,
          output: resultText(result),
          isError,
          startedAt: at,
          durationMs: at != null && endAt != null && endAt >= at ? endAt - at : null,
          status: result
            ? isError
              ? "errored"
              : "completed"
            : confirmation?.result === "deny"
              ? "denied"
              : waitingOnClient
                ? "waiting"
                : opts.running && !waiting && (i > lastTriggerIdx || resumed)
                  ? "running"
                  : undefined,
          approval: waiting
            ? "pending"
            : confirmation
              ? confirmation.result === "deny"
                ? "denied"
                : "allowed"
              : asks && result
                ? "allowed"
                : undefined,
          denyMessage: confirmation?.message,
        };
        // One agent asking another: name who was asked from the thread the
        // call started, and let that thread's "started" note go (the
        // hand-off row says it).
        const agentKey = handoffKey(call.name);
        if (agentKey) {
          const until = reach(i, result);
          let started: Event | undefined;
          for (let j = i + 1; j < until; j++) {
            if (events[j].type === "session.thread_created" && !claimedThreads.has(j)) {
              started = events[j];
              claimedThreads.add(j);
              break;
            }
          }
          call.handoff = {
            agentKey,
            agentId: str((started as { agent_id?: unknown } | undefined)?.agent_id),
            agentName: str((started as { agent_name?: unknown } | undefined)?.agent_name),
            threadId: str(started?.session_thread_id),
          };
        }
        // `request_access` and `request_skill` put a card in the
        // conversation (the system event that follows). The card says
        // everything the call did, so the call is not drawn a second time.
        const asksFor = call.name === "request_access" ? "system.access_request" : call.name === "request_skill" ? "system.skill_request" : null;
        if (asksFor && !isError && events.slice(i + 1, reach(i, result) + 1).some((x) => x.type === asksFor)) break;

        if (waiting) {
          pendingApprovals.push(call);
          push({ kind: "approval", key: `approval-${key}`, call }, at);
        } else {
          push({ kind: "tools", key: `tools-${key}`, calls: [call] }, at);
        }
        break;
      }

      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const id = str(e.tool_use_id) ?? str(e.mcp_tool_use_id);
        if (id && pairedResults.has(id)) break;
        if (id && events.some((x) => TOOL_USE.has(x.type) && x.id === id)) break; // pairs later in the list
        // A result with no call (out-of-order delivery, recovery placeholder).
        const call: ToolCall = {
          key,
          id,
          flavor: e.type === "agent.mcp_tool_result" ? "mcp" : "tool",
          name: "tool result",
          input: {},
          use: e,
          result: e,
          output: resultText(e),
          isError: isErrorResult(e),
          status: isErrorResult(e) ? "errored" : "completed",
          startedAt: at,
          durationMs: null,
        };
        push({ kind: "tools", key: `tools-${key}`, calls: [call] }, at);
        break;
      }

      case "session.error": {
        const code = str(e.error) ?? "error";
        const message = str((e as { message?: unknown }).message);
        const workItemId = str((e as { work_item_id?: unknown }).work_item_id);
        failed = true;
        // The runtime reports one failure twice (the turn, then its work item).
        const t = turn as Extract<Item, { kind: "agent" }> | null;
        const prev = t?.blocks[t.blocks.length - 1];
        if (prev?.kind === "error" && prev.code === code && prev.message === message) {
          prev.workItemId = prev.workItemId ?? workItemId;
          failure = prev.cause ?? prev.message ?? null;
          break;
        }
        failure = pendingModelError?.error ?? message ?? null;
        push(
          {
            kind: "error",
            key,
            event: e,
            code,
            message,
            cause: pendingModelError?.error,
            model: pendingModelError?.model,
            workItemId,
            at,
          },
          at,
        );
        pendingModelError = null;
        break;
      }

      case "session.warning":
        push({ kind: "warning", key, source: str(e.source), message: String(e.message ?? "") }, at);
        break;

      case "system.access_request": {
        const isGranted = granted.has(requestId(e));
        push(
          {
            kind: "card",
            key,
            card: "access_request",
            event: e,
            request: isGranted ? "answered" : (requests.states.get(requestKey(e)) ?? "open"),
            granted: isGranted,
          },
          at,
        );
        break;
      }
      case "system.saved_login_attached":
        push({ kind: "card", key, card: "saved_login", event: e, granted: granted.has(requestId(e)) }, at);
        break;
      case "system.memory_enabled":
        push({ kind: "card", key, card: "memory_enabled", event: e }, at);
        break;
      // system.access_granted is state for the request cards above, never a row.
      case "system.ambient_rule_created":
        push({ kind: "card", key, card: "ambient_rule", event: e }, at);
        break;
      case "system.mission_verdict":
        push({ kind: "card", key, card: "mission_verdict", event: e }, at);
        break;
      case "system.skill_request":
        push({ kind: "card", key, card: "skill_request", event: e, request: requests.states.get(requestKey(e)) ?? "open" }, at);
        break;

      case "span.wakeup_scheduled":
        push({ kind: "note", key, note: "wake_scheduled", event: e, at }, at);
        break;
      case "agent.thread_context_compacted":
      case "span.compaction_summarize_end":
        push({ kind: "note", key, note: "compacted", event: e, at }, at);
        break;
      case "session.thread_created":
        if (claimedThreads.has(i)) break;
        if (str(e.session_thread_id) && e.session_thread_id !== "sthr_primary") {
          push({ kind: "note", key, note: "thread_started", event: e, at }, at);
        }
        break;
      case "session.status_rescheduled":
        push({ kind: "note", key, note: "rescheduled", event: e, at }, at);
        break;

      default:
        break;
    }
  });
  closeTurn();

  // A grant the server recorded answers its request, even when the note to
  // the agent is missing or names the service differently.
  const openRequests = granted.size ? requests.open.filter((r) => !granted.has(r.key)) : requests.open;
  return { items, pendingApprovals, openRequests, failed, failure: failed ? failure : null };
}

// ── usage ───────────────────────────────────────────────────────────────

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelCalls: number;
  toolCalls: number;
  toolErrors: number;
  turns: number;
  /** First to last event, ms. */
  durationMs: number | null;
  startedAt: number | null;
  lastEventAt: number | null;
}

/** Totals read straight off the event log (model usage rides on span ends). */
export function summarizeUsage(events: Event[]): SessionUsage {
  const u: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    toolErrors: 0,
    turns: 0,
    durationMs: null,
    startedAt: null,
    lastEventAt: null,
  };
  for (const e of events) {
    const at = eventTime(e);
    if (at != null) {
      if (u.startedAt == null || at < u.startedAt) u.startedAt = at;
      if (u.lastEventAt == null || at > u.lastEventAt) u.lastEventAt = at;
    }
    if (e.type === "span.model_request_end") {
      const usage =
        (e as { model_usage?: Record<string, number> }).model_usage ??
        (e.data as { model_usage?: Record<string, number> } | undefined)?.model_usage;
      u.modelCalls += 1;
      if (usage) {
        u.inputTokens += usage.input_tokens ?? 0;
        u.outputTokens += usage.output_tokens ?? 0;
        u.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
        u.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
      }
    } else if (TOOL_USE.has(e.type)) {
      u.toolCalls += 1;
    } else if ((e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") && isErrorResult(e)) {
      u.toolErrors += 1;
    } else if (e.type === "user.message") {
      u.turns += 1;
    }
  }
  if (u.startedAt != null && u.lastEventAt != null && u.lastEventAt > u.startedAt) {
    u.durationMs = u.lastEventAt - u.startedAt;
  }
  return u;
}

/**
 * CONTRACT (step 0 baseline; owner C3, used by C6b's SessionChat).
 * request_ids the server has durably marked granted (`system.access_granted`).
 * Feeds AccessRequestCard's `granted` and SavedLoginLine's `switched`.
 */
export function grantedRequestIds(events: readonly Event[]): Set<string> {
  const out = new Set<string>();
  for (const ev of events) {
    if (ev.type !== "system.access_granted") continue;
    const rid = (ev as { request_id?: unknown }).request_id;
    if (typeof rid === "string" && rid) out.add(rid);
  }
  return out;
}
