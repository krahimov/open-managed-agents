/**
 * CONTRACT (step 0 baseline). Owner: C3. Rendered by ConversationView's
 * approval card (and by tool rows awaiting approval). Renders nothing yet.
 *
 * Port of main's components/ToolConfirmationControls.tsx in Muse's
 * language: the decision for one tool call the session is blocked on
 * (`requires_action`, `action_type: "tool_confirmation"`, tools under an
 * `always_ask` policy). "Allow this call" and "Deny"; Deny opens a second
 * step with an optional reason before it is sent. The decision is posted as
 * `POST /v1/sessions/:id/events` with
 * `{ events: [{ type: "user.tool_confirmation", tool_use_id, result:
 * "allow" | "deny", deny_message?, session_thread_id? }] }`,
 * `session_thread_id` only when the thread is not `sthr_primary`. C3 does
 * this through `useSessionOperations(sessionId).decide(toolUseId, result,
 * { threadId, denyMessage })` (hooks.ts), using the operations endpoint
 * only when `useServerFeature("operations")` is on. Locked only when
 * `/v1/workspace/access` exists and says the caller cannot operate; a
 * server without it means "can operate". After sending, it reads
 * "Responded" until the confirmation event streams back. A failure is said
 * in a sentence in place.
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

export function ApprovalControls(_props: ApprovalControlsProps) {
  return null;
}
