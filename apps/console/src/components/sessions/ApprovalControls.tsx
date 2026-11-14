import { useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { quietLink } from "@/lib/links";

import { BrandLoader } from "../BrandLoader";
import { useSessionOperations, type SessionOperations } from "./hooks";

/**
 * The decision for one tool call the session is blocked on: an idle with
 * `requires_action` for a tool under an "ask first" policy. Port of main's
 * ToolConfirmationControls in Muse's language.
 *
 *   choose   "Allow this call" (the one ink button) · "Deny"
 *   deny     a second step: an optional reason the agent is told, then
 *            "Deny this call", or "Back". Escape goes back too.
 *   sent     "Allowed. The agent is picking the call back up." until the
 *            confirmation streams back and the card turns into a tool row.
 *
 * The decision goes through `useSessionOperations(sessionId).decide`, which
 * posts the session's `user.tool_confirmation` event (with
 * `session_thread_id` for a sub-agent's thread and `deny_message` for a
 * reason). It is locked only when the server reports the caller's role and
 * that role cannot operate. A failed post says so in a sentence in place,
 * and the buttons stay usable for another try.
 */
export interface ApprovalControlsProps {
  sessionId: string;
  toolUseId: string;
  /** Non-primary threads are addressed explicitly (`session_thread_id`). */
  threadId?: string;
  /** MCP service and tool being approved ("Linear", "create issue"), named
   *  in the prompt so the approver sees what will run. Deferred MCP calls
   *  (call_mcp_tool) are unwrapped first, see lib/deferred-mcp. */
  server?: string;
  tool?: string;
}

export function ApprovalControls({ sessionId, toolUseId, threadId, server, tool }: ApprovalControlsProps) {
  const ops = useSessionOperations(sessionId);
  const [step, setStep] = useState<"choose" | "deny">("choose");
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState<"allow" | "deny" | null>(null);
  const reasonId = useId();

  const allowing = ops.busy === `allow:${toolUseId}`;
  const denying = ops.busy === `deny:${toolUseId}`;
  const locked = !ops.canOperate || !!ops.busy || !toolUseId;
  const what = server && tool ? `${server} · ${tool}` : null;

  const send = async (result: "allow" | "deny") => {
    if (locked) return;
    const ok = await ops.decide(toolUseId, result, { threadId, denyMessage: result === "deny" ? reason : undefined });
    if (ok) setSent(result);
  };

  if (sent) {
    return (
      <p role="status" className="flex min-h-8 items-center gap-2 text-small text-fg-muted">
        <span aria-hidden="true" className="inline-flex">
          <BrandLoader size="sm" label="Resuming" />
        </span>
        {sent === "allow"
          ? `Allowed${what ? ` ${what}` : ""}. The agent is picking the call back up.`
          : "Denied. The agent is told and carries on without it."}
      </p>
    );
  }

  return (
    <div className="flex w-full flex-col gap-2.5">
      {step === "choose" ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={locked && !allowing} loading={allowing} onClick={() => void send("allow")}>
            Allow this call
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={locked}
            onClick={() => {
              ops.clearError();
              setStep("deny");
            }}
          >
            Deny
          </Button>
          <AccessNote ops={ops} action="approve tools" />
        </div>
      ) : (
        <form
          className="flex w-full flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send("deny");
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && !denying) {
              e.preventDefault();
              e.stopPropagation();
              setStep("choose");
            }
          }}
        >
          <label htmlFor={reasonId} className="text-small font-medium text-fg">
            Tell the agent why <span className="font-normal text-fg-subtle">(optional)</span>
          </label>
          <Input
            id={reasonId}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="For example: not on production, use the staging database"
            autoFocus
            maxLength={2000}
            disabled={denying}
          />
          <p className="text-xs text-fg-subtle">
            {what ? `${what} does not run.` : "The call does not run."} The agent reads your reason and can try another way.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Button type="submit" size="sm" disabled={locked && !denying} loading={denying}>
              Deny this call
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={denying} onClick={() => setStep("choose")}>
              Back
            </Button>
            <AccessNote ops={ops} action="approve tools" />
          </div>
        </form>
      )}
      {ops.error && (
        <p role="alert" className="text-small text-danger">
          {ops.error}
        </p>
      )}
    </div>
  );
}

/**
 * Why the buttons beside it are off. "Operator access is required" is said
 * only when the server said so; a permissions read that failed says it
 * could not be checked, and checks again on request.
 */
export function AccessNote({ ops, action }: { ops: SessionOperations; action: string }) {
  if (ops.accessFailed) {
    return (
      <span role="alert" className="text-xs text-fg-muted">
        Your access could not be checked.{" "}
        <button type="button" onClick={ops.recheckAccess} className={cn(quietLink, "text-fg")}>
          Try again
        </button>
      </span>
    );
  }
  if (ops.accessKnown && !ops.canOperate) {
    return <span className="text-xs text-fg-muted">Operator access is required to {action}.</span>;
  }
  return null;
}
