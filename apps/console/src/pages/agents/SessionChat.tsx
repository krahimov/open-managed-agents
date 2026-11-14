import { useCallback, useEffect, useRef, useState } from "react";
import { OMA_SETUP_HARNESS, OMA_SETUP_KIND_HARNESS_UPDATED } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";

import { ApiError, useApi } from "../../lib/api";
import type { Event } from "../../lib/events";
import { AccessRequestCard } from "../../components/AccessRequestCard";
import { Conversation, ConversationContent, ConversationScrollButton } from "../../components/ai-elements/conversation";
import { AmbientRuleCard } from "../../components/AmbientRuleCard";
import { BrandLoader } from "../../components/BrandLoader";
import { Composer, ComposerNotice } from "../../components/Composer";
import { EmptyState } from "../../components/EmptyState";
import { CodeWell, EventCard } from "../../components/EventCard";
import { HarnessDiffCard } from "../../components/HarnessDiffCard";
import { ConversationEdges } from "../../components/sessions/ConversationEdges";
import { BUBBLE, Prose } from "../../components/sessions/ConversationView";
import { presentTool } from "../../components/sessions/tools";
import { SkillRequestCard } from "../../components/SkillRequestCard";
import { cn } from "@/lib/utils";

/**
 * A compact, session-id-driven chat, for places that embed a conversation
 * beside something else (the agent setup view puts it next to the live
 * harness). It speaks the same language as the session page: a person's
 * messages in a soft bubble on the right, the agent's prose with no bubble,
 * what the agent did as quiet tool rows, and the shared composer.
 *
 * It deliberately renders only the canonical events (user/assistant text
 * and non-setup tool calls). Setup harness markers ride on `agent.message`
 * tagged `metadata.harness === OMA_SETUP_HARNESS`: those go to the parent
 * through `onEvent` and are never shown as messages, except harness updates,
 * which appear as a diff card.
 */
interface SessionChatProps {
  sessionId: string;
  /** Fires for every event (replayed history + live). The setup page uses it
   *  to capture draft_updated / finalized markers for the harness pane. */
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

/** update_harness markers carry a before/after harness view: these render
 *  as a diff card instead of being hidden like other markers. */
function isHarnessUpdate(ev: Event): boolean {
  return isSetupMarker(ev) && (ev.metadata as { kind?: string } | undefined)?.kind === OMA_SETUP_KIND_HARNESS_UPDATED;
}

/** Events worth showing (everything else, such as stream deltas, status,
 *  spans, results and builder markers, is filtered out). */
function isRenderable(ev: Event): boolean {
  if (isHarnessUpdate(ev)) return true;
  if (isSetupMarker(ev)) return false;
  if (ev.type === "user.message") return eventText(ev).length > 0;
  if (ev.type === "agent.message") return eventText(ev).trim().length > 0;
  if (ev.type === "agent.tool_use") {
    return typeof ev.name === "string" && !ev.name.startsWith("mcp__oma_setup__");
  }
  // Agent-initiated credential requests render as a connect card: during
  // setup this is how the agent hands over the sign-ins for the apps it
  // just added to its own harness.
  if (ev.type === "system.access_request") return true;
  if (ev.type === "system.ambient_rule_created") return true;
  if (ev.type === "system.skill_request") return true;
  return false;
}

/** The readable head of a provider error: drop the JSON tail. */
function headline(raw: string): string {
  const head = raw.split(/\s\{"/)[0].trim();
  return head.length > 180 ? `${head.slice(0, 179)}…` : head;
}

export function SessionChat({ sessionId, onEvent, placeholder, emptyTitle, emptyDescription }: SessionChatProps) {
  const { api, streamEvents } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraft] = useState("");
  /** Why the last message did not go out. Its text is back in the box. */
  const [sendError, setSendError] = useState<string | null>(null);
  const [status, setStatus] = useState<"idle" | "running">("idle");
  /** Last turn failure. session.error's own message is generic; the
   *  actionable cause (a rejected key, a rate limit) rides on the preceding
   *  span.model_request_end with is_error, so the two are paired here as on
   *  the session page. Cleared when a later turn produces output. */
  const [turnError, setTurnError] = useState<{ error: string; cause?: string } | null>(null);
  const pendingCauseRef = useRef<string | null>(null);
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
        if (ev.type === "span.model_request_end") {
          const raw = ev as { data?: { is_error?: boolean; error_message?: string }; is_error?: boolean; error_message?: string };
          const isErr = raw.data?.is_error ?? raw.is_error;
          const msg = raw.data?.error_message ?? raw.error_message;
          pendingCauseRef.current = isErr && msg ? msg : null;
        }
        if (ev.type === "session.error") {
          setTurnError({
            error: String((ev as { message?: string }).message ?? (ev as { error?: string }).error ?? "Turn failed"),
            ...(pendingCauseRef.current ? { cause: pendingCauseRef.current } : {}),
          });
        }
        if (ev.type === "agent.message") setTurnError(null);
        if (ev.type === "user.message") setPending(null);

        // Live token streaming: broadcast-only events, never in history.
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
          // Completed streams stay visible until the canonical agent.message
          // (same id) replaces them a beat later, so nothing flickers.
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
          // The canonical message replaces its stream (ids match).
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

  /** Send `text`. The box is emptied now; if the server does not take the
   *  message, the words go back into it under a notice that says why. */
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      setDraft("");
      setSendError(null);
      setSending(true);
      setPending(trimmed);
      try {
        await api(`/v1/sessions/${sessionId}/events`, {
          method: "POST",
          body: JSON.stringify({
            events: [{ type: "user.message", content: [{ type: "text", text: trimmed }] }],
          }),
          // Drawn next to the words it belongs to, below.
          silentErrors: true,
        });
      } catch (err) {
        setPending(null);
        setDraft((typed) => (typed.trim() ? `${text}\n${typed}` : text));
        setSendError(
          err instanceof ApiError
            ? /[.!?]$/.test(err.message)
              ? err.message
              : `${err.message}.`
            : "The server could not be reached. Check your connection.",
        );
      }
      setSending(false);
    },
    [api, sessionId],
  );

  const streaming = Object.values(streams).some(Boolean);
  const isEmpty = events.length === 0 && !pending && !streaming && !turnError;
  const working = status === "running" && !streaming;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Conversation className="min-h-0 flex-1" initial="instant">
        <ConversationContent className={cn("block px-5 pt-6 pb-10", isEmpty && "flex min-h-full items-center justify-center")}>
          {isEmpty ? (
            <EmptyState
              variant="plain"
              size="md"
              kind="session"
              loading={status === "running"}
              title={emptyTitle ?? "No messages yet"}
              body={emptyDescription ?? "Send a message to get started."}
            />
          ) : (
            <div className="mx-auto w-full max-w-[720px] space-y-4">
              {events.map((ev, i) => {
                const key = ev.seq != null ? `seq:${ev.seq}` : (ev.id ?? `i${i}`);
                if (ev.type === "user.message") {
                  return (
                    <div key={key} className="flex justify-end pt-2 first:pt-0">
                      <div className={BUBBLE}>
                        <p className="break-words whitespace-pre-wrap">{eventText(ev)}</p>
                      </div>
                    </div>
                  );
                }
                if (ev.type === "agent.message") {
                  if (isHarnessUpdate(ev)) return <HarnessDiffCard key={key} event={ev} />;
                  return <Prose key={key}>{eventText(ev)}</Prose>;
                }
                if (ev.type === "system.access_request") return <AccessRequestCard key={key} event={ev} sessionId={sessionId} />;
                if (ev.type === "system.ambient_rule_created") return <AmbientRuleCard key={key} event={ev} />;
                if (ev.type === "system.skill_request") return <SkillRequestCard key={key} event={ev} sessionId={sessionId} />;
                // agent.tool_use: a quiet row naming the tool and what it was asked to do.
                const input = (ev.input && typeof ev.input === "object" ? ev.input : {}) as Record<string, unknown>;
                const p = presentTool({ name: String(ev.name ?? "tool"), flavor: "tool", input });
                return <EventCard key={key} kind={p.kind} icon={p.icon} source={p.source} title={p.title} subtitle={p.preview} />;
              })}
              {pending && (
                <div className="flex flex-col items-end gap-1 pt-2">
                  <div className={cn(BUBBLE, "opacity-60")}>
                    <p className="break-words whitespace-pre-wrap">{pending}</p>
                  </div>
                  <span className="pr-1 text-xs text-fg-subtle">Sending…</span>
                </div>
              )}
              {Object.entries(streams).map(([mid, text]) =>
                text ? (
                  <div key={`stream:${mid}`}>
                    <Prose>{text}</Prose>
                    <BrandLoader size="sm" label="Writing" className="mt-2" />
                  </div>
                ) : null,
              )}
              {turnError && (
                <EventCard kind="error" title="This turn failed" subtitle={headline(turnError.cause ?? turnError.error)}>
                  {turnError.cause && turnError.cause !== headline(turnError.cause) ? <CodeWell tone="danger">{turnError.cause}</CodeWell> : undefined}
                </EventCard>
              )}
              {working && <BrandLoader size="md" label="Working" className="h-6" />}
            </div>
          )}
        </ConversationContent>
        <ConversationEdges />
        <ConversationScrollButton />
      </Conversation>

      <div className="relative shrink-0 px-5 pb-4 before:pointer-events-none before:absolute before:inset-x-0 before:-top-8 before:h-8 before:bg-gradient-to-t before:from-bg before:to-transparent">
        <div className="mx-auto w-full max-w-[720px]">
          {sendError && (
            <div className="mb-2">
              <ComposerNotice
                tone="danger"
                title="Your message was not sent"
                onDismiss={() => setSendError(null)}
                actions={
                  <Button size="sm" variant="outline" onClick={() => void send(draft)} disabled={sending}>
                    Try again
                  </Button>
                }
              >
                {sendError} Your message is back in the box below. Edit it or try again.
              </ComposerNotice>
            </div>
          )}
          <Composer
            size="md"
            value={draft}
            onChange={setDraft}
            onSubmit={() => void send(draft)}
            submitting={sending}
            placeholder={placeholder ?? "Send a message…"}
            aria-label="Message the agent"
          />
        </div>
      </div>
    </div>
  );
}
