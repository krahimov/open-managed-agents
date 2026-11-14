import { useMemo, useState } from "react";
import { Link } from "react-router";
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
import { inlineLink } from "@/lib/links";
import { cn } from "@/lib/utils";

/**
 * Model and reasoning, as one chip: "Opus 5.5 · High". It opens a
 * two-column popover: the workspace's model keys grouped by provider on the
 * left, the five reasoning levels on the right, each with the value that
 * applies when nothing is chosen marked "Default".
 *
 * Purely presentational. Callers own persistence: the agent page saves a
 * new agent version (AgentModelSwitcher), a session saves an override for
 * its next turns (SessionModelPicker).
 *
 * An unset level reads as Medium, which is what the server runs; the
 * legacy "Instant" some older agents carry reads as Low, its nearest level.
 */

const PROVIDER_GROUPS: Array<{ provider: string; label: string }> = [
  { provider: "ant", label: "Anthropic" },
  { provider: "oai", label: "OpenAI" },
  { provider: "ant-compatible", label: "Anthropic-compatible" },
  { provider: "oai-compatible", label: "OpenAI-compatible" },
];

const ACRONYMS: Record<string, string> = { gpt: "GPT" };

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
    return `${ACRONYMS[gpt[1]!.toLowerCase()] ?? gpt[1]}-${gpt[2]}${suffix}`;
  }
  return bare;
}

/** How a model key is named: the model as people say it when the handle is
 *  the model itself, otherwise the workspace's own handle. */
export function cardDisplayName(card: Pick<ModelCard, "model_id" | "model">): string {
  return card.model_id === card.model ? prettyModelName(card.model) : card.model_id;
}

export interface ModelReasoningValue {
  /** Model-key handle (`model_id`): what `agent.model` stores. */
  model: string;
  level: ReasoningLevel | undefined;
}

export interface ModelReasoningPickerProps {
  cards: ModelCard[];
  value: ModelReasoningValue;
  /** What applies when nothing is chosen, marked "Default" in the lists.
   *  Without it Medium is the default level and no model is marked. */
  defaults?: Partial<ModelReasoningValue>;
  onChange: (next: ModelReasoningValue) => void;
  disabled?: boolean;
  /** Shown while the caller saves a change. */
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
  const supportsReasoning = selectedCard ? modelSupportsReasoning(selectedCard.provider, selectedCard.model) : false;
  const level = uiReasoningLevel(value.level);
  const defaultLevel: UiReasoningLevel = uiReasoningLevel(defaults?.level ?? DEFAULT_REASONING_LEVEL);

  const groups = useMemo(() => {
    const known = new Set(PROVIDER_GROUPS.map((g) => g.provider));
    const out = PROVIDER_GROUPS.map((g) => ({ ...g, cards: cards.filter((c) => c.provider === g.provider) }));
    const other = cards.filter((c) => !known.has(c.provider));
    if (other.length) out.push({ provider: "other", label: "Other", cards: other });
    return out.filter((g) => g.cards.length > 0);
  }, [cards]);

  const chipModel = selectedCard ? cardDisplayName(selectedCard) : value.model ? prettyModelName(value.model) : "Model";
  const levelLabel = REASONING_LEVEL_LABELS[level];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`Model and reasoning: ${chipModel}${supportsReasoning ? `, ${levelLabel}` : ""}`}
          data-testid="model-reasoning-chip"
          className={cn(
            "inline-flex h-9 max-w-[16rem] min-w-0 shrink-0 items-center gap-1.5 rounded-full px-3 text-small-size font-medium text-fg-muted transition-quick",
            "outline-none hover:bg-bg-hover hover:text-fg focus-visible:shadow-[var(--shadow-focus)] aria-expanded:bg-bg-hover aria-expanded:text-fg",
            "disabled:pointer-events-none disabled:opacity-50",
            className,
          )}
        >
          <span className="truncate">{chipModel}</span>
          {supportsReasoning && (
            <>
              <span aria-hidden="true" className="text-fg-faint">
                ·
              </span>
              <span className="shrink-0 text-fg-subtle">{levelLabel}</span>
            </>
          )}
          {saving ? (
            <span className="live-dot size-1.5 shrink-0 rounded-full bg-plum text-plum" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align={align}
        side={side}
        sideOffset={8}
        className="w-[30rem] max-w-[calc(100vw-1.5rem)] flex-row gap-0 overflow-hidden p-0"
      >
        <div role="listbox" aria-label="Model" className="max-h-80 min-w-0 flex-1 overflow-y-auto p-1.5">
          {groups.length === 0 && (
            <p className="px-2.5 py-3 text-small text-fg-subtle">
              This workspace has no model keys yet.{" "}
              <Link to="/model-cards" className={inlineLink} onClick={() => setOpen(false)}>
                Add one
              </Link>
              .
            </p>
          )}
          {groups.map((g) => (
            <div key={g.provider} className="pb-1 last:pb-0">
              <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">{g.label}</div>
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
                      "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-small-size transition-quick hover:bg-bg-hover",
                      selected ? "text-fg" : "text-fg-muted",
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {cardDisplayName(card)}
                      {card.model_id !== card.model && (
                        <span className="ml-1.5 font-mono text-micro-size text-fg-subtle">{card.model}</span>
                      )}
                    </span>
                    {defaults?.model === card.model_id && (
                      <span className="shrink-0 text-xs text-fg-subtle">Default</span>
                    )}
                    <CheckIcon className={cn("size-4 shrink-0 text-fg", !selected && "invisible")} aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div role="listbox" aria-label="Reasoning" className="w-[11.5rem] shrink-0 border-l border-border bg-bg-inset/60 p-1.5">
          <div className="px-2.5 pt-1.5 pb-1 text-xs font-medium text-fg-subtle">Reasoning</div>
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
                  "flex h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-small-size transition-quick hover:bg-bg-hover disabled:pointer-events-none disabled:opacity-50",
                  selected ? "text-fg" : "text-fg-muted",
                )}
              >
                <span className="flex-1">{REASONING_LEVEL_LABELS[l]}</span>
                {l === defaultLevel && <span className="text-xs text-fg-subtle">Default</span>}
                <CheckIcon className={cn("size-4 shrink-0 text-fg", !selected && "invisible")} aria-hidden="true" />
              </button>
            );
          })}
          {selectedCard && !supportsReasoning && (
            <p className="px-2.5 pt-1.5 pb-1 text-xs text-fg-subtle">This model doesn't take a reasoning level.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
