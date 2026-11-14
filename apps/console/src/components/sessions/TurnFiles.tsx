import { useMemo, useState } from "react";
import { DownloadIcon } from "lucide-react";

import { formatBytes } from "@/lib/attachments";
import type { Event } from "@/lib/events";
import { downloadSessionOutput, outputsByTurn, useSessionOutputs, type SessionOutputFile } from "@/lib/session-outputs";
import { cn } from "@/lib/utils";

import { fileKind } from "../files/files";

/**
 * The files an agent wrote during one turn, under that turn.
 *
 *   const turnFiles = useTurnFilesMap(id, threadEvents);           (the page)
 *   <TurnFiles sessionId={id} files={turnFiles.get(lastMessage)} />  (each agent turn)
 *
 * The page lists the session's outputs once (lib/session-outputs, shared
 * with the links in the replies and the details panel) and gives each file
 * to the turn it was written in: the latest turn that began at or before
 * the file arrived, at that turn's last agent message (`outputsByTurn`). A
 * turn shows a quiet "Files" row with one chip per file: its kind, name and
 * size. A click downloads it with the console's sign-in, never a bare link.
 * Nothing at all when the turn wrote nothing. The details panel still lists
 * every file of the session.
 */

export interface TurnFilesProps {
  sessionId: string;
  files: SessionOutputFile[];
}

export function TurnFiles({ sessionId, files }: TurnFilesProps) {
  if (files.length === 0) return null;
  return (
    <div data-testid="turn-files" className="flex flex-wrap items-center gap-1.5 pt-1">
      <span className="mr-1 text-xs text-fg-subtle">Files</span>
      {files.map((f) => (
        <DownloadChip key={f.filename} sessionId={sessionId} file={f} />
      ))}
    </div>
  );
}

function DownloadChip({ sessionId, file }: { sessionId: string; file: SessionOutputFile }) {
  const [busy, setBusy] = useState(false);
  const Kind = fileKind(file).icon;
  return (
    <button
      type="button"
      disabled={busy}
      aria-busy={busy || undefined}
      aria-label={`Download ${file.filename}`}
      title={`Download ${file.filename}`}
      onClick={async () => {
        setBusy(true);
        try {
          await downloadSessionOutput(sessionId, file.filename);
        } finally {
          setBusy(false);
        }
      }}
      className={cn(
        "group/chip inline-flex h-8 max-w-72 items-center gap-2 rounded-full bg-bg-soft pr-2.5 pl-2.5 text-xs text-fg transition-quick hover:bg-bg-hover",
        busy && "opacity-60",
      )}
    >
      <Kind className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="min-w-0 truncate font-medium">{file.filename}</span>
      <span className="shrink-0 text-fg-subtle tabular-nums">{formatBytes(file.size_bytes)}</span>
      <DownloadIcon className="size-3.5 shrink-0 text-fg-faint transition-quick group-hover/chip:text-fg" aria-hidden="true" />
    </button>
  );
}

// ── which files belong to which turn ────────────────────────────────────

/**
 * The page's half: list the session's outputs (shared, read again when a
 * turn ends) and give each file to its turn, keyed by the agent message
 * that closes it. `events` are the thread's, in order. The conversation
 * shows each turn's files with <TurnFiles>.
 */
export function useTurnFilesMap(sessionId: string | undefined, events: readonly Event[]): Map<Event, SessionOutputFile[]> {
  const { outputs } = useSessionOutputs(sessionId || undefined);
  return useMemo(() => outputsByTurn(events, outputs), [events, outputs]);
}
