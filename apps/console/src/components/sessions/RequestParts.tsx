import type { ComponentType, ReactNode } from "react";
import { CircleCheckIcon } from "lucide-react";

/**
 * The resting states of a request an agent made of a person (access to an
 * app, a skill), shared by the two request cards.
 *
 *   NEEDS_YOU_CARD   the treatment of every card that is waiting on a
 *                    person: a tool approval, an access request, a skill
 *                    request. Amber, from two tokens in index.css
 *                    (`--needs-you-bg`, `--needs-you-border`), so three of
 *                    them in a row in dark read as three notices rather
 *                    than three slabs of brown.
 *   <AnsweredRequest>  it was answered: one quiet line, like a finished tool call.
 *   <PassedRequest>    the person replied without answering it: a neutral
 *                      row. The way to answer is still there, as a quiet
 *                      button; nothing is waiting on it.
 */
export const NEEDS_YOU_CARD = "needs-you-card";

export function AnsweredRequest({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-10 animate-fade-in items-center gap-2.5 rounded-lg bg-bg-soft px-3 py-2 text-small">
      <CircleCheckIcon className="size-4 shrink-0 text-success" />
      <p className="min-w-0 flex-1 text-fg-muted">{children}</p>
    </div>
  );
}

export function PassedRequest({
  icon: Icon,
  title,
  note,
  action,
}: {
  icon: ComponentType<{ className?: string }>;
  title: string;
  /** Why the agent wanted it. */
  note?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-bg-soft py-2 pr-2 pl-3 text-small">
      <Icon className="size-4 shrink-0 text-fg-subtle" />
      <div className="min-w-0 flex-1 basis-56">
        <p className="font-medium text-fg">{title}</p>
        <p className="text-xs text-fg-muted">
          {note ? `${note.replace(/[.\s]+$/, "")}. ` : ""}
          Not answered: you replied instead, and the agent carried on without it.
        </p>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
