import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import yaml from "js-yaml";
import { toast } from "sonner";
import { ArrowUpIcon, CornerDownRightIcon, HandIcon, HourglassIcon, SplitIcon } from "lucide-react";

import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { useQuery } from "@tanstack/react-query";

import { IntegrationsApi } from "../integrations/api/client";
import { ApiError, useApi } from "../lib/api";
import type { Event } from "../lib/events";
import { readFailure } from "../lib/failures";
import { quietWords, readSession, STALLED_AFTER_MS } from "../lib/session-state";
import { missionRef, missionTitle, sessionSource, sessionTitle, useMissionGoals } from "../lib/sessions";
import { startSession } from "../lib/shell-events";
import type { Trajectory } from "../lib/trajectory";
import type { SessionRecord } from "../types/session";
import { AgentAvatar } from "../components/AgentAvatar";
import { useCrumbLabel } from "../components/AppBreadcrumb";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { RecordNotFound } from "../components/EmptyState";
import { MissionBanner } from "../components/MissionBanner";
import { Page, PAGE_GUTTER } from "../components/Page";
import { QueryProblem } from "../components/QueryProblem";
import { Tip } from "../components/Tip";
import { Conversation, ConversationContent } from "../components/ai-elements/conversation";
import { ContextPanel, type PeekTarget, type SessionState } from "../components/sessions/ContextPanel";
import { ConversationControl, ConversationEdges, JumpToLatest, type ConversationHandle } from "../components/sessions/ConversationEdges";
import { ConversationView, type QueuedMessage } from "../components/sessions/ConversationView";
import { onTablistKeyDown, useMediaQuery, useMinuteClock, useSessionOperations, useStoredFlag } from "../components/sessions/hooks";
import { buildConversation, eventText, summarizeUsage } from "../components/sessions/model";
import { useSessionReadings } from "../components/sessions/readings";
import { SessionComposer, type SendResult } from "../components/sessions/SessionComposer";
import { SessionHeader, SESSION_VIEW_PANEL_ID, sessionViewTabId, type SessionView } from "../components/sessions/SessionHeader";
import {
  findLinearAddress,
  linearIdentifierFromText,
  linearIssueLink,
  linearUrlKey,
  type GitHubSource,
  type LinearSource,
  type SlackSource,
} from "../components/sessions/source";
import { ContextPanelSkeleton, ConversationSkeleton } from "../components/sessions/SessionSkeleton";
import { TimelineView } from "../components/timeline/TimelineView";
import { SaveAsEvalDialog } from "./evals/SaveAsEvalDialog";
import { ResourceSheet } from "./session-detail/Panels";
import { TrajectoryViewerModal } from "./session-detail/Trajectory";

/**
 * Session detail: the centrepiece.
 *
 *   top bar      Sessions > {title}
 *   session bar  identity, status, facts by name, view switch, actions   (fixed)
 *   body         conversation column (the only thing that scrolls) | context panel
 *
 * This file owns the data: the session record, the event history, the live
 * stream and the outbox. Everything on screen is derived from that state
 * and drawn by components/sessions/* (conversation, composer, header,
 * context panel) and components/timeline/* (the waterfall).
 */

/** A name lookup that returned no record: the record is gone, or the read failed. */
type LookupProblem = "missing" | "failed";

const PRIMARY_THREAD = "sthr_primary";
const integrations = new IntegrationsApi();
const COLUMN = "mx-auto w-full max-w-[720px]";


/** A user.* event sitting in the server-side pending_events queue.
 *  Maintained client-side via system.user_message_pending /
 *  _promoted / _cancelled SSE frames. Server is authoritative on what's
 *  pending; client mirrors the row for outbox rendering only. */
interface PendingEntry {
  event_id: string;
  pending_seq: number;
  enqueued_at: number;
  session_thread_id: string;
  /** The full canonical user.* event the server enqueued. */
  event: Event;
}

export function SessionDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { api, streamEvents } = useApi();
  /** The session record. `undefined` while it loads, `null` when the
   *  session does not exist (or cannot be read), with `loadError` set for
   *  anything other than a plain 404. */
  const [session, setSession] = useState<SessionRecord | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  /** True once the first page of history has been folded in, so the
   *  conversation can tell "still loading" from "no messages yet". */
  const [historyLoaded, setHistoryLoaded] = useState(false);
  /** The history could not be read. With no events on screen this is an
   *  "unavailable" state with a retry, never "nothing has been said yet". */
  const [historyError, setHistoryError] = useState<Error | null>(null);
  const [events, setEvents] = useState<Event[]>([]);
  /** In-flight assistant streams keyed by message_id. Each entry holds
   *  the deltas accumulated so far. Wiped on the matching agent.message
   *  (same message_id), which becomes the canonical render. */
  const [streams, setStreams] = useState<Map<string, string>>(new Map());
  /** In-flight reasoning streams keyed by thinking_id. Same lifecycle
   *  as messages — drained on matching agent.thinking. */
  const [thinkingStreams, setThinkingStreams] = useState<Map<string, string>>(new Map());
  /** In-flight tool-input streams keyed by tool_use_id. Wiped when the
   *  canonical agent.tool_use / mcp_tool_use / custom_tool_use lands
   *  with the same id (toolCallId on the AI SDK side). The accumulated
   *  string is partial JSON — render as a code block, not Markdown. */
  const [toolInputStreams, setToolInputStreams] = useState<Map<string, { name?: string; partial: string }>>(new Map());
  // Which view (conversation or timeline) and which thread are part of the
  // address, so a reload or a shared link lands where the person was.
  const [searchParams, setSearchParams] = useSearchParams();
  const view: SessionView = searchParams.get("view") === "timeline" ? "timeline" : "chat";
  const activeThreadId = searchParams.get("thread") || PRIMARY_THREAD;
  const setParam = useCallback(
    (name: "view" | "thread", value: string | null) => {
      // From the address as it is now, not as it was at the last render:
      // two changes in quick succession must not undo each other.
      const next = new URLSearchParams(window.location.search);
      if (value) next.set(name, value);
      else next.delete(name);
      setSearchParams(next, { replace: true });
    },
    [setSearchParams],
  );
  const setView = useCallback((next: SessionView) => setParam("view", next === "timeline" ? "timeline" : null), [setParam]);
  const setActiveThreadId = useCallback((next: string) => setParam("thread", next === PRIMARY_THREAD ? null : next), [setParam]);
  const [sending, setSending] = useState(false);
  // Optimistic outbox slot — what the user typed, between hitting Send
  // and the server-side pending broadcast (system.user_message_pending)
  // arriving over SSE. Without this, hitting Send clears the input
  // field instantly and the user stares at a blank conversation for the
  // 100-500ms POST → SSE roundtrip. With it, the message appears in the
  // queued-state EventBubble immediately and is replaced by the server's
  // pending row the moment SSE delivers it. Single slot is intentional
  // (we never let two POSTs be in flight at once — Send is disabled
  // while `sending`). Set to null when SSE confirms or POST settles.
  const [localPending, setLocalPending] = useState<{ text: string; images: number } | null>(null);
  const [agentId, setAgentId] = useState("");
  const [sessionMeta, setSessionMeta] = useState<{
    environmentId?: string;
    vaultIds?: string[];
    vaults?: Array<{ id: string; name?: string; problem?: LookupProblem }>;
    createdAt?: string;
    agentSnapshot?: { id?: string; name?: string; model?: string | { id: string }; description?: string; version?: number };
    envSnapshot?: { id?: string; name?: string; description?: string };
    /** The environment's name lookup did not return a record. */
    envProblem?: LookupProblem;
  }>({});
  const [resourcePanel, setResourcePanel] = useState<PeekTarget | null>(null);
  const [showSaveAsEval, setShowSaveAsEval] = useState(false);
  const [linear, setLinear] = useState<LinearSource | null>(null);
  const [missionId, setMissionId] = useState<string | null>(null);
  const [slack, setSlack] = useState<SlackSource | null>(null);
  /** Live status read off the event stream; null until a status event is seen. */
  const [status, setStatus] = useState<string | null>(null);
  /** Lazy-fetched Trajectory v1 envelope. Drives the outcome + reward
   *  chips in the header strip and the Trajectory viewer modal. We don't
   *  block initial render on this — chips render as `—` until it lands.
   *  Sentinels mirror EvalRunDetail: "loading" while in flight, "error"
   *  if the fetch failed (404 = trajectory not built yet, 5xx = sandbox
   *  flaky); both keep the trigger from re-firing every render. */
  const [trajectory, setTrajectory] = useState<Trajectory | "loading" | "error" | undefined>(undefined);
  /** Why the trajectory is "error": a 404 means it has not been built yet
   *  (a state), anything else means the read failed (a fault to retry). */
  const [trajectoryFault, setTrajectoryFault] = useState<Error | null>(null);
  /** Sub-agent threads in this session. Primary is implicit at index 0
   *  (label "Main"). Empty when the session has only the primary thread,
   *  in which case the selector UI is hidden entirely. Refreshed on
   *  `session.thread_created` events arriving over SSE.
   *  parent_thread_id powers the tree view (coordinator → worker → sub-
   *  worker); missing parents fall back to the primary root. */
  const [threads, setThreads] = useState<
    Array<{ id: string; agent_id?: string; agent_name?: string; parent_thread_id?: string | null }>
  >([]);
  /** True once the threads list has answered (or failed): only then can a
   *  thread named in the address be called unknown. */
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  // The active thread is `?thread=` (see above); it defaults to
  // 'sthr_primary' and filters the events array at render time. SSE-driven
  // new threads don't auto-switch: the operator stays on what they're watching.
  /** Server-mirrored pending queue, keyed by event_id. Populated from
   *  the initial GET /pending plus live system.user_message_pending /
   *  _promoted / _cancelled SSE frames. Pending entries render as a
   *  separate "outbox" section at the bottom of the timeline; once the
   *  server promotes the row (system.user_message_promoted), the entry
   *  is removed from this map and the canonical user.* event takes its
   *  place in the events array via the regular SSE broadcast. */
  const [pendingByEventId, setPendingByEventId] = useState<Map<string, PendingEntry>>(new Map());
  const [showTrajectory, setShowTrajectory] = useState(false);
  const seenKeys = useRef(new Set<string>());
  const abortRef = useRef<AbortController | null>(null);

  // Dedup key for SSE re-delivery + initial-fetch overlap. `id` is stamped
  // on every event by the server (sevt-* for tool_results / stream events;
  // toolCallId for tool_use overrides) so it's a uniqueness guarantee
  // across the wire. The previous content-based key dropped legitimate
  // distinct events whose payloads happened to be byte-identical (two
  // back-to-back `gh repo list` calls both timing out with the same
  // 401 stderr was the repro). Fallback only kicks in for legacy events
  // that pre-date stamping.
  // Node-runtime events (claude-agent-sdk / codex-sdk harnesses) are not
  // id-stamped but do carry the persisted `seq`, which is unique per session
  // — use it before the content fallback. Without this, four memory
  // checkpoint Edits whose results were all "The file … has been updated
  // successfully" collapsed to one, leaving the others stuck on "Running".
  const eventKey = (e: Event) =>
    (e as { id?: string }).id
    ?? ((e as { seq?: number }).seq !== undefined
      ? `${e.type}:seq:${(e as { seq?: number }).seq}`
      : `${e.type}:${JSON.stringify(e.content || e.tool_use_id || e.error || "").slice(0, 120)}`);

  const addEvent = (e: Record<string, unknown>) => {
    const ev = e as Event;

    // Streaming chunk lifecycle. None of these go into the events list
    // (would pollute history once the canonical agent.message lands);
    // they drive the `streams` map that the renderer overlays after
    // committed events. The matching agent.message arrives with the
    // same message_id and replaces the in-flight render.
    if (ev.type === "agent.message_stream_start" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (prev.has(mid)) return prev;
        const next = new Map(prev);
        next.set(mid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_chunk" && ev.message_id && typeof ev.delta === "string") {
      const mid = ev.message_id;
      const delta = ev.delta;
      setStreams((prev) => {
        const next = new Map(prev);
        next.set(mid, (next.get(mid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.message_stream_end") {
      // Hold the in-flight render until the canonical agent.message
      // arrives — keeps UI stable through the brief gap between the
      // SSE stream_end and the events-log commit. If the run was
      // aborted/interrupted, the canonical event will land via the
      // recovery path and clean up the same way.
      return;
    }

    // Thinking stream lifecycle. Same pattern as message stream:
    // start opens an entry, chunk appends, end is held, canonical
    // agent.thinking with same thinking_id closes it.
    if (ev.type === "agent.thinking_stream_start" && typeof ev.thinking_id === "string") {
      const tid = ev.thinking_id;
      setThinkingStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, "");
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_chunk" && typeof ev.thinking_id === "string" && typeof ev.delta === "string") {
      const tid = ev.thinking_id;
      const delta = ev.delta;
      setThinkingStreams((prev) => {
        const next = new Map(prev);
        next.set(tid, (next.get(tid) ?? "") + delta);
        return next;
      });
      return;
    }
    if (ev.type === "agent.thinking_stream_end") return;

    // Tool-input stream lifecycle. The accumulated string is partial
    // JSON; once tool_use lands with the same id, drop the in-flight
    // render and let the EventBubble's collapsed tool widget take over.
    if (ev.type === "agent.tool_use_input_stream_start" && ev.tool_use_id) {
      const tid = ev.tool_use_id;
      const name = (ev as { tool_name?: string }).tool_name;
      setToolInputStreams((prev) => {
        if (prev.has(tid)) return prev;
        const next = new Map(prev);
        next.set(tid, { name, partial: "" });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_chunk" && ev.tool_use_id && typeof ev.delta === "string") {
      const tid = ev.tool_use_id;
      const delta = ev.delta;
      setToolInputStreams((prev) => {
        const cur = prev.get(tid);
        if (!cur) return prev;
        const next = new Map(prev);
        next.set(tid, { ...cur, partial: cur.partial + delta });
        return next;
      });
      return;
    }
    if (ev.type === "agent.tool_use_input_stream_end") return;

    // Canonical agent.message lands → drop the in-flight render so
    // we don't double-show the same content.
    if (ev.type === "agent.message" && ev.message_id) {
      const mid = ev.message_id;
      setStreams((prev) => {
        if (!prev.has(mid)) return prev;
        const next = new Map(prev);
        next.delete(mid);
        return next;
      });
    }

    // Canonical agent.thinking → drop the in-flight reasoning entry.
    // If the canonical event has thinking_id we use it; otherwise we
    // bail-clear all live thinking streams (multi-stream-per-step is
    // rare and safer to err on closing them all).
    if (ev.type === "agent.thinking") {
      const tid = typeof ev.thinking_id === "string" ? ev.thinking_id : undefined;
      setThinkingStreams((prev) => {
        if (prev.size === 0) return prev;
        if (tid && !prev.has(tid)) return prev;
        const next = new Map(prev);
        if (tid) next.delete(tid);
        else next.clear();
        return next;
      });
    }

    // Canonical tool_use of any kind (built-in, MCP, custom) → drop
    // in-flight tool input. The canonical id field equals the AI SDK
    // toolCallId we used as tool_use_id.
    if ((ev.type === "agent.tool_use"
      || ev.type === "agent.mcp_tool_use"
      || ev.type === "agent.custom_tool_use") && ev.id) {
      const tid = ev.id;
      setToolInputStreams((prev) => {
        if (!prev.has(tid)) return prev;
        const next = new Map(prev);
        next.delete(tid);
        return next;
      });
    }

    const key = eventKey(ev);
    if (seenKeys.current.has(key)) return;
    seenKeys.current.add(key);

    if (ev.type === "session.status_running") setStatus("running");
    if (ev.type === "session.status_idle") setStatus("idle");
    if (ev.type === "session.status_terminated") setStatus("terminated");
    // session.error → idle: defense-in-depth for the catch-all status_idle
    // emit (processUserMessage finally) in case a future code path forgets
    // to pair status_running with status_idle. Note: do NOT also map
    // status_rescheduled — that's a transient retry-pending state, not a
    // terminal one. Mapping it caused observed pill flicker
    // running→idle→running→idle×3 during exponential-backoff retries
    // (sess-y2bfxm1de4e1zqxm 2026-05-11). The next status_running event
    // for the retry attempt naturally restores the pill.
    if (ev.type === "session.error") {
      setStatus("idle");
      // session.error implies the active turn is dead; the harness won't
      // pick anything else off the queue until the next user.message.
      // Drop the outbox so the user doesn't see ghosts of inputs that
      // can never run on this session state.
      setPendingByEventId(new Map());
    }

    // AMA-spec pending-queue notifications. The server is authoritative
    // on what's queued; we mirror its state into pendingByEventId so the
    // outbox renders without polling /pending.
    if (ev.type === "system.user_message_pending") {
      const p = ev as unknown as {
        event_id: string;
        pending_seq: number;
        enqueued_at: number;
        session_thread_id: string;
        event: Event;
      };
      // Server claimed our optimistic outbox slot — drop the client-only
      // mirror so we don't double-render the same user message (server
      // entry has more metadata + a stable event_id; ours has neither).
      const inner = p.event;
      const innerText =
        inner && (inner as { content?: Array<{ type?: string; text?: string }> }).content
          ?.find((c) => c.type === "text")?.text;
      if (innerText) setLocalPending((cur) => (cur?.text === innerText ? null : cur));
      if (p.event_id) {
        setPendingByEventId((prev) => {
          const next = new Map(prev);
          next.set(p.event_id, {
            event_id: p.event_id,
            pending_seq: p.pending_seq,
            enqueued_at: p.enqueued_at,
            session_thread_id: p.session_thread_id ?? "sthr_primary",
            event: p.event,
          });
          return next;
        });
      }
      // System frame — don't add to events list. The canonical user.*
      // event arrives separately at drain time.
      return;
    }
    if (ev.type === "system.user_message_promoted") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    if (ev.type === "system.user_message_cancelled") {
      const p = ev as unknown as { event_id?: string };
      if (p.event_id) {
        setPendingByEventId((prev) => {
          if (!prev.has(p.event_id!)) return prev;
          const next = new Map(prev);
          next.delete(p.event_id!);
          return next;
        });
      }
      return;
    }
    // user.interrupt also clears the outbox client-side (server emits
    // _cancelled per row above; this is defensive for the case where the
    // SDK posts user.interrupt without a thread filter and we want to
    // drop everything for the active thread).
    if (ev.type === "user.interrupt") {
      const tid = (ev as { session_thread_id?: string }).session_thread_id ?? "sthr_primary";
      setPendingByEventId((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map(prev);
        for (const [k, v] of prev) {
          if (v.session_thread_id === tid) next.delete(k);
        }
        return next;
      });
    }
    // Live-update the thread selector when a sub-agent spawns. We don't
    // auto-switch the operator's view — they stay on whatever they're
    // watching; the new tab just appears alongside.
    if (ev.type === "session.thread_created") {
      const tc = ev as {
        session_thread_id?: string;
        agent_id?: string;
        agent_name?: string;
        parent_thread_id?: string | null;
      };
      if (tc.session_thread_id && tc.session_thread_id !== "sthr_primary") {
        setThreads((prev) =>
          prev.some((t) => t.id === tc.session_thread_id)
            ? prev
            : [
                ...prev,
                {
                  id: tc.session_thread_id!,
                  agent_id: tc.agent_id,
                  agent_name: tc.agent_name,
                  // SessionDO emits thread_created with parent_thread_id;
                  // older sessions (pre-Phase 1) may not — fall back to
                  // primary so the tree stays well-formed.
                  parent_thread_id: tc.parent_thread_id ?? "sthr_primary",
                },
              ],
        );
      }
    }
    // Don't return — Timeline's bucketIntoTurns uses these as the close
    // boundary of a turn. Conversation view's EventBubble switch silently
    // skips unknown types so leaving them in `events` is harmless there.
    // Previously this dropped every span.* and agent.thinking event before
    // they reached `events` state, so Timeline saw none of model/wakeup/
    // compaction/outcome spans (entire reason waterfall looked empty).
    // Conversation view's EventBubble silently ignores unknown types via
    // its switch — keeping the events here costs the chat view nothing
    // and gives Timeline the full trajectory it needs.

    // Tag streamed events with arrival time so the timeline has a usable ts
    // even before the server-side stored copy round-trips.
    if (!ev.ts) ev.ts = new Date().toISOString();

    setEvents((prev) => [...prev, ev]);
  };

  // The session this page is showing right now, for lookups that finish late.
  const currentId = useRef(id);
  currentId.current = id;

  // Names of the environment and the vaults, looked up by id (the session
  // API returns ids only). A lookup that fails is recorded as such: the
  // panel says "could not be loaded" with a retry, and says "deleted" only
  // when the server answered that the record does not exist.
  // env_local_runtime is a synthetic id minted for ambient/mission spawns:
  // there is no environments row to resolve.
  const lookupProblem = (err: unknown): LookupProblem => (err instanceof ApiError && err.status === 404 ? "missing" : "failed");
  const resolveEnvironment = (sessionId: string, environmentId: string | undefined) => {
    if (!environmentId || environmentId === "env_local_runtime") return;
    setSessionMeta((prev) => ({ ...prev, envProblem: undefined }));
    api<{ id: string; name?: string; description?: string }>(`/v1/environments/${environmentId}`, { silentErrors: true })
      .then((env) => {
        if (currentId.current === sessionId) setSessionMeta((prev) => ({ ...prev, envSnapshot: env, envProblem: undefined }));
      })
      .catch((err) => {
        if (currentId.current === sessionId) setSessionMeta((prev) => ({ ...prev, envProblem: lookupProblem(err) }));
      });
  };
  const resolveVaults = (sessionId: string, vaultIds: string[] | undefined) => {
    if (!vaultIds?.length) return;
    setSessionMeta((prev) => ({ ...prev, vaults: undefined }));
    void Promise.all(
      vaultIds.map((vid) =>
        api<{ id: string; name?: string; display_name?: string }>(`/v1/vaults/${vid}`, { silentErrors: true })
          .then((v): { id: string; name?: string; problem?: LookupProblem } => ({ id: v.id, name: v.name ?? v.display_name }))
          .catch((err) => ({ id: vid, problem: lookupProblem(err) })),
      ),
    ).then((vaults) => {
      if (currentId.current === sessionId) setSessionMeta((prev) => ({ ...prev, vaults }));
    });
  };
  const loadTrajectory = (sessionId: string) => {
    setTrajectory("loading");
    setTrajectoryFault(null);
    api<Trajectory>(`/v1/sessions/${sessionId}/trajectory`, { silentErrors: true })
      .then((t) => {
        if (currentId.current === sessionId) setTrajectory(t);
      })
      .catch((err) => {
        if (currentId.current !== sessionId) return;
        setTrajectory("error");
        setTrajectoryFault(err instanceof ApiError && err.status === 404 ? null : err instanceof Error ? err : new Error(String(err)));
      });
  };

  useEffect(() => {
    if (!id) return;
    // Full per-session state reset before loading the new id. The
    // canonical bug this fixes: clicking from /sessions/A to /sessions/B
    // re-runs this effect with a new id, but `events` (and the other
    // session-scoped state below) was retained from session A. Same
    // SessionDetail component instance handles both routes — React only
    // re-runs the effect, doesn't unmount/remount — so without an
    // explicit reset the user sees session A's content under session B's
    // URL until the SSE refill catches up. Hard refresh works because
    // it re-mounts the whole tree from a fresh state. Reported 2026-05-13.
    seenKeys.current.clear();
    setEvents([]);
    setStreams(new Map());
    setThinkingStreams(new Map());
    setToolInputStreams(new Map());
    setAgentId("");
    setSessionMeta({});
    setSession(undefined);
    setLoadError(null);
    setHistoryLoaded(false);
    setHistoryError(null);
    setLinear(null);
    setSlack(null);
    setMissionId(null);
    setStatus(null);
    setTrajectory(undefined);
    setTrajectoryFault(null);
    setThreads([]);
    setThreadsLoaded(false);
    setPendingByEventId(new Map());
    setLocalPending(null);

    // Load session info
    api<SessionRecord>(`/v1/sessions/${id}`, { silentErrors: true })
      .then((s) => {
        setSession(s);
        setAgentId(s.agent?.id || "");
        setSessionMeta({
          environmentId: s.environment_id,
          vaultIds: s.vault_ids,
          createdAt: s.created_at,
          agentSnapshot: s.agent,
        });

        // Live-resolve env + vault names by id. Per the id-only ref decision
        // (memory: session-resource-refs), the session API does not pre-bake
        // display data — clients fetch resources on demand. Names appear a
        // tick later than the badge frame.
        resolveEnvironment(id, s.environment_id);
        resolveVaults(id, s.vault_ids);
        if (typeof s.metadata?.mission_id === "string") {
          setMissionId(s.metadata.mission_id);
        }
        const linearMeta = s.metadata?.linear as LinearSource | undefined;
        if (linearMeta && (linearMeta.issueId || linearMeta.issueIdentifier)) {
          setLinear(linearMeta);
        }
        const slackMeta = s.metadata?.slack as SlackSource | undefined;
        if (slackMeta && (slackMeta.channelId || slackMeta.threadTs)) {
          setSlack(slackMeta);
        }
      })
      .catch((err) => {
        setSession(null);
        if (!(err instanceof ApiError && err.status === 404)) {
          setLoadError(err instanceof Error ? err : new Error(String(err)));
        }
      });

    // Load history. The /events endpoint wraps each event as { seq, type, ts,
    // data }; promote seq + ts onto the inner event so timeline has them.
    // Paginate ASC from seq 0 in pages of 200 — long sessions stream older
    // events progressively rather than blocking the UI on a single 1000-row
    // payload (the legacy `limit=1000` would also silently truncate at the
    // hard ceiling for ultra-long histories). Each page is added as it
    // arrives, so the timeline starts populating after the first roundtrip.
    void (async () => {
      let afterSeq = 0;
      const pageLimit = 200;
      // Bound the loop so a malformed `next_page` never spins forever.
      // Even at 200/page this covers 100k events, well past anything the
      // sandbox SQL store retains in practice.
      for (let i = 0; i < 500; i++) {
        try {
          const res = await api<{
            data: Array<{ seq?: number; type: string; ts?: string; data: Event }>;
            has_more?: boolean;
            next_page?: string | null;
          }>(`/v1/sessions/${id}/events?limit=${pageLimit}&order=asc&after_seq=${afterSeq}`, { silentErrors: true });
          for (const e of res.data) {
            const inner = e.data || (e as unknown as Event);
            if (e.ts && !inner.ts) inner.ts = e.ts;
            if (e.seq !== undefined && inner.seq === undefined) inner.seq = e.seq;
            addEvent(inner);
          }
          setHistoryLoaded(true);
          if (!res.has_more || !res.next_page) break;
          // next_page is "seq_<n>" per session-do.ts:1568.
          const m = /^seq_(\d+)$/.exec(res.next_page);
          if (!m) break;
          const nextAfter = parseInt(m[1], 10);
          if (!Number.isFinite(nextAfter) || nextAfter <= afterSeq) break;
          afterSeq = nextAfter;
        } catch (err) {
          setHistoryError(err instanceof Error ? err : new Error(String(err)));
          setHistoryLoaded(true);
          break;
        }
      }
    })();

    // Connect SSE
    const abort = new AbortController();
    abortRef.current = abort;
    streamEvents(id, addEvent, abort.signal);

    // Lazy-fetch the Trajectory envelope so the header chips have the
    // outcome + reward to show. Decoupled from session/events fetches —
    // trajectory builds on-demand off the events log, so a 5xx here is
    // independent of session metadata loading. We do this once per
    // session id and let the user reopen the page to refresh. Live
    // sessions intentionally don't poll: trajectory.outcome === "running"
    // is fine, the StatusPill already shows the live status.
    loadTrajectory(id);

    // Threads list (primary + sub-agent). Primary is always present
    // (seeded by SessionDO on /init). Filter to non-primary so the
    // selector only renders when there's something to switch between
    // — single-thread sessions get zero UI clutter.
    api<{
      data: Array<{ id: string; agent_id?: string; agent_name?: string; parent_thread_id?: string | null }>;
    }>(`/v1/sessions/${id}/threads`, { silentErrors: true })
      .then((res) => {
        const subThreads = (res.data ?? []).filter((t) => t.id !== "sthr_primary");
        setThreads(subThreads);
        setThreadsLoaded(true);
      })
      .catch(() => {
        setThreads([]);
        setThreadsLoaded(true);
      });

    // Initial pending queue snapshot. The SSE bridge picks up live
    // changes from system.user_message_{pending,promoted,cancelled}
    // frames; this fetch seeds the map so a page-reload during an
    // in-flight queue still shows the outbox correctly. Best-effort —
    // a 404/5xx leaves pendingByEventId empty (the SSE will repopulate
    // when the next pending event lands).
    api<{
      data: Array<{
        pending_seq: number;
        enqueued_at: number;
        type: string;
        event_id: string;
        session_thread_id: string;
        cancelled_at: number | null;
        data: Event;
      }>;
    }>(`/v1/sessions/${id}/pending`, { silentErrors: true })
      .then((res) => {
        const next = new Map<string, PendingEntry>();
        for (const r of res.data ?? []) {
          if (!r.event_id) continue;
          next.set(r.event_id, {
            event_id: r.event_id,
            pending_seq: r.pending_seq,
            enqueued_at: r.enqueued_at,
            session_thread_id: r.session_thread_id,
            event: r.data,
          });
        }
        if (next.size > 0) setPendingByEventId(next);
      })
      .catch(() => {/* leave empty */});

    return () => { abort.abort(); };
  }, [id, loadAttempt]);

  // Attachments the server already holds, by File object: trying a message
  // again uploads only what failed the first time, not a second copy of
  // everything.
  const uploadedFiles = useRef(new WeakMap<File, { id: string; filename: string; media_type: string }>());

  /** A failure in the person's terms: the server's own sentence when it gave one. */
  const sendFailure = (err: unknown): string => {
    if (err instanceof ApiError) return /[.!?]$/.test(err.message) ? err.message : `${err.message}.`;
    return "The server could not be reached. Check your connection.";
  };

  /**
   * Send a message. Resolves with what happened, never throws: the composer
   * keeps the person's words until this says `ok`, and puts them back in
   * the box when it does not.
   *
   * Attachments are uploaded first so the message can reference them by
   * file_id (scoped to this session, so they also show under Files). If ANY
   * of them fails, nothing is sent: the person decides whether to try again
   * or to send without it.
   */
  const send = async (rawText: string, files: File[] = []): Promise<SendResult> => {
    const text = rawText.trim();
    if (!text && !files.length) return { ok: true };
    if (!id) return { ok: false, stage: "send", reason: "This session is not loaded yet." };
    setLocalPending({ text, images: files.length });
    setSending(true);
    try {
      const uploaded: Array<{ id: string; filename: string; media_type: string }> = [];
      const failed: Array<{ file: File; reason: string }> = [];
      for (const file of files) {
        const have = uploadedFiles.current.get(file);
        if (have) {
          uploaded.push(have);
          continue;
        }
        try {
          const fd = new FormData();
          fd.append("file", file);
          fd.append("scope_id", id);
          fd.append("downloadable", "true");
          const r = await api<{ id: string; filename: string; media_type: string }>(`/v1/files`, {
            method: "POST",
            body: fd,
            silentErrors: true,
          });
          // Only images go inline to the model. A file the server does not
          // read as one is reported, never dropped quietly.
          if (!r.media_type?.startsWith("image/")) {
            failed.push({ file, reason: "The server did not read it as an image." });
            continue;
          }
          const record = { id: r.id, filename: r.filename, media_type: r.media_type };
          uploadedFiles.current.set(file, record);
          uploaded.push(record);
        } catch (e) {
          failed.push({ file, reason: sendFailure(e) });
        }
      }
      if (failed.length) {
        setLocalPending(null);
        return { ok: false, stage: "upload", failed };
      }

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; source: { type: "file"; file_id: string } }
      > = [];
      if (text) content.push({ type: "text", text });
      for (const u of uploaded) content.push({ type: "image", source: { type: "file", file_id: u.id } });
      if (!text && uploaded.length) {
        content.unshift({
          type: "text",
          text: uploaded.length === 1 ? "Attached image." : "Attached images.",
        });
      }

      try {
        await api(`/v1/sessions/${id}/events`, {
          method: "POST",
          body: JSON.stringify({
            events: [{ type: "user.message", content }],
          }),
          // The composer draws the failure next to the words it belongs to.
          silentErrors: true,
        });
      } catch (e) {
        setLocalPending(null);
        // 409: the session no longer takes messages (it ended or was
        // archived while this page was open). Read the record again so the
        // page says so.
        const closed = e instanceof ApiError && e.status === 409;
        if (closed) {
          api<SessionRecord>(`/v1/sessions/${id}`, { silentErrors: true })
            .then((fresh) => {
              setSession(fresh);
              if (fresh.status === "terminated") setStatus("terminated");
            })
            .catch(() => {});
        }
        return { ok: false, stage: "send", reason: sendFailure(e), closed };
      }
      // POST resolved → server already inserted the row + broadcast
      // system.user_message_pending. The outbox map will pick it up
      // (and likely already has by the time await unblocks here).
      // Clear our local slot so we don't double-render with the server
      // entry — but only if the server's pending hasn't already cleared
      // it via the system.user_message_pending handler.
      setLocalPending((cur) => (cur?.text === text ? null : cur));
      return { ok: true };
    } finally {
      setSending(false);
    }
  };

  // Stop button — posts user.interrupt to abort whatever turn(s) are
  // running on the active thread. Server-side this triggers the
  // thread-scoped AbortController, marks pending events cancelled, and
  // emits status_idle. Recovery path for the "stuck Running" failure
  // mode where a DO eviction killed an in-flight stream and no clean
  // status_idle was ever broadcast.
  const [interrupting, setInterrupting] = useState(false);
  const interrupt = async () => {
    if (!id) return;
    setInterrupting(true);
    try {
      await api(`/v1/sessions/${id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [{
            type: "user.interrupt",
            ...(activeThreadId !== "sthr_primary" ? { session_thread_id: activeThreadId } : {}),
          }],
        }),
      });
    } catch (e) {
      console.error("interrupt failed", e);
    }
    setInterrupting(false);
  };

  const approveEnvironmentYaml = async (source: string) => {
    try {
      const proposal = parseEnvironmentApprovalYaml(source);
      const created = await api<{ id: string; name?: string }>("/v1/environments", {
        method: "POST",
        body: JSON.stringify(proposal),
      });
      toast.success(`Environment created: ${created.name || created.id}`);
      setResourcePanel({ kind: "environment", id: created.id });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to approve environment YAML");
    }
  };

  const reloadTrajectory = () => {
    if (id) loadTrajectory(id);
  };

  // ── What a person can do when the session is waiting on them ──
  const ops = useSessionOperations(id);

  // ── Layout state ──
  // The details panel sits beside the conversation from 1280px. It opens by
  // itself only where the conversation keeps its full 720px column beside it
  // (1400px and up); on a narrower screen it starts closed. Either way the
  // person's own choice is remembered, separately for each kind of screen,
  // so opening it on a laptop does not close it on the big monitor.
  const isWide = useMediaQuery("(min-width: 1280px)");
  const isRoomy = useMediaQuery("(min-width: 1400px)");
  const [panelPref, setPanelPref] = useStoredFlag(isRoomy ? "muse:session:panel" : "muse:session:panel:compact", isRoomy);
  const [panelSheet, setPanelSheet] = useState(false);
  const [timelineInspecting, setTimelineInspecting] = useState(false);
  const [filesNonce, setFilesNonce] = useState(0);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);
  const panelOpen = isWide ? panelPref : panelSheet;
  const togglePanel = () => (isWide ? setPanelPref(!panelPref) : setPanelSheet(!panelSheet));
  const toggleRef = useRef(togglePanel);
  toggleRef.current = togglePanel;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "." && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Derived ──
  // Untagged events (legacy, spans not yet thread-stamped) belong to the
  // primary thread, matching the bridge filter on the server.
  // A sub-agent's `thread_created` is stamped with the NEW thread's id; it
  // belongs in the conversation of the thread that started it ("Handed work
  // to …"), so it is shown there, by parent.
  const threadEvents = useMemo(
    () =>
      events.filter((e) => {
        const t = e as { session_thread_id?: string; parent_thread_id?: string | null };
        if (e.type === "session.thread_created" && t.session_thread_id && t.session_thread_id !== PRIMARY_THREAD) {
          return (t.parent_thread_id ?? PRIMARY_THREAD) === activeThreadId;
        }
        return (t.session_thread_id ?? PRIMARY_THREAD) === activeThreadId;
      }),
    [events, activeThreadId],
  );
  // The record knows about endings and reschedules the replayed stream can
  // miss; the stream knows about "running" before the record does.
  const streamStatus = status ?? session?.status ?? "idle";
  const lifecycle =
    (session?.status === "terminated" || session?.status === "rescheduling") && streamStatus === "idle"
      ? session.status
      : streamStatus;
  const running = lifecycle === "running";
  const usage = useMemo(() => summarizeUsage(events), [events]);
  // "Running" is a claim about now. A session that makes it and has
  // recorded nothing for half an hour is stalled (lib/session-state.ts):
  // it can still be stopped, but nothing on the page spins or says "is
  // working" on its behalf.
  const now = useMinuteClock();
  const stalled =
    (lifecycle === "running" || lifecycle === "rescheduling") && usage.lastEventAt != null && now - usage.lastEventAt > STALLED_AFTER_MS;
  const live = running && !stalled;
  const conversation = useMemo(() => buildConversation(threadEvents, { running: live }), [threadEvents, live]);

  // The identifier people use for a Linear issue ("ENG-142") is often only in
  // the webhook's opening message, not in the session's metadata.
  const needsLinearIdentifier = !!linear && !linear.issueIdentifier;
  const linearIdentifier = useMemo(() => {
    if (!needsLinearIdentifier) return undefined;
    for (const e of events) {
      if (e.type !== "user.message") continue;
      const found = linearIdentifierFromText(eventText(e));
      if (found) return found;
    }
    return undefined;
  }, [needsLinearIdentifier, events]);

  // The issue's address in Linear (see source.ts): from the log when it is
  // there, else from the connected workspace the console can read.
  const linearIdent = linear?.issueIdentifier ?? linearIdentifier;
  const linearFound = useMemo(() => {
    if (!linear) return {};
    const texts: string[] = [];
    for (const e of events) {
      if (e.type === "user.message") texts.push(eventText(e));
      else if (e.type === "agent.tool_result" || e.type === "agent.mcp_tool_result") {
        const c = (e as { content?: unknown }).content;
        texts.push(typeof c === "string" ? c : JSON.stringify(c ?? ""));
      }
    }
    return findLinearAddress(texts, linearIdent);
  }, [linear, linearIdent, events]);
  const needsWorkspaceKey = !!linear && !!linearIdent && !linearFound.issueUrl && !linearFound.urlKey;
  const linearWorkspaces = useQuery({
    queryKey: ["integrations", "linear", "installations"],
    queryFn: () => integrations.linear.listInstallations(),
    enabled: needsWorkspaceKey,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const linearWorkspaceKey = useMemo(() => {
    if (!needsWorkspaceKey) return undefined;
    const all = linearWorkspaces.data ?? [];
    const mine = all.find((w) => w.workspace_id === linear?.workspaceId) ?? (all.length === 1 ? all[0] : undefined);
    return linearUrlKey(mine?.workspace_id);
  }, [needsWorkspaceKey, linearWorkspaces.data, linear?.workspaceId]);
  const linearUrl = linearIssueLink(linear && linearIdent ? { ...linear, issueIdentifier: linearIdent } : linear, {
    ...linearFound,
    workspaceKey: linearWorkspaceKey,
  });
  // What GitHub started this from: the session names the repository, the
  // webhook's opening message the pull request or issue and its address.
  const github = useMemo<GitHubSource | null>(() => {
    const onSession = session?.metadata?.github as GitHubSource | undefined;
    const opening = events.find((e) => e.type === "user.message" && (e.metadata as { github?: unknown } | undefined)?.github);
    const onEvent = (opening?.metadata as { github?: GitHubSource } | undefined)?.github;
    if (!onSession && !onEvent) return null;
    return { ...onSession, ...onEvent, repository: onEvent?.repository ?? onSession?.repository };
  }, [session?.metadata, events]);

  const agent = sessionMeta.agentSnapshot ?? session?.agent ?? (agentId ? { id: agentId } : {});
  const activeThread = threads.find((t) => t.id === activeThreadId);
  // A sub-agent wears its own face: the agent it is, not the thread it runs in.
  const speaker = activeThread
    ? { id: activeThread.agent_id ?? activeThread.id, name: activeThread.agent_name ?? "Sub-agent" }
    : { id: agent.id, name: agent.name };
  // In a sub-agent's thread the opening message came from the agent that
  // handed it the work (the main agent, or another sub-agent one level up).
  const parentThread = activeThread ? threads.find((t) => t.id === activeThread.parent_thread_id) : undefined;
  const asker = activeThread
    ? parentThread
      ? { id: parentThread.agent_id ?? parentThread.id, name: parentThread.agent_name ?? "Another agent" }
      : { id: agent.id, name: agent.name }
    : undefined;
  // A run's sessions are titled by the run's goal, which may be learned
  // after the record loads: re-read the title when it is.
  useMissionGoals();
  const title = sessionTitle(session ?? null, agent.name);
  // In the bar, a run's title is two parts, so that when it has to be cut
  // it is the goal that gives way and never the iteration.
  const iterationOf = missionRef(session?.title);
  const titleParts = iterationOf
    ? { main: missionTitle(iterationOf.missionId, null), suffix: `iteration ${iterationOf.iteration}` }
    : null;
  // The breadcrumb and the tab take their words from the same rule; telling
  // them the title makes them read it again when it changes.
  const location = useLocation();
  useCrumbLabel(session ? title : null, location.pathname);
  // The session's state is the main thread's, whichever thread is being read.
  const mainConversation = useMemo(
    () =>
      activeThreadId === PRIMARY_THREAD
        ? conversation
        : buildConversation(
            events.filter((e) => ((e as { session_thread_id?: string }).session_thread_id ?? PRIMARY_THREAD) === PRIMARY_THREAD),
            { running: live },
          ),
    [activeThreadId, conversation, events, live],
  );
  // A link can name a thread that does not exist (any more): once the
  // threads are known, such an address falls back to the main thread.
  useEffect(() => {
    if (activeThreadId !== PRIMARY_THREAD && threadsLoaded && !threads.some((t) => t.id === activeThreadId)) {
      setActiveThreadId(PRIMARY_THREAD);
    }
  }, [activeThreadId, threadsLoaded, threads, setActiveThreadId]);

  // ── The one reading of this session (lib/session-state.ts) ──
  // The page has the whole log and the live stream, so here the reading is
  // made from them; until the history has loaded it is the same reading
  // every list shows, from the operations report and the newest events.
  const readings = useSessionReadings();
  const listReading = id ? readings.read({ id, status: lifecycle, updated_at: session?.updated_at }, { now }) : null;
  const reading = useMemo(
    () =>
      historyLoaded || !listReading
        ? readSession({
            status: lifecycle,
            approvals: mainConversation.pendingApprovals.length,
            requests: mainConversation.openRequests,
            // The cause in the error card's words, as every list says it.
            error: mainConversation.failed ? (readFailure(mainConversation.failure).cause ?? true) : null,
            lastEventAt: usage.lastEventAt,
            now,
          })
        : listReading,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [historyLoaded, lifecycle, mainConversation, usage.lastEventAt, now, listReading?.label, listReading?.detail],
  );
  const waiting = reading.waiting;
  /** Bring the first thing that is waiting on a person into view. */
  const conversationRef = useRef<ConversationHandle>(null);
  const jumpToWaiting = useCallback(() => {
    const show = () => {
      const first = document.querySelector<HTMLElement>("[data-needs-you]");
      if (!first) return;
      // Through the scroller's own handle, so it does not pull back to the latest message.
      if (conversationRef.current) conversationRef.current.reveal(first);
      else first.scrollIntoView({ block: "center", behavior: "smooth" });
      first.querySelector<HTMLElement>("button:not([disabled]), input, a[href]")?.focus({ preventScroll: true });
    };
    // The cards are in the main thread's conversation: go there first.
    if (view !== "chat" || activeThreadId !== PRIMARY_THREAD) {
      const next = new URLSearchParams(window.location.search);
      next.delete("view");
      next.delete("thread");
      setSearchParams(next, { replace: true });
      window.setTimeout(show, 160);
    } else show();
  }, [view, activeThreadId, setSearchParams]);

  // A link from Home or Operations to "the thing that is waiting" ends in
  // #needs-you: once the conversation is drawn, go to the first request.
  const jumpedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!id || !historyLoaded || !waiting || window.location.hash !== "#needs-you" || jumpedFor.current === id) return;
    const t = window.setTimeout(() => {
      jumpedFor.current = id;
      jumpToWaiting();
    }, 350);
    return () => window.clearTimeout(t);
  }, [id, historyLoaded, waiting, jumpToWaiting]);
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error" ? trajectory : null;
  const durationMs = ready?.summary?.duration_ms ?? usage.durationMs;

  const queued: QueuedMessage[] = [
    ...(localPending && activeThreadId === PRIMARY_THREAD
      ? [{ key: "local", text: localPending.text, images: localPending.images, sending: true }]
      : []),
    ...Array.from(pendingByEventId.values())
      .filter((p) => p.session_thread_id === activeThreadId)
      .sort((a, b) => a.pending_seq - b.pending_seq)
      .map((p) => ({
        key: `pending-${p.event_id}`,
        text: eventText(p.event),
        images: Array.isArray(p.event.content) ? p.event.content.filter((c) => c.type === "image").length : 0,
      })),
  ];
  const liveStreams = {
    thinking: Array.from(thinkingStreams.entries()),
    toolInputs: Array.from(toolInputStreams.entries()),
    messages: Array.from(streams.entries()),
  };

  // ── The session could not be opened ──
  if (session === null) {
    return (
      <Page width="default" className="pt-10">
        {loadError ? (
          <QueryProblem title="This session could not be loaded" error={loadError} retry={() => setLoadAttempt((n) => n + 1)} />
        ) : (
          <RecordNotFound thing="session" kind="session" back={{ to: "/sessions", label: "sessions" }} />
        )}
      </Page>
    );
  }

  const loading = session === undefined;
  const conversationLoading = loading || !historyLoaded;
  // The history read failed and the live stream has delivered nothing
  // either: there is no conversation to show, and that is not "empty".
  const historyUnavailable = !conversationLoading && !!historyError && events.length === 0;
  const isEmpty = !conversationLoading && !historyUnavailable && conversation.items.length === 0 && queued.length === 0 && !running;
  const showInlinePanel = isWide && panelPref && !(view === "timeline" && timelineInspecting);

  const sourceInfo = {
    kind: session ? sessionSource(session) : "console",
    linear: linear && !linear.issueIdentifier && linearIdentifier ? { ...linear, issueIdentifier: linearIdentifier } : linear,
    linearUrl,
    slack,
    github,
    evalRunId: (session?.metadata?.eval as { run_id?: string } | undefined)?.run_id,
  };
  const panelProps = {
    sessionId: id ?? "",
    agent,
    environmentId: sessionMeta.environmentId,
    environmentName: sessionMeta.envSnapshot?.name,
    environmentProblem: sessionMeta.envProblem,
    onRetryEnvironment: () => id && resolveEnvironment(id, sessionMeta.environmentId),
    vaults: sessionMeta.vaults ?? sessionMeta.vaultIds?.map((vid) => ({ id: vid })) ?? [],
    vaultsResolved: !!sessionMeta.vaults || !sessionMeta.vaultIds?.length,
    onRetryVaults: () => id && resolveVaults(id, sessionMeta.vaultIds),
    source: sourceInfo,
    usage,
    trajectory,
    trajectoryFault,
    onRetryTrajectory: reloadTrajectory,
    startedAt: session?.created_at ?? sessionMeta.createdAt,
    lastActivityAt: usage.lastEventAt ?? session?.updated_at,
    onPeek: setResourcePanel,
    filesNonce,
    reading,
    state: (!historyLoaded
      ? "settled"
      : waiting && !running
        ? "approval"
        : running
          ? "running"
          : mainConversation.failed
            ? "failed"
            : mainConversation.items.length === 0
              ? "empty"
              : "settled") as SessionState,
  };

  const archived = !!session?.archived_at;
  // A session that has ended or been archived takes no more messages (the
  // API answers 409), so it has no box to type in: the composer says why
  // and offers a new session with the same agent instead.
  const composerClosed = archived ? "archived" : lifecycle === "terminated" ? "ended" : null;
  const composerFooter =
    waiting && !activeThread ? (
      // Whatever the agent asked for (approval, access to an app, a skill),
      // the box says how many things are waiting and takes the person to
      // the first one.
      <span className="flex items-center gap-2">
        <HandIcon className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">Waiting on you: {waiting.summary}.</span> You can still send a message.
        </span>
        <button
          type="button"
          onClick={jumpToWaiting}
          className="-my-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-full bg-bg-soft px-2.5 font-medium text-fg transition-quick hover:bg-bg-hover"
        >
          {waiting.count === 1 ? "Show it" : "Show the first"}
          <ArrowUpIcon className="size-3" />
        </button>
      </span>
    ) : stalled && usage.lastEventAt != null ? (
      // The header says "Stalled"; here is what that means and what can be done.
      <span className="flex items-center gap-2">
        <HourglassIcon className="size-3.5 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          <span className="font-medium text-fg">{quietWords(now - usage.lastEventAt)}.</span> It still reports as{" "}
          {lifecycle === "rescheduling" ? "retrying" : "running"}: it may be on a long job, or stuck.
          {running ? " Stop it to free the session." : ""}
        </span>
      </span>
    ) : activeThread ? (
      <span className="flex items-center gap-2">
        <SplitIcon className="size-3.5 shrink-0 text-fg-subtle" />
        You are reading {speaker.name}&rsquo;s thread. Messages go to the main thread.
      </span>
    ) : undefined;

  return (
    <div className="flex h-full min-h-0">
      <SessionHeader
        loading={loading}
        title={title}
        titleParts={titleParts}
        agent={agent}
        reading={reading}
        onShowWaiting={waiting ? jumpToWaiting : undefined}
        archived={archived}
        source={sourceInfo}
        environmentId={sessionMeta.environmentId ?? session?.environment_id}
        environmentName={sessionMeta.envSnapshot?.name}
        startedAt={session?.created_at ?? sessionMeta.createdAt}
        durationMs={durationMs}
        view={view}
        onViewChange={setView}
        eventCount={events.length}
        // A run's session has two things that can be stopped (this turn, the
        // whole run). Both are in the run's band, named for their scope, so
        // the bar does not add a third "Stop" beside them.
        running={running && !missionId}
        stopping={interrupting}
        onStop={() => void interrupt()}
        onSaveAsEval={() => setShowSaveAsEval(true)}
        onOpenTrajectory={() => setShowTrajectory(true)}
        trajectoryDisabled={trajectory === undefined || trajectory === "loading"}
        onShowFiles={() => {
          if (isWide) setPanelPref(true);
          else setPanelSheet(true);
          setFilesNonce((n) => n + 1);
        }}
        onArchive={() => setConfirm("archive")}
        onDelete={() => setConfirm("delete")}
        sessionId={id ?? ""}
        panelOpen={panelOpen}
        onTogglePanel={togglePanel}
        below={
          (threads.length > 0 || (missionId && id)) && (
            <div className={cn("space-y-3 pb-3.5", PAGE_GUTTER)}>
              {/* Sub-agent threads: Main plus one tab per thread, live as they spawn. */}
              {threads.length > 0 && (
                <ThreadTabs threads={threads} mainName={agent.name} mainId={agent.id} activeThreadId={activeThreadId} onSelect={setActiveThreadId} />
              )}
              {missionId && id && (
                <MissionBanner
                  missionId={missionId}
                  currentSessionId={id}
                  turn={{ running, stopping: interrupting, onStop: () => void interrupt() }}
                />
              )}
            </div>
          )
        }
      />

      <div
        role="tabpanel"
        id={SESSION_VIEW_PANEL_ID}
        aria-labelledby={sessionViewTabId(view)}
        className="flex min-w-0 flex-1 flex-col"
      >
        {historyUnavailable ? (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pt-8">
            <QueryProblem
              className={COLUMN}
              title="This session's history could not be loaded"
              error={historyError}
              retry={() => setLoadAttempt((n) => n + 1)}
            />
          </div>
        ) : view === "chat" ? (
          <>
            {/* The conversation. <Conversation> pins to the latest message
                while you are at the bottom and offers "jump to latest" the
                moment you scroll up. */}
            <Conversation className="min-h-0 flex-1" initial="instant">
              <ConversationContent className={cn("block px-6 pt-8 pb-12", isEmpty && "flex min-h-full items-center justify-center")}>
                {conversationLoading ? (
                  <ConversationSkeleton />
                ) : isEmpty ? (
                  <div className="flex max-w-[440px] animate-rise-in flex-col items-center text-center">
                    <AgentAvatar name={speaker.name} id={speaker.id} size="xl" />
                    <h2 className="mt-4 text-h2 text-fg">{speaker.name ?? "This agent"}</h2>
                    <p className="mt-1.5 text-sm text-fg-muted">
                      {activeThread
                        ? "Nothing has happened in this thread yet. Its work appears here as it runs."
                        : agent.description?.trim() || "Nothing has been said yet. Send the first message to get it started."}
                    </p>
                  </div>
                ) : (
                  <ConversationView
                    items={conversation.items}
                    agent={speaker}
                    sessionId={id ?? ""}
                    running={live}
                    streams={liveStreams}
                    queued={queued}
                    ops={ops}
                    onApproveEnvironmentYaml={approveEnvironmentYaml}
                    findEnvironmentYaml={findEnvironmentYaml}
                    onSelectThread={setActiveThreadId}
                    asker={asker}
                  />
                )}
              </ConversationContent>
              <ConversationEdges />
              <ConversationControl ref={conversationRef} />
              <JumpToLatest />
            </Conversation>

            {/* No rule above the composer: the conversation fades out before
                it (ConversationEdges masks the scroller's last lines). */}
            <div className="relative shrink-0 px-6 pb-5">
              <SessionComposer
                key={id}
                sessionId={id}
                className={COLUMN}
                agentName={agent.name}
                model={agent.model}
                running={running}
                stalled={stalled}
                sending={sending}
                onSend={send}
                onStop={() => void interrupt()}
                footer={composerFooter}
                // Only a brand-new session takes the caret by itself. An empty
                // sub-agent thread must not: it would pull focus out of the
                // thread tabs on every arrow key.
                autoFocus={isEmpty && !composerClosed && activeThreadId === PRIMARY_THREAD}
                empty={isEmpty}
                closed={loading ? null : composerClosed}
                onNewSession={agent.id ? () => startSession({ agentId: agent.id }) : undefined}
              />
            </div>
          </>
        ) : (
          <TimelineView events={threadEvents} loading={conversationLoading} onInspect={setTimelineInspecting} />
        )}
      </div>

      {showInlinePanel && (loading ? <ContextPanelSkeleton /> : <ContextPanel {...panelProps} />)}
      {!isWide && (
        <Sheet open={panelSheet} onOpenChange={setPanelSheet}>
          <SheetContent className="gap-0 p-0 sm:max-w-[360px]">
            <SheetTitle className="px-5 pt-5">Session details</SheetTitle>
            <SheetDescription className="sr-only">The agent, environment, vaults, files and usage of this session.</SheetDescription>
            {loading ? (
              <ContextPanelSkeleton className="w-full border-l-0" />
            ) : (
              <ContextPanel {...panelProps} className="w-full flex-1 border-l-0" />
            )}
          </SheetContent>
        </Sheet>
      )}

      <ResourceSheet target={resourcePanel} onClose={() => setResourcePanel(null)} />
      <TrajectoryViewerModal
        open={showTrajectory}
        onClose={() => setShowTrajectory(false)}
        sessionId={id ?? ""}
        sessionTitle={title}
        trajectory={trajectory}
        onRetry={reloadTrajectory}
      />
      {id && (
        <SaveAsEvalDialog
          open={showSaveAsEval}
          onClose={() => setShowSaveAsEval(false)}
          sessionId={id}
          agentId={agent.id || agentId || undefined}
          agentName={agent.name}
          environmentId={sessionMeta.environmentId}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm === "delete"}
        title={confirm === "delete" ? "Delete this session?" : "Archive this session?"}
        body={
          confirm === "delete"
            ? `“${title}” and its whole history are removed. This cannot be undone.`
            : `“${title}” moves out of the sessions list. Its history is kept.`
        }
        confirmLabel={confirm === "delete" ? "Delete session" : "Archive session"}
        onConfirm={async () => {
          if (!id) return;
          if (confirm === "delete") {
            await api(`/v1/sessions/${id}`, { method: "DELETE" });
            toast.success("Session deleted");
            navigate("/sessions");
          } else {
            await api(`/v1/sessions/${id}/archive`, { method: "POST", body: "{}" });
            toast.success("Session archived");
            setSession((prev) => (prev ? { ...prev, archived_at: new Date().toISOString() } : prev));
          }
        }}
      />
    </div>
  );
}

/**
 * Thread tabs, shown only when sub-agent threads exist. "Main" is the
 * primary thread; each sub-agent gets a tab as it spawns. Tabs are in
 * depth-first order, so a worker's own sub-workers follow it and carry a
 * small "started by" mark. Orphans (a parent we have not seen yet) hang off
 * Main so they are never hidden.
 */
function ThreadTabs({
  threads,
  mainName,
  mainId,
  activeThreadId,
  onSelect,
}: {
  threads: Array<{ id: string; agent_id?: string; agent_name?: string; parent_thread_id?: string | null }>;
  mainName?: string;
  mainId?: string;
  activeThreadId: string;
  onSelect: (id: string) => void;
}) {
  const knownIds = new Set<string>([PRIMARY_THREAD, ...threads.map((t) => t.id)]);
  const childrenOf = new Map<string, typeof threads>();
  for (const t of threads) {
    const parent = t.parent_thread_id && knownIds.has(t.parent_thread_id) ? t.parent_thread_id : PRIMARY_THREAD;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), t]);
  }
  const flat: Array<{ id: string; label: string; depth: number; parent?: string; agentId?: string }> = [
    { id: PRIMARY_THREAD, label: "Main", depth: 0 },
  ];
  const walk = (parentId: string, parentLabel: string, depth: number) => {
    for (const k of childrenOf.get(parentId) ?? []) {
      const label = k.agent_name ?? "Sub-agent";
      flat.push({ id: k.id, label, depth, parent: parentLabel, agentId: k.agent_id });
      walk(k.id, label, depth + 1);
    }
  };
  walk(PRIMARY_THREAD, "Main", 1);
  return (
    <div
      role="tablist"
      aria-label="Threads"
      onKeyDown={onTablistKeyDown}
      className="no-scrollbar -mx-1 flex items-center gap-1 overflow-x-auto px-1"
    >
      {flat.map((n) => {
        const active = activeThreadId === n.id;
        const tab = (
          <button
            key={n.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onSelect(n.id)}
            className={cn(
              // The row scrolls sideways, which would clip an outset ring: the focus ring is drawn inside the tab.
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full pr-3 pl-1.5 text-small font-medium whitespace-nowrap transition-quick focus-visible:outline-offset-[-2px]",
              active ? "bg-bg-soft text-fg" : "text-fg-muted hover:bg-bg-hover hover:text-fg",
            )}
          >
            {n.depth > 1 && <CornerDownRightIcon className="ml-1 size-3.5 text-fg-faint" />}
            <AgentAvatar name={n.id === PRIMARY_THREAD ? mainName : n.label} id={n.id === PRIMARY_THREAD ? mainId : (n.agentId ?? n.id)} size="xs" />
            {n.label}
          </button>
        );
        return n.depth > 1 ? (
          <Tip key={n.id} label={`Started by ${n.parent}`}>
            {tab}
          </Tip>
        ) : (
          tab
        );
      })}
    </div>
  );
}

interface EnvironmentApprovalPayload {
  name: string;
  description?: string;
  config: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

function findEnvironmentYaml(message: string): string | null {
  const fence = /```(?:yaml|yml)\s*\n([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(message)) !== null) {
    const candidate = match[1].trim();
    try {
      parseEnvironmentApprovalYaml(candidate);
      return candidate;
    } catch {
      // keep scanning other YAML fences in the same message
    }
  }
  return null;
}

function parseEnvironmentApprovalYaml(source: string): EnvironmentApprovalPayload {
  const parsed = yaml.load(source);
  if (!isRecord(parsed)) {
    throw new Error("Environment YAML must be a mapping.");
  }
  const root = isRecord(parsed.environment) ? parsed.environment : parsed;
  if (!looksLikeEnvironment(root)) {
    throw new Error("YAML does not look like an environment proposal.");
  }

  const rawConfig = isRecord(root.config) ? root.config : root;
  const config: Record<string, unknown> = {
    ...rawConfig,
    type: typeof rawConfig.type === "string" ? rawConfig.type : "cloud",
  };

  const metadata = {
    ...(isRecord(root.metadata) ? root.metadata : {}),
    created_from: "session_yaml_approval",
  };

  return {
    name:
      stringValue(root.name) ||
      stringValue(root.environment_name) ||
      "Agent proposed environment",
    ...(stringValue(root.description) ? { description: stringValue(root.description) } : {}),
    config,
    metadata,
  };
}

function looksLikeEnvironment(value: Record<string, unknown>): boolean {
  return (
    isRecord(value.environment) ||
    isRecord(value.config) ||
    isRecord(value.packages) ||
    isRecord(value.networking) ||
    isRecord(value.sandbox) ||
    isRecord(value.memory) ||
    isRecord(value.resources) ||
    typeof value.dockerfile === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
