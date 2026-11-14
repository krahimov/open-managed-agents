import type { Event } from "../lib/events";

/**
 * CONTRACT (step 0 baseline). Owner: C5. Rendered by C3 (ConversationView,
 * card kind `saved_login`) and C6b (SessionChat). Renders nothing yet.
 *
 * Port of main's components/SavedLoginLine.tsx in Muse's language. One
 * line under the turn for a `system.saved_login_attached` event: setup
 * attached a saved login instead of asking. Says which vault the agent got
 * (link to /vaults/:vault_id, the vault's name, never its id when a name
 * exists) and, when `can_switch` and `mcp_server_url` are set, offers
 * "Switch account". Switching opens the provider sign-in through
 * `openOAuthPopup` (lib/oauth-popup) with `mcp_server_url`, `service`,
 * `new_vault_name` ("<service> · <agent_name>" or "<service> login"),
 * `redirect_uri`, `session_id` and `request_id`, so the result lands in a
 * NEW vault and a login other agents share is never overwritten. Listens
 * with `subscribeOAuthMessages`; popup messages only clear "waiting"
 * (`oauth_complete` for this request_id, `oauth_error` shows the error,
 * a closed popup stops waiting). Blocked popup: say so in a sentence.
 * The durable `switched` prop (a `system.access_granted` for this
 * request_id exists in the log) is what marks the switch done: then it
 * reads "using the account you just signed in with".
 *
 * Event fields read: request_id, service, mcp_server_url, vault_id,
 * vault_name, agent_name, can_switch.
 */
export interface SavedLoginLineProps {
  /** The `system.saved_login_attached` event. */
  event: Event;
  /** Defaults to the :id route param (SessionDetail); SessionChat must pass
   *  it explicitly, since its route param is the AGENT id. */
  sessionId?: string;
  /** The session's event log holds a `system.access_granted` for this
   *  event's request_id (C3's access_granted fold). */
  switched?: boolean;
}

export function SavedLoginLine(_props: SavedLoginLineProps) {
  return null;
}
