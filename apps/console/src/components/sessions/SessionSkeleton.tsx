import { cn } from "@/lib/utils";

import { Skeleton, SkeletonText } from "../Skeleton";

/**
 * A conversation while it loads: the shape of a first exchange (a bubble
 * on the right, an agent header, two tool rows, a paragraph) in the same
 * 720px column the real turns use, so nothing jumps when events arrive.
 */
export function ConversationSkeleton({ className }: { className?: string }) {
  return (
    <div className={cn("mx-auto w-full max-w-[720px] space-y-6", className)} aria-hidden="true">
      <div className="flex justify-end">
        <Skeleton className="h-16 w-[62%]" rounded="xl" />
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6" rounded="md" />
          <Skeleton className="h-3.5 w-36" rounded="sm" />
        </div>
        <Skeleton className="h-10 w-full" rounded="lg" />
        <Skeleton className="h-10 w-full" rounded="lg" />
        <SkeletonText lines={4} className="pt-1" />
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-11 w-[38%]" rounded="xl" />
      </div>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Skeleton className="size-6" rounded="md" />
          <Skeleton className="h-3.5 w-36" rounded="sm" />
        </div>
        <SkeletonText lines={3} />
      </div>
    </div>
  );
}

/** The context panel while the session record loads. */
export function ContextPanelSkeleton({ className }: { className?: string }) {
  return (
    <aside className={cn("w-[320px] shrink-0 border-l border-border bg-bg", className)} aria-hidden="true">
      <div className="space-y-7 px-5 pt-5">
        {[0, 1, 2, 3].map((g) => (
          <div key={g} className="space-y-3">
            <Skeleton className="h-2.5 w-16" rounded="sm" />
            <div className="flex items-center gap-2.5">
              <Skeleton className="size-8" rounded="lg" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3.5" rounded="sm" style={{ width: `${70 - g * 9}%` }} />
                <Skeleton className="h-2.5 w-2/5" rounded="sm" />
              </div>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}
