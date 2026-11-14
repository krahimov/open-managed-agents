import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApi } from "@/lib/api";
import { useOperations } from "@/lib/directory";
import type { WorkspaceAccess } from "@/lib/operations";
import { useServerFeatures } from "@/lib/server-features";
import { useApiQuery } from "@/lib/useApiQuery";
import { failureSentence } from "@/lib/failure-text";

/** True while the viewport matches `query` ("(min-width: 1280px)"). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/**
 * The time, refreshed twice a minute. For readings that depend on how long
 * ago something happened ("Stalled: no activity for 31m") and must change
 * while the page just sits there.
 */
export function useMinuteClock(everyMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(id);
  }, [everyMs]);
  return now;
}

function readFlag(key: string, initial: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? initial : raw === "1";
  } catch {
    return initial;
  }
}

/**
 * A boolean preference kept in localStorage (panel open, etc.). `initial`
 * applies only until the person has chosen; after that their choice wins.
 * When `key` or `initial` changes (a different preference for a different
 * screen size), the value is read again for the new key.
 */
export function useStoredFlag(key: string, initial: boolean): [boolean, (next: boolean) => void] {
  const [state, setState] = useState(() => ({ key, initial, value: readFlag(key, initial) }));
  let value = state.value;
  if (state.key !== key || state.initial !== initial) {
    value = readFlag(key, initial);
    setState({ key, initial, value });
  }
  const set = useCallback(
    (next: boolean) => {
      setState((prev) => ({ ...prev, key, value: next }));
      try {
        localStorage.setItem(key, next ? "1" : "0");
      } catch {
        // storage unavailable: the choice just will not persist
      }
    },
    [key],
  );
  return [value, set];
}

/**
 * Keyboard handling for a `role="tablist"` whose tabs use a roving
 * tabindex (only the selected tab is in the Tab order). Put it on the
 * tablist element:
 *
 *   ← / →        the previous / next tab, wrapping at the ends
 *   Home / End   the first / last tab
 *
 * Selection follows focus, as it should when showing a tab costs nothing:
 * the tab is focused and clicked, so it is both where the keyboard is and
 * what is on screen.
 */
export function onTablistKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
  if (e.altKey || e.metaKey || e.ctrlKey || e.shiftKey) return;
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'));
  const at = tabs.findIndex((t) => t === document.activeElement);
  if (at < 0 || tabs.length < 2) return;
  e.preventDefault();
  const to =
    e.key === "Home" ? 0 : e.key === "End" ? tabs.length - 1 : (at + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[to].focus();
  tabs[to].click();
  tabs[to].scrollIntoView?.({ block: "nearest", inline: "nearest" });
}

/** The thread a decision is addressed to, when it is not the main one. */
const PRIMARY_THREAD = "sthr_primary";

export interface DecideOptions {
  /** The thread the call was made in. A sub-agent's thread is named explicitly. */
  threadId?: string;
  /** Why it was denied, told to the agent. Only sent with a deny. */
  denyMessage?: string;
}

/**
 * What a person can do to a session that is stuck on them: decide a tool
 * approval, or retry a failed turn.
 *
 * A decision is the session's own `user.tool_confirmation` event, posted
 * to `/v1/sessions/:id/events` (every server takes it; a sub-agent's call
 * names its thread, a deny may carry the reason the agent is told). A
 * server with the operations endpoints re-checks that the approval is
 * still pending, so a plain decision on the main thread goes through
 * `/v1/operations/sessions/:id/approvals` there, and refreshes the shared
 * operations report (sidebar count, Home's attention strip). That endpoint
 * takes neither a reason nor a thread, so those always use the events path.
 *
 * Access: a server that reports the caller's role (`workspace_access`) is
 * asked, and a viewer cannot decide. A server without that endpoint has no
 * roles to check, so anyone who can open the session can answer it.
 * Retry needs the operations endpoints (failed work items come from its
 * report); without them nothing is retryable.
 */
export function useSessionOperations(sessionId: string | undefined) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const features = useServerFeatures();
  const hasAccess = features.data?.features.has("workspace_access") ?? false;
  const hasOperations = features.data?.features.has("operations") ?? false;
  const access = useApiQuery<WorkspaceAccess>(hasAccess ? "/v1/workspace/access" : null, undefined, { staleTime: 5 * 60_000 });
  const ops = useOperations();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // What the server can do is not known yet: nothing is decided until it is.
  const featuresKnown = !!features.data || !!features.error;
  const canOperate = !featuresKnown
    ? false
    : hasAccess
      ? !!access.data?.authorization && access.data.authorization.role !== "viewer"
      : true;

  /** Failed work items of this session, by id: the turns that can be retried. */
  const retryable = useMemo(() => {
    const ids = new Set<string>();
    if (!hasOperations) return ids;
    for (const w of ops.report?.work_items ?? []) {
      if (w.sessionId === sessionId && (w.status === "failed" || w.status === "dead_letter")) ids.add(w.id);
    }
    return ids;
  }, [hasOperations, ops.report, sessionId]);

  const run = useCallback(
    async (key: string, path: string, body?: unknown) => {
      setBusy(key);
      setError(null);
      try {
        await api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), silentErrors: true });
        if (hasOperations) void queryClient.invalidateQueries({ queryKey: ["/v1/operations"] });
        return true;
      } catch (err) {
        setError(err instanceof Error ? failureSentence(err) : "The action was not completed.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, queryClient, hasOperations],
  );

  const decide = useCallback(
    (toolUseId: string, result: "allow" | "deny", opts: DecideOptions = {}) => {
      const reason = result === "deny" ? opts.denyMessage?.trim() : undefined;
      const thread = opts.threadId && opts.threadId !== PRIMARY_THREAD ? opts.threadId : undefined;
      if (hasOperations && !reason && !thread) {
        return run(`${result}:${toolUseId}`, `/v1/operations/sessions/${sessionId}/approvals`, { tool_use_id: toolUseId, result });
      }
      return run(`${result}:${toolUseId}`, `/v1/sessions/${sessionId}/events`, {
        events: [
          {
            type: "user.tool_confirmation",
            tool_use_id: toolUseId,
            result,
            ...(reason ? { deny_message: reason } : {}),
            ...(thread ? { session_thread_id: thread } : {}),
          },
        ],
      });
    },
    [run, sessionId, hasOperations],
  );
  const retry = useCallback((workItemId: string) => run(`retry:${workItemId}`, `/v1/operations/work-items/${workItemId}/retry`), [run]);

  return {
    canOperate,
    /** False while permissions are still loading: do not flash "no access". */
    accessKnown: featuresKnown && (!hasAccess || !!access.data || !!access.error),
    /** The permissions read failed. That is not "no access": say it could
     *  not be checked and offer `recheckAccess`. */
    accessFailed: hasAccess && !!access.error && !access.data,
    recheckAccess: () => void access.refetch(),
    busy,
    error,
    clearError: () => setError(null),
    decide,
    retry,
    retryable,
    attention: sessionId && hasOperations ? ops.attention.get(sessionId) : undefined,
  };
}

export type SessionOperations = ReturnType<typeof useSessionOperations>;
