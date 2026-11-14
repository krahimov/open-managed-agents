import type { SessionOutputFile } from "../../lib/session-outputs";

/**
 * CONTRACT (step 0 baseline). Owner: C4. Rendered under an agent turn in
 * ConversationView (C3 places it; C4 decides which files belong to the
 * turn, see main's SessionDetail turnFiles). Renders nothing yet.
 *
 * Port of main's TurnFiles (components/SessionFiles.tsx). A compact
 * "Files" strip of the outputs the agent wrote during this turn: one chip
 * per file with its name and size (formatBytes from lib/attachments); a
 * click downloads it with `downloadSessionOutput(sessionId, filename)`
 * (lib/session-outputs; authenticated, never a bare href). Nothing when
 * `files` is empty. Keeps the test id `turn-files` on the strip.
 */
export interface TurnFilesProps {
  sessionId: string;
  files: SessionOutputFile[];
}

export function TurnFiles(_props: TurnFilesProps) {
  return null;
}
