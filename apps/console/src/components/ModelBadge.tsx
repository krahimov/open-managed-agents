import { describeModel, PROVIDER_COLOR } from "@/lib/models";
import { cn } from "@/lib/utils";

import { Tip } from "./Tip";

/**
 * A model, as people say it: a provider mark and a short name
 * ("Opus 4.8", "GPT-5.5 mini"). The raw model id and provider are in the
 * tooltip.
 *
 *   <ModelBadge model={agent.model} />            chip (cards, headers)
 *   <ModelBadge model={agent.model} variant="plain" />   inline text (table cells)
 *
 * The provider mark is a small coloured disc. Its colour matches that
 * provider's series in the usage charts, so the two reinforce each other.
 */
export function ModelBadge({
  model,
  variant = "chip",
  className,
}: {
  model: string | { id: string; speed?: string } | null | undefined;
  variant?: "chip" | "plain";
  className?: string;
}) {
  const info = describeModel(model);
  if (!info.id) return <span className={cn("text-fg-subtle", className)}>No model</span>;
  const speed = model && typeof model !== "string" && model.speed && model.speed !== "standard" ? model.speed : null;
  return (
    <Tip
      label={
        <span>
          {info.providerLabel} · <span className="font-mono">{info.id}</span>
          {speed ? ` · ${speed}` : ""}
        </span>
      }
    >
      <span
        className={cn(
          "inline-flex max-w-full shrink-0 items-center gap-1.5 text-xs leading-none font-medium whitespace-nowrap",
          variant === "chip" ? "h-[22px] rounded-full bg-bg-soft px-2 text-fg-muted" : "text-small-size text-fg-muted",
          className,
        )}
      >
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: PROVIDER_COLOR[info.provider] }}
        />
        <span className="truncate">{info.label}</span>
      </span>
    </Tip>
  );
}
