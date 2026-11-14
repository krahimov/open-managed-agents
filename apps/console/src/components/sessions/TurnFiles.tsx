import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { DownloadIcon } from "lucide-react";

import { formatBytes } from "@/lib/attachments";
import type { Event } from "@/lib/events";
import { downloadSessionOutput, outputsByTurn, useSessionOutputs, type SessionOutputFile } from "@/lib/session-outputs";
import { cn } from "@/lib/utils";

import { fileKind } from "../files/files";

/**
 * The files an agent wrote during one turn, under that turn.
 *
 *   <TurnFilesProvider sessionId={id} events={threadEvents}>   (the page)
 *     … <TurnFilesFor sessionId={id} events={turnEvents} />     (each agent turn)
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

const TurnFilesMap = createContext<Map<Event, SessionOutputFile[]> | null>(null);

/** The page: list the session's outputs and share them out by turn. `events` are the thread's, in order. */
export function TurnFilesProvider({ sessionId, events, children }: { sessionId: string; events: readonly Event[]; children: ReactNode }) {
  const { outputs } = useSessionOutputs(sessionId || undefined);
  const byTurn = useMemo(() => outputsByTurn(events, outputs), [events, outputs]);
  return <TurnFilesMap.Provider value={byTurn}>{children}</TurnFilesMap.Provider>;
}

/** The files written in the turn these events belong to (an agent turn's messages). */
export function useTurnFiles(events: readonly Event[]): SessionOutputFile[] {
  const byTurn = useContext(TurnFilesMap);
  if (!byTurn || byTurn.size === 0) return [];
  const out: SessionOutputFile[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    for (const f of byTurn.get(e) ?? []) {
      if (seen.has(f.filename)) continue;
      seen.add(f.filename);
      out.push(f);
    }
  }
  return out;
}

/** An agent turn's Files row, from the events it was built from. Nothing outside a <TurnFilesProvider>. */
export function TurnFilesFor({ sessionId, events }: { sessionId: string; events: readonly Event[] }) {
  const files = useTurnFiles(events);
  return <TurnFiles sessionId={sessionId} files={files} />;
}
