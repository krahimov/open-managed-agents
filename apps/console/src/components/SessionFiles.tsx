import { useState, type ReactNode } from "react";
import { DownloadIcon, FileIcon, PlusIcon, XIcon } from "lucide-react";
import { toast } from "sonner";
import {
  PromptInputButton,
  PromptInputHeader,
  usePromptInputAttachments,
} from "./ai-elements/prompt-input";
import { formatBytes, isImageType, type MessageAttachment } from "../lib/attachments";
import {
  downloadSessionOutput,
  refreshSessionOutputs,
  resolveOutputLink,
  sessionOutputUrl,
  useSessionOutputs,
  type SessionOutputFile,
} from "../lib/session-outputs";

/**
 * File affordances for a chat session — both directions:
 *   in  → `AttachButton` + `ComposerAttachments` (composer),
 *         `MessageAttachmentChips` (sent user message)
 *   out → `SessionLink` (links in agent markdown), `TurnFiles` (per-turn strip)
 */

// ─── Out: links in agent messages ──────────────────────────────────────

/**
 * An `<a>` inside an agent message. Links that point at the agent's
 * sandbox (`sandbox:/mnt/session/outputs/x`, `/mnt/session/outputs/x`, a
 * bare `x.md`) download the session output instead of navigating — the
 * href is never an app route. Ordinary web links open in a new tab.
 */
export function SessionLink({
  sessionId,
  href,
  children,
}: {
  sessionId: string;
  href?: string;
  children?: ReactNode;
}) {
  const { outputs } = useSessionOutputs(sessionId);
  const target = resolveOutputLink(href, outputs);

  if (!target) {
    const external = !!href && /^https?:/i.test(href);
    return (
      <a
        href={href}
        className="text-info underline underline-offset-2 hover:text-info/80"
        {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
      >
        {children}
      </a>
    );
  }

  const onClick = async (e: React.MouseEvent<HTMLAnchorElement>) => {
    // Always: a sandbox path must never reach the router.
    e.preventDefault();
    if (target.kind === "output") {
      void downloadSessionOutput(sessionId, target.filename);
      return;
    }
    if (target.kind === "relative") {
      // The listing may predate the file (the message streams in before
      // the turn's outputs are re-listed) — look again before giving up.
      const fresh = await refreshSessionOutputs(sessionId);
      if (fresh.some((o) => o.filename === target.path)) {
        void downloadSessionOutput(sessionId, target.path);
      } else {
        toast.error(`"${target.path}" isn't in this session's files.`);
      }
      return;
    }
    toast.info(
      `"${target.path}" is inside the agent's sandbox and can't be downloaded from here. ` +
        `Ask the agent to save it directly in its outputs folder.`,
    );
  };

  const downloadable = target.kind !== "unavailable";
  return (
    <a
      // A real URL for output files so "copy link" is meaningful; the
      // click itself is intercepted (auth headers + forced download).
      href={target.kind === "output" ? sessionOutputUrl(sessionId, target.filename) : "#"}
      onClick={onClick}
      data-output-link={target.kind}
      title={
        target.kind === "output"
          ? `Download ${target.filename}`
          : target.kind === "relative"
            ? `Download ${target.path}`
            : "This file is inside the agent's sandbox"
      }
      className={
        downloadable
          ? "inline-flex items-baseline gap-1 text-info underline underline-offset-2 hover:text-info/80"
          : "text-fg-muted underline decoration-dotted underline-offset-2 cursor-help"
      }
    >
      {children}
      {downloadable && <DownloadIcon className="size-3 self-center shrink-0" aria-hidden />}
    </a>
  );
}

// ─── Out: files written during a turn ──────────────────────────────────

/** Compact "Files" strip under an agent message. */
export function TurnFiles({
  sessionId,
  files,
}: {
  sessionId: string;
  files: SessionOutputFile[];
}) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pt-1" data-testid="turn-files">
      <span className="text-[11px] uppercase tracking-wide text-fg-subtle font-mono mr-0.5">Files</span>
      {files.map((f) => (
        <DownloadChip
          key={f.filename}
          name={f.filename}
          detail={formatBytes(f.size_bytes)}
          onDownload={() => downloadSessionOutput(sessionId, f.filename)}
        />
      ))}
    </div>
  );
}

function DownloadChip({
  name,
  detail,
  onDownload,
}: {
  name: string;
  detail: string;
  onDownload: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await onDownload();
        } finally {
          setBusy(false);
        }
      }}
      title={`Download ${name}`}
      aria-label={`Download ${name}`}
      className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-2 py-1 text-xs text-fg hover:border-border-strong hover:bg-bg-surface/70 disabled:opacity-60 transition-colors"
    >
      <FileIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
      <span className="truncate font-mono">{name}</span>
      <span className="shrink-0 text-fg-subtle">{detail}</span>
      <DownloadIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
    </button>
  );
}

// ─── In: sent user message ─────────────────────────────────────────────

/** Attachment chips under a user bubble (from `metadata.attachments`). */
export function MessageAttachmentChips({ attachments }: { attachments: MessageAttachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5" data-testid="message-attachments">
      {attachments.map((a) => (
        <span
          key={a.file_id}
          title={a.path ? `${a.filename} → ${a.path}` : a.filename}
          className="inline-flex max-w-[260px] items-center gap-1.5 rounded-md border border-border bg-bg-surface px-2 py-1 text-xs text-fg"
        >
          <FileIcon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden />
          <span className="truncate">{a.filename}</span>
          <span className="shrink-0 text-fg-subtle">{formatBytes(a.size_bytes)}</span>
        </span>
      ))}
    </div>
  );
}

// ─── In: composer ──────────────────────────────────────────────────────

/**
 * Plain "+" button that opens the PromptInput file picker. The stock
 * `PromptInputActionAddAttachments` from ai-elements is a DropdownMenuItem
 * — meant to live inside an action-menu — so dropping it directly into
 * PromptInputTools threw "MenuItem must be used within Menu" at render.
 * This button reads the attachments controller from context and calls
 * `openFileDialog()` directly, no menu required.
 */
export function AttachButton() {
  const attachments = usePromptInputAttachments();
  return (
    <PromptInputButton
      type="button"
      onClick={() => attachments.openFileDialog()}
      aria-label="Attach file"
      title="Attach file"
    >
      <PlusIcon className="size-4" aria-hidden />
    </PromptInputButton>
  );
}

/**
 * Pending attachments above the textarea: a thumbnail for images, a
 * name + size chip for everything else, each removable. Renders nothing
 * until a file is picked, dropped or pasted.
 */
export function ComposerAttachments() {
  const attachments = usePromptInputAttachments();
  if (attachments.files.length === 0) return null;
  return (
    <PromptInputHeader className="px-3 pt-3 pb-0" data-testid="composer-attachments">
      {attachments.files.map((f) => {
        const size = (f as { file?: File }).file?.size;
        const name = f.filename || "file";
        return (
          <span
            key={f.id}
            className="group/att relative inline-flex max-w-[240px] items-center gap-2 rounded-md border border-border bg-bg-surface py-1 pl-1 pr-6 text-xs text-fg"
          >
            {isImageType(f.mediaType) && f.url ? (
              <img src={f.url} alt="" className="size-9 shrink-0 rounded object-cover" />
            ) : (
              <span className="flex size-9 shrink-0 items-center justify-center rounded bg-bg">
                <FileIcon className="size-4 text-fg-subtle" aria-hidden />
              </span>
            )}
            <span className="min-w-0">
              <span className="block truncate" title={name}>{name}</span>
              {typeof size === "number" && (
                <span className="block text-[11px] text-fg-subtle">{formatBytes(size)}</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => attachments.remove(f.id)}
              aria-label={`Remove ${name}`}
              title="Remove"
              className="absolute right-1 top-1 inline-flex size-4 items-center justify-center rounded text-fg-subtle hover:bg-bg hover:text-fg"
            >
              <XIcon className="size-3" aria-hidden />
            </button>
          </span>
        );
      })}
    </PromptInputHeader>
  );
}
