import { CircleAlertIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { failureSentence } from "@/lib/failure-text";

/**
 * A lookup inside the session options could not be loaded: what it was, the
 * server's reason, and "Try again" in place. It stands where the choices
 * would have been, so a failed lookup is never drawn as an empty one.
 *
 *   <LookupProblem what="Files" error={query.error} retry={query.refetch} />
 *
 * Unlike `<QueryProblem compact>` (one line, for a card or a toolbar) this
 * one wraps, because it sits in a form column or a dropdown that can be
 * 200px wide.
 */
export function LookupProblem({
  what,
  error,
  retry,
  className,
}: {
  /** Plural noun: "Files could not be loaded". */
  what: string;
  error: unknown;
  retry: () => unknown;
  className?: string;
}) {
  const message = error ? failureSentence(error) : "";
  return (
    <div role="alert" className={cn("flex items-start gap-2.5 rounded-lg bg-danger-subtle px-3 py-2.5 text-small", className)}>
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-fg">{what} could not be loaded</p>
        {message && <p className="mt-0.5 break-words text-fg-muted">{message}</p>}
        <Button variant="outline" size="xs" className="mt-2" onClick={() => void retry()}>
          Try again
        </Button>
      </div>
    </div>
  );
}
