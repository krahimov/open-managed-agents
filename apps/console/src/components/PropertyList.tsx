import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Label–value facts about a record. Replaces the "key: value dump".
 *
 *   <PropertyList>
 *     <Property label="Model"><ModelBadge model={agent.model} /></Property>
 *     <Property label="Environment"><EntityRef kind="environment" id={envId} /></Property>
 *     <Property label="Created"><RelativeTime value={agent.created_at} /></Property>
 *     <Property label="Agent id"><IdChip id={agent.id} full /></Property>
 *   </PropertyList>
 *
 * Rules:
 *   - Values are components, not raw strings: a reference is an <EntityRef>,
 *     a time a <RelativeTime>, an id an <IdChip>, a model a <ModelBadge>.
 *   - An empty value renders a muted "None" / "Not set" — pass `empty`.
 *   - `columns={2}` for wide cards with many short facts.
 *   - `labelWidth="narrow"` in an aside or a side panel.
 *   - A reference whose name is longer than its cell takes a second line
 *     (a 340px aside cut "Cloud sandbox — Node 22 + Python 3.12" at
 *     "Cloud sandbox — Node …"); past two lines it ends in an ellipsis and
 *     the tooltip has the rest.
 *   - Long text (system prompt, description) is NOT a property: give it its
 *     own SectionCard.
 */
export function PropertyList({
  children,
  columns = 1,
  labelWidth = "default",
  className,
}: {
  children: ReactNode;
  columns?: 1 | 2;
  /** `narrow` for a 340px aside or a side panel, where the default label
   *  column would squeeze every value. */
  labelWidth?: "default" | "narrow";
  className?: string;
}) {
  return (
    <dl
      className={cn(
        "grid gap-x-10 gap-y-0.5",
        // A long reference wraps to two lines here instead of truncating on one.
        "[&_dd_[data-ref-label]]:line-clamp-2 [&_dd_[data-ref-label]]:leading-snug [&_dd_[data-ref-label]]:break-words [&_dd_[data-ref-label]]:whitespace-normal",
        columns === 2 ? "sm:grid-cols-2" : "grid-cols-1",
        labelWidth === "narrow" && "[&>div]:grid-cols-[6.5rem_minmax(0,1fr)]",
        className,
      )}
    >
      {children}
    </dl>
  );
}

export function Property({
  label,
  children,
  empty,
  align = "center",
  className,
}: {
  label: ReactNode;
  children?: ReactNode;
  /** Shown (muted) when there are no children: "None", "Not set". */
  empty?: string;
  /** `start` for multi-line values. */
  align?: "center" | "start";
  className?: string;
}) {
  const isEmpty = children == null || children === false || children === "";
  return (
    <div
      className={cn(
        "grid min-h-9 grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)] gap-4 py-1.5",
        align === "center" ? "items-center" : "items-start",
        className,
      )}
    >
      <dt className="text-small text-fg-subtle">{label}</dt>
      <dd className="min-w-0 text-small text-fg">
        {isEmpty ? <span className="text-fg-subtle">{empty ?? "None"}</span> : children}
      </dd>
    </div>
  );
}
