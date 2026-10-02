import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "../lib/api";

/**
 * Human-in-the-loop controls for a tool call the session is blocked on
 * (`session.status_idle` with `stop_reason.type === "requires_action"`,
 * `action_type: "tool_confirmation"` — tools under an `always_ask`
 * permission policy).
 *
 * Posts the Managed Agents `user.tool_confirmation` event:
 *   { type: "user.tool_confirmation", tool_use_id, result: "allow" | "deny",
 *     deny_message? }
 * The runtime resumes the turn; the card flips to "Responded" as soon as
 * the confirmation event streams back, and to the final result state when
 * the tool result lands.
 */
export function ToolConfirmationControls({
  sessionId,
  toolUseId,
  threadId,
}: {
  sessionId: string;
  toolUseId: string;
  /** Non-primary threads are addressed explicitly, like user.interrupt. */
  threadId?: string;
}) {
  const { api } = useApi();
  const [mode, setMode] = useState<"choose" | "deny">("choose");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);

  const respond = async (result: "allow" | "deny") => {
    if (busy || sent) return;
    setBusy(result);
    const denyMessage = reason.trim();
    try {
      await api(`/v1/sessions/${sessionId}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.tool_confirmation",
              tool_use_id: toolUseId,
              result,
              ...(result === "deny" && denyMessage ? { deny_message: denyMessage } : {}),
              ...(threadId && threadId !== "sthr_primary" ? { session_thread_id: threadId } : {}),
            },
          ],
        }),
      });
      setSent(result);
    } catch {
      // api() already toasted; leave the controls usable for a retry.
    } finally {
      setBusy(null);
    }
  };

  if (sent) {
    return (
      <div className="text-xs text-fg-subtle" role="status">
        {sent === "allow" ? "Approved — resuming…" : "Denied — resuming…"}
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-bg-surface px-3 py-2.5 space-y-2">
      <div className="text-xs text-fg-muted">This tool call needs your approval before it runs.</div>
      {mode === "choose" ? (
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void respond("allow")} disabled={busy !== null}>
            {busy === "allow" ? "Approving…" : "Approve"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setMode("deny")} disabled={busy !== null}>
            Deny
          </Button>
        </div>
      ) : (
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void respond("deny");
          }}
        >
          <input
            type="text"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Reason (optional, shown to the agent)"
            aria-label="Deny reason"
            autoFocus
            className="flex-1 min-w-0 h-8 rounded-md border border-border bg-bg px-2 text-xs focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <Button size="sm" variant="destructive" type="submit" disabled={busy !== null}>
            {busy === "deny" ? "Denying…" : "Confirm deny"}
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={() => setMode("choose")} disabled={busy !== null}>
            Cancel
          </Button>
        </form>
      )}
    </div>
  );
}
