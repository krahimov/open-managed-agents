import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { PencilIcon, RotateCcwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  FACE_GLYPHS,
  FACE_GROUPS,
  FACE_TINTS,
  INITIALS_GLYPH,
  describeFace,
  faceGlyph,
  formatFace,
  parseFace,
  previewFace,
  tintClass,
  type AgentFace,
  type FaceTint,
} from "@/lib/agent-face";
import { useAgents } from "@/lib/directory";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

import { AgentAvatar } from "../AgentAvatar";
import { Tip } from "../Tip";
import { ScrollFade } from "./ScrollFade";

const COLUMNS = 8;

/** The glyphs under their family, in the order the picker lists them. */
const GROUPS = FACE_GROUPS.map((group) => ({ label: group, glyphs: FACE_GLYPHS.filter((glyph) => glyph.group === group) }));

/**
 * The avatar of an agent, as a button that opens a picker: a symbol, a
 * colour, or "Automatic" (read from the name, as every agent starts).
 *
 *   <AvatarPicker value={form.avatar} onChange={(avatar) => setForm({ ...form, avatar })}
 *     name={form.name} description={form.description} />
 *
 * `value` is what is stored in `metadata.avatar`: `""` for automatic, or
 * `"<glyph>:<tint>"`. The button always shows the face the agent will
 * wear in this workspace, so it changes as the name is typed.
 */
export function AvatarPicker({
  value,
  onChange,
  name,
  description,
  agentId,
  createdAt,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  name: string;
  description?: string;
  /** The agent being edited. Leave out for an agent that does not exist yet. */
  agentId?: string;
  createdAt?: string;
  className?: string;
}) {
  const { agents } = useAgents();
  const [open, setOpen] = useState(false);
  const grid = useRef<HTMLDivElement>(null);

  const choice = parseFace(value);
  const face = useMemo(
    () =>
      previewFace(agents, {
        id: agentId,
        name,
        description,
        created_at: createdAt,
        metadata: value ? { avatar: value } : undefined,
      }),
    [agents, agentId, name, description, createdAt, value],
  );
  const letters = initials(name || "Agent");
  // Before there is a name there is nothing to read and no initials to draw:
  // the button wears a robot until the first letters arrive. Never stored.
  const unnamed = !name.trim() && !value;
  const shown: AgentFace = unnamed ? { glyph: faceGlyph("bot"), tint: face.tint, source: "initials" } : face;
  const selectedGlyph = unnamed ? "" : (face.glyph?.id ?? INITIALS_GLYPH);
  // The grid is one tab stop: the symbol in use, or the first one when none is (initials, no name yet).
  const tabStop = face.glyph && !unnamed ? face.glyph.id : FACE_GLYPHS[0].id;

  const setGlyph = (glyph: string) => onChange(formatFace({ glyph, tint: choice?.tint ?? null }));
  const setTint = (tint: FaceTint) => onChange(formatFace({ glyph: choice?.glyph ?? null, tint }));

  // One tab stop for the whole grid; the arrow keys move inside it.
  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : e.key === "ArrowDown" ? COLUMNS : e.key === "ArrowUp" ? -COLUMNS : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    const cells = Array.from(grid.current?.querySelectorAll<HTMLButtonElement>("button[data-glyph]") ?? []);
    const at = cells.indexOf(document.activeElement as HTMLButtonElement);
    if (at === -1) return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? cells.length - 1 : Math.max(0, Math.min(cells.length - 1, at + step));
    cells[next]?.focus();
  };

  const how = !value
    ? face.source === "derived"
      ? "Read from the agent's name"
      : "The name suggests no symbol yet"
    : choice?.glyph
      ? "Chosen for this agent"
      : "Symbol from the name, colour chosen";

  const cell = (id: string, label: string, content: React.ReactNode) => {
    const selected = selectedGlyph === id;
    return (
      <Tip key={id} label={label} delay={350}>
        <button
          type="button"
          role="radio"
          aria-checked={selected}
          aria-label={label}
          data-glyph={id}
          tabIndex={id === tabStop ? 0 : -1}
          onClick={() => setGlyph(id)}
          className={cn(
            "flex size-8 items-center justify-center rounded-[9px] text-micro-size font-semibold tracking-tight transition-quick focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-plum",
            selected
              ? `${tintClass(face.tint)} bg-[var(--tint-bg)] text-[var(--tint-fg)] shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--tint-fg)_55%,transparent)]`
              : "text-fg-muted hover:bg-bg-hover hover:text-fg",
          )}
        >
          {content}
        </button>
      </Tip>
    );
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Change avatar">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`Avatar: ${describeFace(face)}. Change`}
            className={cn(
              "group/avatar relative shrink-0 rounded-[11px] transition-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-plum active:scale-[0.97]",
              className,
            )}
          >
            <AgentAvatar name={name || "Agent"} face={shown} size="lg" className="size-9 rounded-[11px]" />
            <span
              aria-hidden="true"
              className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full border border-border bg-bg-raised text-fg-muted shadow-[var(--shadow-xs)] transition-quick group-hover/avatar:text-fg"
            >
              <PencilIcon className="size-2.5 [stroke-width:2.2]" />
            </span>
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        align="start"
        sideOffset={8}
        className="w-[19.25rem] gap-0 p-0"
        // Focus the panel, not its first swatch: a focused swatch opens its
        // tooltip over the label the moment the picker appears.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
          // …and bring the symbol in use into view: it may be rows down.
          const list = grid.current;
          const current = list?.querySelector<HTMLElement>('button[aria-checked="true"]');
          if (list && current) {
            const offset = current.getBoundingClientRect().top - list.getBoundingClientRect().top;
            list.scrollTop += offset - list.clientHeight / 2 + current.offsetHeight / 2;
          }
        }}
      >
        <div className="flex items-center gap-3 px-4 pt-4 pb-3.5">
          <AgentAvatar name={name || "Agent"} face={shown} size="xl" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-h3 text-fg">{unnamed ? "No name yet" : face.glyph ? face.glyph.label : "Initials"}</p>
            <p className="mt-0.5 text-caption text-fg-subtle">{unnamed ? "Follows the name, or pick one" : how}</p>
          </div>
        </div>

        <div className="px-4">
          <p id="avatar-colour" className="text-caption font-medium text-fg-subtle">
            Colour
          </p>
          <div role="radiogroup" aria-labelledby="avatar-colour" className="mt-2 flex items-center gap-2">
            {FACE_TINTS.map((tint) => {
              const selected = face.tint === tint.id;
              return (
                <Tip key={tint.id} label={tint.label} delay={350}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={tint.label}
                    onClick={() => setTint(tint.id)}
                    className={cn(
                      tintClass(tint.id),
                      "size-7 rounded-full bg-[var(--tint-bg)] transition-quick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-plum",
                      selected
                        ? "shadow-[inset_0_0_0_2px_var(--bg-raised),0_0_0_1.5px_var(--tint-fg)]"
                        : "shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tint-fg)_22%,transparent)] hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--tint-fg)_55%,transparent)]",
                    )}
                  />
                </Tip>
              );
            })}
          </div>
        </div>

        <p id="avatar-symbol" className="mt-4 px-4 text-caption font-medium text-fg-subtle">
          Symbol
        </p>
        <ScrollFade
          ref={grid}
          role="radiogroup"
          aria-labelledby="avatar-symbol"
          onKeyDown={onGridKey}
          fade={20}
          className="mt-1 max-h-[15.5rem] px-4 pb-3"
        >
          {GROUPS.map((group, i) => (
            <div key={group.label} role="group" aria-label={group.label}>
              <p className={cn("pb-1 text-micro text-fg-subtle", i === 0 ? "pt-1" : "pt-2.5")}>{group.label}</p>
              <div className="grid grid-cols-8 gap-x-0.5 gap-y-0.5">
                {group.glyphs.map((glyph) => cell(glyph.id, glyph.label, <glyph.icon className="size-[18px] [stroke-width:1.9]" />))}
              </div>
            </div>
          ))}
        </ScrollFade>

        <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={selectedGlyph === INITIALS_GLYPH}
            onClick={() => setGlyph(INITIALS_GLYPH)}
            className="aria-pressed:bg-bg-pressed aria-pressed:text-fg"
          >
            <span
              aria-hidden="true"
              className="flex size-[18px] items-center justify-center rounded-[5px] bg-bg-pressed text-[0.5rem] font-semibold tracking-[-0.02em] text-fg-muted"
            >
              {letters}
            </span>
            Use initials
          </Button>
          <Tip label={value ? "Go back to the face read from the name" : null}>
            <Button variant="ghost" size="xs" onClick={() => onChange("")} disabled={!value}>
              <RotateCcwIcon data-icon="inline-start" />
              Automatic
            </Button>
          </Tip>
        </div>
      </PopoverContent>
    </Popover>
  );
}
