import { useCallback, useEffect, useMemo, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { useApi } from "@/lib/api";
import { useOperations } from "@/lib/directory";
import type { WorkspaceAccess } from "@/lib/operations";
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

/**
 * What a person can do to a session that is stuck on them: decide a tool
 * approval, or retry a failed turn. Both go through the operations
 * endpoints the Operations page already uses, so the two screens can never
 * disagree; deciding here refreshes the shared operations report (sidebar
 * count, Home's attention strip).
 */
export function useSessionOperations(sessionId: string | undefined) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const access = useApiQuery<WorkspaceAccess>("/v1/workspace/access", undefined, { staleTime: 5 * 60_000 });
  const ops = useOperations();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canOperate = !!access.data?.authorization && access.data.authorization.role !== "viewer";

  /** Failed work items of this session, by id: the turns that can be retried. */
  const retryable = useMemo(() => {
    const ids = new Set<string>();
    for (const w of ops.report?.work_items ?? []) {
      if (w.sessionId === sessionId && (w.status === "failed" || w.status === "dead_letter")) ids.add(w.id);
    }
    return ids;
  }, [ops.report, sessionId]);

  const run = useCallback(
    async (key: string, path: string, body?: unknown) => {
      setBusy(key);
      setError(null);
      try {
        await api(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body), silentErrors: true });
        void queryClient.invalidateQueries({ queryKey: ["/v1/operations"] });
        return true;
      } catch (err) {
        setError(err instanceof Error ? failureSentence(err) : "The action was not completed.");
        return false;
      } finally {
        setBusy(null);
      }
    },
    [api, queryClient],
  );

  const decide = useCallback(
    (toolUseId: string, result: "allow" | "deny") =>
      run(`${result}:${toolUseId}`, `/v1/operations/sessions/${sessionId}/approvals`, { tool_use_id: toolUseId, result }),
    [run, sessionId],
  );
  const retry = useCallback((workItemId: string) => run(`retry:${workItemId}`, `/v1/operations/work-items/${workItemId}/retry`), [run]);

  return {
    canOperate,
    /** False while permissions are still loading: do not flash "no access". */
    accessKnown: !!access.data || !!access.error,
    /** The permissions read failed. That is not "no access": say it could
     *  not be checked and offer `recheckAccess`. */
    accessFailed: !!access.error && !access.data,
    recheckAccess: () => void access.refetch(),
    busy,
    error,
    clearError: () => setError(null),
    decide,
    retry,
    retryable,
    attention: sessionId ? ops.attention.get(sessionId) : undefined,
  };
}

export type SessionOperations = ReturnType<typeof useSessionOperations>;
