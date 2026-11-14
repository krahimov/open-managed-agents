import { CheckIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Progress through a wizard (create agent, connect an integration, first
 * run). A row of numbered steps; done steps show a check and are clickable
 * when `onStepClick` is given.
 *
 *   <Steps steps={["Template", "Model", "Tools", "Review"]} current={1} onStepClick={setStep} />
 *
 * Two to five steps. A two-field form is not a wizard.
 */
export function Steps({
  steps,
  current,
  onStepClick,
  className,
}: {
  steps: string[];
  /** Zero-based index of the active step. */
  current: number;
  /** Allow jumping back to a completed step. */
  onStepClick?: (index: number) => void;
  className?: string;
}) {
  return (
    <ol className={cn("flex items-center gap-2", className)} aria-label="Progress">
      {steps.map((label, i) => {
        const done = i < current;
        const active = i === current;
        const clickable = done && !!onStepClick;
        const inner = (
          <>
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-micro-size font-semibold transition-quick",
                active && "bg-ink text-on-ink",
                done && "bg-bg-pressed text-fg",
                !active && !done && "border border-border-strong text-fg-subtle",
              )}
            >
              {done ? <CheckIcon className="size-3.5 stroke-[2.5]" /> : i + 1}
            </span>
            <span className={cn("text-small-size font-medium whitespace-nowrap", active ? "text-fg" : "text-fg-muted")}>
              {label}
            </span>
          </>
        );
        return (
          <li key={label} className="flex min-w-0 items-center gap-2" aria-current={active ? "step" : undefined}>
            {clickable ? (
              <button
                type="button"
                onClick={() => onStepClick!(i)}
                className="flex items-center gap-2 rounded-full pr-2 transition-quick hover:bg-bg-hover"
              >
                {inner}
              </button>
            ) : (
              <span className="flex items-center gap-2 pr-2">{inner}</span>
            )}
            {i < steps.length - 1 && <span aria-hidden="true" className="h-px w-6 shrink-0 bg-border-strong sm:w-10" />}
          </li>
        );
      })}
    </ol>
  );
}
