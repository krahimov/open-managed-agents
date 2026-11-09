import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import {
  DEFAULT_REASONING_LEVEL,
  REASONING_LEVEL_LABELS,
  UI_REASONING_LEVELS,
  modelSupportsReasoning,
  uiReasoningLevel,
  type ModelCard,
  type ReasoningLevel,
  type UiReasoningLevel,
} from "@open-managed-agents/api-types";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * Model + reasoning switcher (T3-Code-style composer picker): a compact chip
 * ("Opus 5.5 · High") that opens a two-column popover — the tenant's model
 * cards grouped by provider on the left, the five reasoning levels on the
 * right. Purely presentational: callers own persistence (agent version via
 * POST /v1/agents/:id, or the per-session override via session metadata).
 */

const PROVIDER_GROUPS: Array<{ provider: string; label: string }> = [
  { provider: "ant", label: "Anthropic" },
  { provider: "oai", label: "OpenAI" },
  { provider: "ant-compatible", label: "Anthropic-compatible" },
  { provider: "oai-compatible", label: "OpenAI-compatible" },
];

const PROVIDER_ACRONYMS: Record<string, string> = { gpt: "GPT" };

/** "claude-opus-5-5" → "Opus 5.5", "claude-fable-5-1" → "Fable 5.1",
 *  "gpt-6.1-sol" → "GPT-6.1 Sol", "o3" → "o3". Unknown shapes pass
 *  through unchanged. */
export function prettyModelName(model: string): string {
  const bare = model.includes("/") ? model.split("/").slice(1).join("/") : model;
  const claude = /^claude-([a-z]+)-(\d{1,2})(?:[-.](\d{1,2}))?(?=$|-)/i.exec(bare);
  if (claude) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
    return `${family} ${claude[2]}${claude[3] !== undefined ? `.${claude[3]}` : ""}`;
  }
  const gpt = /^(gpt)-(\d+(?:\.\d+)?)(?:-(.+))?$/i.exec(bare);
  if (gpt) {
    const suffix = gpt[3]
      ? " " +
        gpt[3]
          .split("-")
          .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(" ")
      : "";
    return `${PROVIDER_ACRONYMS[gpt[1]!.toLowerCase()] ?? gpt[1]}-${gpt[2]}${suffix}`;
  }
  return bare;
}

/** Display name for a card: the pretty wire model when the handle is the
 *  model itself, otherwise the tenant's own handle. */
export function cardDisplayName(card: Pick<ModelCard, "model_id" | "model">): string {
  return card.model_id === card.model ? prettyModelName(card.model) : card.model_id;
}

export interface ModelReasoningValue {
  /** Model-card handle (`model_id`) — what `agent.model` stores. */
  model: string;
  level: ReasoningLevel | undefined;
}

export interface ModelReasoningPickerProps {
  cards: ModelCard[];
  value: ModelReasoningValue;
  /** The agent's configured values — tagged "Default" in the lists. When
   *  omitted, Medium is the default level and no model is tagged. */
  defaults?: Partial<ModelReasoningValue>;
  onChange: (next: ModelReasoningValue) => void;
  disabled?: boolean;
  /** Shown while the caller persists a change. */
  saving?: boolean;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom";
  className?: string;
}

export function ModelReasoningPicker({
  cards,
  value,
  defaults,
  onChange,
  disabled,
  saving,
  align = "end",
  side = "top",
  className,
}: ModelReasoningPickerProps) {
  const [open, setOpen] = useState(false);
  const selectedCard = cards.find((c) => c.model_id === value.model);
  const supportsReasoning = selectedCard
    ? modelSupportsReasoning(selectedCard.provider, selectedCard.model)
    : false;
  const level = uiReasoningLevel(value.level);
  const defaultLevel: UiReasoningLevel = uiReasoningLevel(defaults?.level ?? DEFAULT_REASONING_LEVEL);

  const groups = useMemo(() => {
    const known = new Set(PROVIDER_GROUPS.map((g) => g.provider));
    const out = PROVIDER_GROUPS.map((g) => ({
      ...g,
      cards: cards.filter((c) => c.provider === g.provider),
    }));
    const other = cards.filter((c) => !known.has(c.provider));
    if (other.length) out.push({ provider: "other", label: "Other", cards: other });
    return out.filter((g) => g.cards.length > 0);
  }, [cards]);

  const chipModel = selectedCard ? cardDisplayName(selectedCard) : value.model ? prettyModelName(value.model) : "Model";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model and reasoning: ${chipModel}${supportsReasoning ? ` ${REASONING_LEVEL_LABELS[level]}` : ""}`}
          data-testid="model-reasoning-chip"
          className={cn(
            "inline-flex h-7 max-w-[260px] items-center gap-1 rounded-md px-2 text-[12px] font-medium text-fg-muted",
            "hover:bg-muted hover:text-fg aria-expanded:bg-muted aria-expanded:text-fg",
            "outline-none focus-visible:ring-2 focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">{chipModel}</span>
          {supportsReasoning && (
            <span className="shrink-0 text-fg-subtle">{REASONING_LEVEL_LABELS[level]}</span>
          )}
          {saving ? (
            <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-brand" aria-hidden />
          ) : (
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" aria-hidden />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        className="w-[440px] max-w-[calc(100vw-24px)] flex-row gap-0 p-0 text-[13px]"
      >
        <div className="max-h-[320px] min-w-0 flex-1 overflow-y-auto border-r border-border py-1" role="listbox" aria-label="Model">
          {groups.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-fg-subtle">
              No model cards.{" "}
              <a href="/model-cards" className="underline hover:text-fg-muted">
                Add one
              </a>
            </div>
          )}
          {groups.map((g) => (
            <div key={g.provider} className="py-0.5">
              <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
                {g.label}
              </div>
              {g.cards.map((card) => {
                const selected = card.model_id === value.model;
                return (
                  <button
                    key={card.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      if (!selected) onChange({ model: card.model_id, level: value.level });
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted",
                      selected && "text-fg",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {cardDisplayName(card)}
                      {card.model_id !== card.model && (
                        <span className="ml-1 text-[11px] text-fg-subtle">{card.model}</span>
                      )}
                    </span>
                    {defaults?.model === card.model_id && (
                      <span className="shrink-0 text-[11px] text-fg-subtle">Default</span>
                    )}
                    <CheckIcon
                      className={cn("size-3.5 shrink-0 text-brand", !selected && "invisible")}
                      aria-hidden
                    />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="w-[150px] shrink-0 py-1" role="listbox" aria-label="Reasoning">
          <div className="px-3 pb-0.5 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-fg-subtle">
            Reasoning
          </div>
          {UI_REASONING_LEVELS.map((l) => {
            const selected = l === level;
            return (
              <button
                key={l}
                type="button"
                role="option"
                aria-selected={selected}
                disabled={!supportsReasoning}
                onClick={() => {
                  setOpen(false);
                  if (!selected) onChange({ model: value.model, level: l });
                }}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1 text-left hover:bg-muted disabled:pointer-events-none disabled:opacity-40",
                  selected && "text-fg",
                )}
              >
                <span className="flex-1">{REASONING_LEVEL_LABELS[l]}</span>
                {l === defaultLevel && <span className="text-[11px] text-fg-subtle">Default</span>}
                <CheckIcon
                  className={cn("size-3.5 shrink-0 text-brand", !selected && "invisible")}
                  aria-hidden
                />
              </button>
            );
          })}
          {selectedCard && !supportsReasoning && (
            <p className="px-3 pt-1.5 text-[11px] leading-snug text-fg-subtle">
              This model doesn't take a reasoning level.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
