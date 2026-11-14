import { CircleAlertIcon, RotateCwIcon } from "lucide-react";

import { failureSentence } from "@/lib/failure-text";
import { cn } from "@/lib/utils";

import { Button } from "./ui/button";

/**
 * Something failed to load. The block says WHAT could not be loaded (the
 * title), WHY in a sentence (`failureSentence`: the server's message when it
 * reads as one, otherwise what kind of failure it was, never a bare token
 * like "unavailable"), and offers a retry. It replaces the
 * content it stands in for: never show an empty state for a failed read.
 *
 *   {query.error && <QueryProblem title="Sessions could not be loaded" error={query.error} retry={query.refetch} />}
 *
 * `compact` is a single row for use inside a card or a toolbar.
 * Exported again as <ErrorState> for readability at call sites.
 */
export function QueryProblem({
  title,
  error,
  retry,
  compact,
  className,
}: {
  title: string;
  error: unknown;
  retry?: () => unknown;
  compact?: boolean;
  className?: string;
}) {
  const message = error === null || error === undefined || error === "" ? "" : failureSentence(error);
  if (compact) {
    return (
      <div role="alert" className={cn("flex items-center gap-2.5 rounded-lg bg-danger-subtle px-3 py-2 text-small", className)}>
        <CircleAlertIcon className="size-4 shrink-0 text-danger" />
        <p className="min-w-0 flex-1 truncate text-fg">
          <span className="font-medium">{title}</span>
          {message && <span className="text-fg-muted"> · {message}</span>}
        </p>
        {retry && (
          <Button variant="ghost" size="xs" onClick={() => void retry()}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={cn("flex items-start gap-3.5 rounded-xl border border-danger/15 bg-danger-subtle/70 p-5 text-sm", className)}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-bg-surface text-danger shadow-[var(--shadow-xs)] dark:bg-bg-soft">
        <CircleAlertIcon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{title}</p>
        {message && <p className="mt-0.5 break-words text-fg-muted">{message}</p>}
        {retry && (
          <Button variant="outline" size="sm" className="mt-3" onClick={() => void retry()}>
            <RotateCwIcon />
            Try again
          </Button>
        )}
      </div>
    </div>
  );
}

export { QueryProblem as ErrorState };
