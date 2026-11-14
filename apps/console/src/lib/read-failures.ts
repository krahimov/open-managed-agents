import { toast } from "sonner";

import { failureSentence } from "./failure-text";
import { queryClient } from "./query-client";

/**
 * What happens when a READ fails.
 *
 * A failed read is drawn where its data would have been: the list says
 * "could not be loaded" with a way to try again (<QueryProblem>, the
 * sidebar's lists, a picker's own line). That is the report. A toast on top
 * of it says the same thing twice, and used to say it in the server's bare
 * words ("unavailable"), once per attempt.
 *
 * So a read never toasts by itself. It calls `reportReadFailure`, which
 * waits a moment for the page to draw the failure (and for any read that
 * is on its second attempt to finish, since its notice is not up yet) and
 * then looks: when something on screen already reports a failed read,
 * nothing more is said.
 * Only a failure nobody drew raises a toast, one for the whole burst, in a
 * full sentence. That toast is the safety net for a screen that forgot to
 * draw its own failure; it should be rare.
 *
 * To count as an in-place report an element carries the
 * `data-read-problem` attribute (spread `READ_PROBLEM` on it: the
 * sidebar's and the palette's one-line "Could not load"), or is an alert
 * that says something "could not be loaded", which is how every
 * <QueryProblem> is titled. A warning or a failed save is also an alert,
 * and is not a report of a failed read.
 *
 * Writes are not handled here: a failed write always tells the person, at
 * once (lib/api.ts).
 */

/** Put this attribute on a quiet in-place notice that a read failed. */
export const READ_PROBLEM = { "data-read-problem": "" } as const;

const REPORTED_IN_PLACE = '[role="alert"], [data-read-problem]';
// No word boundary at the end: an element's text runs its lines together ("…could not be loadedunavailable").
const SAYS_NOT_LOADED = /could not (be )?(load|read)/i;

function reportsAFailedRead(el: Element): boolean {
  if (el.closest("[data-sonner-toaster]")) return false;
  return el.hasAttribute("data-read-problem") || SAYS_NOT_LOADED.test(el.textContent ?? "");
}
/** Long enough for the failed state to render, short enough to feel like the same moment. */
const SETTLE_MS = 400;
const TOAST_ID = "read-failure";

let timer: ReturnType<typeof setTimeout> | undefined;
let latest: unknown;

/** A query on its second attempt: its failure, if it comes, is not on screen yet. */
function readsStillRetrying(): boolean {
  return (
    queryClient
      .getQueryCache()
      .findAll({ predicate: (q) => q.state.fetchStatus === "fetching" && q.state.fetchFailureCount > 0 }).length > 0
  );
}

function settle(waited: number): void {
  // Give a retry up to five seconds to land before deciding.
  if (readsStillRetrying() && waited < 5000) {
    timer = setTimeout(() => settle(waited + SETTLE_MS), SETTLE_MS);
    return;
  }
  timer = undefined;
  if (typeof document !== "undefined") {
    if ([...document.querySelectorAll(REPORTED_IN_PLACE)].some(reportsAFailedRead)) return;
  }
  toast.error("Part of this page could not be loaded", { id: TOAST_ID, description: failureSentence(latest) });
}

export function reportReadFailure(error: unknown): void {
  latest = error;
  if (timer !== undefined) return;
  timer = setTimeout(() => settle(0), SETTLE_MS);
}
