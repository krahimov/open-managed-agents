import { useCallback, useEffect, useRef, useState } from "react";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
} from "@open-managed-agents/api-types";
import { useApi } from "../../lib/api";
import type { Event } from "../../lib/events";
import { Markdown } from "../../components/Markdown";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "../../components/ai-elements/conversation";
import { Message, MessageContent } from "../../components/ai-elements/message";
import { AccessRequestCard } from "../../components/AccessRequestCard";
import { HarnessDiffCard } from "../../components/HarnessDiffCard";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "../../components/ai-elements/prompt-input";

/**
 * Lightweight, session-id-driven chat surface. Reuses the same ai-elements
 * primitives + SSE client as SessionDetail, but without the full-page chrome
 * (trajectory chips, panels, timeline) — so it can be embedded twice in the
 * Agent Builder: once for the builder interview, once for the test-run preview.
 *
 * It deliberately renders only the canonical events (user/assistant text +
 * non-setup tool calls). Setup harness markers ride on `agent.message`
 * tagged `metadata.harness === OMA_SETUP_HARNESS` (per the EventBase metadata
 * convention) — those are surfaced to the parent via `onEvent` and never shown
 * as chat bubbles.
 */
interface SessionChatProps {
  sessionId: string;
  /** Fires for every event (replayed history + live). The builder page uses it
   *  to capture draft_updated / finalized markers for the Config pane. */
  onEvent?: (ev: Event) => void;
  placeholder?: string;
  emptyTitle?: string;
  emptyDescription?: string;
}

function eventText(ev: Event): string {
  if (Array.isArray(ev.content)) return ev.content.map((b) => b.text ?? "").join("");
  if (typeof ev.content === "string") return ev.content;
  return "";
}

function isSetupMarker(ev: Event): boolean {
  return (ev.metadata as { harness?: string } | undefined)?.harness === OMA_SETUP_HARNESS;
}

/** update_harness markers carry a before/after harness view — these render
 *  as an animated diff card instead of being hidden like other markers. */
function isHarnessUpdate(ev: Event): boolean {
  return (
    isSetupMarker(ev) &&
    (ev.metadata as { kind?: string } | undefined)?.kind === OMA_SETUP_KIND_HARNESS_UPDATED
  );
}

/** Events worth showing as chat bubbles/chips (everything else — stream deltas,
 *  status, span, results, builder markers — is filtered out). */
function isRenderable(ev: Event): boolean {
  if (isHarnessUpdate(ev)) return true;
  if (isSetupMarker(ev)) return false;
  if (ev.type === "user.message") return eventText(ev).length > 0;
  if (ev.type === "agent.message") return eventText(ev).trim().length > 0;
  if (ev.type === "agent.tool_use") {
    return typeof ev.name === "string" && !ev.name.startsWith("mcp__oma_setup__");
  }
  // Agent-initiated credential requests render as a connect card — during
  // setup this is how the agent hands the user the OAuth popups for the
  // servers it just added to its own harness.
  if (ev.type === "system.access_request") return true;
  return false;
}

export function SessionChat({
  sessionId,
  onEvent,
  placeholder,
  emptyTitle,
  emptyDescription,
}: SessionChatProps) {
  const { api, streamEvents } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  /** In-flight token streams keyed by message_id. An entry appears on
   *  stream_start (or a stray chunk after reconnect), grows per chunk, and
   *  is dropped when the canonical agent.message with the same id lands
   *  (or the stream ends aborted). */
  const [streams, setStreams] = useState<Record<string, string>>({});

  // Keep the latest onEvent without re-subscribing the stream on each render.
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    const abort = new AbortController();
    const seen = new Set<string>();
    setEvents([]);
    setPending(null);
    setStatus("idle");
    setStreams({});

    // streamEvents replays history (replay=1) then live-streams; reconnects
    // replay again, so dedup by seq/id.
    streamEvents(
      sessionId,
      (raw) => {
        const ev = raw as Event;
        onEventRef.current?.(ev);

        if (ev.type === "session.status_running") setStatus("running");
        else if (ev.type === "session.status_idle" || ev.type === "session.error") {
          setStatus("idle");
        }
        if (ev.type === "user.message") setPending(null);

        // Live token streaming — broadcast-only events, never in history.
        if (ev.type === "agent.message_stream_start") {
          const mid = (ev as { message_id?: string }).message_id;
          if (mid) setStreams((s) => ({ ...s, [mid]: s[mid] ?? "" }));
          return;
        }
        if (ev.type === "agent.message_chunk") {
          const { message_id: mid, delta } = ev as { message_id?: string; delta?: string };
          if (mid && delta) setStreams((s) => ({ ...s, [mid]: (s[mid] ?? "") + delta }));
          return;
        }
        if (ev.type === "agent.message_stream_end") {
          const { message_id: mid, status: st } = ev as { message_id?: string; status?: string };
          // completed streams stay visible until the canonical agent.message
          // (same id) replaces them a beat later — no flicker.
          if (mid && st !== "completed") {
            setStreams((s) => {
              if (!(mid in s)) return s;
              const { [mid]: _dropped, ...rest } = s;
              return rest;
            });
          }
          return;
        }
        if (ev.type === "agent.message") {
          // Canonical message replaces its stream bubble (ids match).
          const mid = (ev as { message_id?: string }).message_id ?? ev.id;
          if (mid) {
            setStreams((s) => {
              if (!(mid in s)) return s;
              const { [mid]: _dropped, ...rest } = s;
              return rest;
            });
          }
        }

        if (!isRenderable(ev)) return;
        const key = ev.seq != null ? `seq:${ev.seq}` : ev.id ? `id:${ev.id}` : null;
        if (key) {
          if (seen.has(key)) return;
          seen.add(key);
        }
        setEvents((prev) => [...prev, ev]);
      },
      abort.signal,
    );
    return () => abort.abort();
  }, [sessionId, streamEvents]);

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setSending(true);
      setPending(trimmed);
      try {
        await api(`/v1/sessions/${sessionId}/events`, {
          method: "POST",
          body: JSON.stringify({
            events: [{ type: "user.message", content: [{ type: "text", text: trimmed }] }],
          }),
        });
      } catch {
        // api() surfaces the error toast; drop the optimistic bubble.
        setPending(null);
      }
      setSending(false);
    },
    [api, sessionId],
  );

  const isEmpty = events.length === 0 && !pending;

  return (
    <div className="flex flex-col h-full min-h-0">
      <Conversation className="flex-1 min-h-0">
        <ConversationContent className="gap-4">
          {isEmpty && (
            <ConversationEmptyState
              title={emptyTitle ?? "No messages yet"}
              description={emptyDescription ?? "Send a message to get started."}
            />
          )}
          {events.map((ev, i) => {
            const key = ev.seq != null ? `seq:${ev.seq}` : ev.id ?? `i${i}`;
            if (ev.type === "user.message") {
              return (
                <Message from="user" key={key}>
                  <MessageContent>{eventText(ev)}</MessageContent>
                </Message>
              );
            }
            if (ev.type === "agent.message") {
              if (isHarnessUpdate(ev)) {
                return <HarnessDiffCard key={key} event={ev} />;
              }
              return (
                <Message from="assistant" key={key}>
                  <MessageContent>
                    <Markdown>{eventText(ev)}</Markdown>
                  </MessageContent>
                </Message>
              );
            }
            if (ev.type === "system.access_request") {
              return <AccessRequestCard key={key} event={ev} sessionId={sessionId} />;
            }
            // agent.tool_use → compact chip
            return (
              <div
                key={key}
                className="text-xs text-fg-subtle inline-flex items-center gap-1.5"
              >
                <span aria-hidden>🔧</span>
                <span className="font-mono">{ev.name}</span>
              </div>
            );
          })}
          {pending && (
            <Message from="user">
              <MessageContent className="opacity-70">{pending}</MessageContent>
            </Message>
          )}
          {Object.entries(streams).map(([mid, text]) =>
            text ? (
              <Message from="assistant" key={`stream:${mid}`}>
                <MessageContent>
                  <Markdown>{text}</Markdown>
                  <span className="inline-block w-2 h-4 align-text-bottom bg-fg-subtle/60 animate-pulse" aria-hidden />
                </MessageContent>
              </Message>
            ) : null,
          )}
          {status === "running" && Object.keys(streams).length === 0 && (
            <div className="text-xs text-fg-subtle">Working…</div>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <div className="border-t border-border p-3 bg-bg shrink-0">
        <PromptInput
          onSubmit={async ({ text }) => {
            await send(text);
          }}
        >
          <PromptInputTextarea
            placeholder={placeholder ?? "Send a message…"}
            disabled={sending}
          />
          <PromptInputFooter>
            <PromptInputTools />
            <PromptInputSubmit status={sending ? "submitted" : undefined} disabled={sending} />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
