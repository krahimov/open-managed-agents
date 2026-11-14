import { useCallback, useEffect, useImperativeHandle, useRef, useState, type ComponentType, type ReactNode, type Ref } from "react";
import { ArrowUpIcon, CircleAlertIcon, PaperclipIcon, SquareIcon, XIcon } from "lucide-react";

import { formatBytes } from "@/lib/attachments";
import { useComposerDraft } from "@/lib/composer-draft";
import { cn } from "@/lib/utils";

import { fileKind } from "./files/files";
import { BrandLoader } from "./BrandLoader";
import { Kbd } from "./Kbd";
import { Tip } from "./Tip";
import { MOD_KEY } from "../lib/shell-events";

/**
 * The prompt box. One component for the Home composer and the session
 * composer, so "talking to an agent" feels the same everywhere.
 *
 *   <Composer
 *     value={text}
 *     onChange={setText}
 *     onSubmit={start}
 *     placeholder="What should your agents work on?"
 *     submitting={starting}
 *     size="lg"
 *     leading={<AgentPicker value={agentId} onChange={setAgentId} />}
 *     attachments={{ files, onAdd: addFiles, onRemove: removeFile }}
 *   />
 *
 * Anatomy: a raised 24px-radius card. Text area on top; a tool row below
 * with `leading` controls on the left (agent picker, attach) and the send
 * button on the right. While focus is inside, the edge firms up and the
 * shadow deepens (no coloured ring: the caret already shows focus).
 *
 * Keys: Enter sends, Shift+Enter adds a line, ⌘/Ctrl+Enter also sends.
 *
 * Attachments: the composer hands every file that is picked or dropped to
 * `attachments.onAdd` and shows the ones in `attachments.files`, each with
 * its name and size (an image wears its own thumbnail, any other file the
 * mark of its kind). Any kind of file can be picked. Deciding what is
 * allowed (size, how many) is the host's job, and so is saying so: a file
 * that is turned away is named in a <ComposerNotice> next to the box, never
 * dropped silently.
 *
 * Drafts: `draftKey` tags the text area (`data-draft-key`, lib/composer-
 * draft), so unsent words survive a reload the console starts itself (a new
 * version, a chunk that failed to load).
 *
 * Send button states:
 *   idle + empty   disabled, soft grey
 *   idle + text    ink, arrow up
 *   submitting     ink, three-dot loader (request in flight)
 *   running        ink, stop square: the agent is working; click calls onStop
 */
export interface ComposerHandle {
  /** Focus the text area. `end` also puts the caret after the last character
   *  (after the box was filled from outside: a starter chip, a restored draft). */
  focus: (opts?: { end?: boolean }) => void;
}

export interface ComposerAttachments {
  files: File[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  /** `accept` for the file input. Default: any file. */
  accept?: string;
}

export function Composer({
  ref,
  value,
  onChange,
  onSubmit,
  onStop,
  placeholder = "Send a message",
  submitting,
  running,
  disabled,
  size = "md",
  leading,
  trailing,
  attachments,
  footer,
  autoFocus,
  canSubmit,
  draftKey,
  className,
  "aria-label": ariaLabel,
}: {
  ref?: Ref<ComposerHandle>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  /** Provide with `running` to turn the send button into Stop. */
  onStop?: () => void;
  placeholder?: string;
  /** The submit request is in flight. */
  submitting?: boolean;
  /** The agent is working on the previous message. */
  running?: boolean;
  disabled?: boolean;
  /** `lg` for Home (taller, larger type), `md` for in-session. */
  size?: "md" | "lg";
  /** Left side of the tool row. */
  leading?: ReactNode;
  /** Right side of the tool row, before the send button. */
  trailing?: ReactNode;
  attachments?: ComposerAttachments;
  /** A quiet line under the tool row, inside the card (warnings, context). */
  footer?: ReactNode;
  autoFocus?: boolean;
  /** Override "has text or files" (e.g. also require an agent). */
  canSubmit?: boolean;
  /** Keeps unsent text through a reload the console starts (lib/composer-draft). */
  draftKey?: string;
  className?: string;
  "aria-label"?: string;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // A restored draft goes through the host's onChange, like typing.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const restore = useCallback((text: string) => onChangeRef.current(text), []);
  const draft = useComposerDraft(draftKey, restore);
  const setTextArea = useCallback(
    (el: HTMLTextAreaElement | null) => {
      taRef.current = el;
      draft.ref(el);
    },
    [draft.ref], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useImperativeHandle(
    ref,
    () => ({
      focus: (opts) => {
        const el = taRef.current;
        if (!el) return;
        el.focus();
        if (opts?.end) {
          // After the value React is about to commit, not the one on screen now.
          requestAnimationFrame(() => {
            const at = el.value.length;
            el.setSelectionRange(at, at);
            el.scrollTop = el.scrollHeight;
          });
        }
      },
    }),
    [],
  );

  useEffect(() => {
    if (autoFocus) taRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const hasContent = value.trim().length > 0 || (attachments?.files.length ?? 0) > 0;
  const ready = (canSubmit ?? hasContent) && !submitting && !disabled;
  const showStop = !!running && !!onStop && !hasContent;

  const submit = () => {
    if (ready) onSubmit();
  };

  return (
    <div
      className={cn(
        "group/composer relative rounded-2xl border border-border-strong bg-bg-surface shadow-[var(--shadow-md)] transition-base",
        // Focus is shown by the caret and a firm edge + deeper shadow: the
        // composer is the room's main object, so it does not wear the plum
        // ring. The edge is fg-subtle so it reads in dark too, where a deeper
        // shadow alone shows nothing.
        "focus-within:border-fg-subtle focus-within:shadow-[var(--shadow-lg)]",
        disabled && "opacity-70",
        className,
      )}
      onDragOver={attachments ? (e) => e.preventDefault() : undefined}
      onDrop={
        attachments
          ? (e) => {
              e.preventDefault();
              const dropped = Array.from(e.dataTransfer.files ?? []);
              if (dropped.length) attachments.onAdd(dropped);
            }
          : undefined
      }
    >
      {attachments && attachments.files.length > 0 && (
        <ul data-testid="composer-attachments" aria-label="Attachments" className="flex flex-wrap gap-2 px-4 pt-4">
          {attachments.files.map((f, i) => (
            <AttachmentChip key={`${f.name}-${f.size}-${i}`} file={f} onRemove={() => attachments.onRemove(i)} />
          ))}
        </ul>
      )}

      <textarea
        ref={setTextArea}
        data-draft-key={draft["data-draft-key"]}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            submit();
          }
        }}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        disabled={disabled}
        rows={size === "lg" ? 2 : 1}
        className={cn(
          "block field-sizing-content w-full resize-none bg-transparent text-fg outline-none placeholder:text-fg-subtle focus-visible:outline-none disabled:cursor-not-allowed",
          size === "lg"
            ? "max-h-64 min-h-[5.25rem] px-5 pt-5 pb-2 text-[1.0625rem] leading-relaxed"
            : "max-h-48 min-h-12 px-4 pt-3.5 pb-1.5 text-prose",
        )}
      />

      <div className={cn("flex items-center gap-1.5", size === "lg" ? "px-3 pt-1 pb-3" : "px-2.5 pb-2.5")}>
        {attachments && (
          <>
            <input
              ref={fileRef}
              type="file"
              multiple
              hidden
              accept={attachments.accept}
              onChange={(e) => {
                const picked = Array.from(e.target.files ?? []);
                if (picked.length) attachments.onAdd(picked);
                e.target.value = "";
              }}
            />
            <Tip label="Attach files">
              <button
                type="button"
                aria-label="Attach files"
                disabled={disabled}
                onClick={() => fileRef.current?.click()}
                className="flex size-9 shrink-0 items-center justify-center rounded-full text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
              >
                <PaperclipIcon className="size-[18px] stroke-[1.75]" />
              </button>
            </Tip>
          </>
        )}
        <div className="flex min-w-0 flex-1 items-center gap-1.5">{leading}</div>
        {trailing}
        <span
          className={cn(
            "hidden items-center gap-1.5 pr-1.5 text-xs text-fg-subtle transition-opacity duration-[var(--dur-base)] sm:flex",
            ready ? "opacity-100" : "opacity-0",
          )}
          aria-hidden="true"
        >
          <Kbd className="text-small">↵</Kbd> to send
        </span>
        {showStop ? (
          <Tip label="Stop the agent">
            <button
              type="button"
              aria-label="Stop"
              onClick={onStop}
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-on-ink transition-quick hover:bg-ink-hover active:scale-95"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </button>
          </Tip>
        ) : (
          <Tip
            label={
              ready ? (
                <>
                  Send <Kbd tone="onInk" keys={[MOD_KEY, "↵"]} />
                </>
              ) : null
            }
          >
            <button
              type="button"
              aria-label="Send"
              aria-busy={submitting || undefined}
              disabled={!ready && !submitting}
              onClick={submit}
              className={cn(
                "flex size-9 shrink-0 items-center justify-center rounded-full transition-quick active:scale-95",
                ready || submitting
                  ? "bg-ink text-on-ink shadow-[var(--shadow-xs)] hover:bg-ink-hover"
                  : "cursor-not-allowed bg-bg-pressed text-fg-faint",
              )}
            >
              {submitting ? (
                <BrandLoader size="sm" label="Sending" className="!text-current" />
              ) : (
                <ArrowUpIcon className="size-[18px] stroke-[2.25]" />
              )}
            </button>
          </Tip>
        )}
      </div>
      {footer && <div className="border-t border-border px-5 py-2.5 text-xs text-fg-muted">{footer}</div>}
    </div>
  );
}

/**
 * One attached file: its thumbnail when it is an image (the mark of its kind
 * otherwise), its name and size, and a way to take it out.
 */
function AttachmentChip({ file, onRemove }: { file: File; onRemove: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!file.type.startsWith("image/") || typeof URL.createObjectURL !== "function") return;
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const Kind = fileKind({ filename: file.name, media_type: file.type }).icon;
  return (
    <li
      title={file.name}
      className={cn("flex h-8 max-w-64 items-center gap-2 rounded-full bg-bg-soft pr-1 text-xs text-fg", thumb ? "pl-1" : "pl-2.5")}
    >
      {thumb ? (
        // A file that says it is an image but does not decode keeps its kind's mark.
        <img src={thumb} alt="" className="size-6 shrink-0 rounded-full object-cover" onError={() => setThumb(null)} />
      ) : (
        <Kind className="size-3.5 shrink-0 text-fg-subtle" />
      )}
      <span className="min-w-0 truncate">{file.name}</span>
      <span className="shrink-0 text-fg-subtle tabular-nums">{formatBytes(file.size)}</span>
      <button
        type="button"
        aria-label={`Remove ${file.name}`}
        onClick={onRemove}
        className="flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-pressed hover:text-fg"
      >
        <XIcon className="size-3.5" />
      </button>
    </li>
  );
}

/**
 * One piece of news about the message being written, set against the box:
 * a file that was not attached, a message that did not go through. It names
 * what happened, says why, and offers the way forward.
 *
 *   <ComposerNotice title="“report.pdf” was not attached" onDismiss={clear}>
 *     A file can be up to 25 MB.
 *   </ComposerNotice>
 *
 * The words for a refused file come from ./files/refusal.
 *
 * `neutral` for something the person can simply note; `danger` when what
 * they asked for did not happen. It is announced to assistive technology.
 */
export function ComposerNotice({
  tone = "neutral",
  icon: Icon = CircleAlertIcon,
  title,
  children,
  actions,
  onDismiss,
  className,
}: {
  tone?: "neutral" | "danger";
  icon?: ComponentType<{ className?: string }>;
  title: ReactNode;
  children?: ReactNode;
  /** Small buttons under the text (size="sm"). */
  actions?: ReactNode;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn(
        "flex animate-rise-in items-start gap-3 rounded-lg py-2.5 pr-2 pl-3.5 text-left text-small",
        // A failure takes the failed-card tokens: the danger tint in light; in
        // dark the surface's step with a red edge (an inset ring, so nothing
        // moves), not a maroon slab beside the failed-turn cards.
        tone === "danger" ? "bg-[var(--failed-bg)] dark:ring-1 dark:ring-[var(--failed-border)] dark:ring-inset" : "bg-bg-soft",
        className,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", tone === "danger" ? "text-danger" : "text-fg-muted")} />
      <div className="min-w-0 flex-1">
        <p className="font-medium break-words text-fg">{title}</p>
        {children && <div className="mt-0.5 break-words text-fg-muted">{children}</div>}
        {actions && <div className="mt-2 flex flex-wrap items-center gap-1.5">{actions}</div>}
      </div>
      {onDismiss && (
        <button
          type="button"
          aria-label="Dismiss"
          onClick={onDismiss}
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
