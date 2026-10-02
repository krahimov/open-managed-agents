// Exit-status plumbing for outcome verify scripts (runExec).
//
// SandboxExecutor.exec returns a plain string and the adapters disagree on
// how (or whether) they encode the exit code: boxrun prefixes `exit=N\n`,
// LocalSubprocess appends `[exit exit=N]` only on failure, others neither.
// Parsing that was wrong for LocalSubprocess — a successful script read as
// exit -1 (PR #30 QA round 3, R3). Instead the command reports its own
// status: it runs in a subshell (so a script's `exit` can't skip the
// marker) and prints a sentinel line we strip back off.

const MARKER = "__OMA_VERIFY_EXIT__=";

export function wrapVerifyCommand(cmd: string): string {
  return `(\n${cmd}\n); printf '\\n${MARKER}%d\\n' "$?"`;
}

export function parseVerifyExec(raw: string): { exit_code: number; output: string } {
  const idx = raw.lastIndexOf(MARKER);
  if (idx >= 0) {
    const m = raw.slice(idx + MARKER.length).match(/^(\d+)/);
    if (m) {
      // Drop the marker line and any adapter suffix after it (e.g. "[exit …]").
      return { exit_code: Number(m[1]), output: raw.slice(0, idx).replace(/\n+$/, "") };
    }
  }
  // No marker: the command was killed (timeout / abort) before finishing.
  return { exit_code: -1, output: raw };
}
