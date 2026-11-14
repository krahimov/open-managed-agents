import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { composeIntent, onStartSession, type StartSessionRequest } from "@/lib/shell-events";

import { SessionStarter } from "../home/SessionStarter";
import { Modal } from "../Modal";

/**
 * "New session", away from Home: the session starter in a dialog.
 *
 * It is the same starter Home shows inline (message box, agent picker,
 * attachments, Options for environment, vaults, resources and title, and
 * things to ask), so a session starts the same way from the sidebar, the
 * palette, the Sessions page, an agent, an environment, or a link:
 *
 *   /sessions?new=1                      the most used agent
 *   /sessions?new=1&agent_id=…           that agent
 *   /sessions?new=1&environment_id=…     that environment, whichever agent
 *
 * The shell mounts it once (<NewSessionHost>); pages ask for it with
 * `startSession()` from lib/shell-events.
 *
 * Sending creates the session, sends the first message and opens it. A
 * message that was being written when the dialog closed is there again
 * the next time it opens.
 */
export function NewSessionDialog({
  open,
  initialAgentId,
  initialEnvironmentId,
  onClose,
}: {
  open: boolean;
  /** Preselect this agent (the `?agent_id=` deep link). */
  initialAgentId?: string;
  /** Start in this environment (the `?environment_id=` deep link, used by
   *  "Start session here" on an environment's page). It stays selected when
   *  the agent changes, instead of giving way to each agent's default. */
  initialEnvironmentId?: string;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      open={open}
      // Not while the session is being created: the request would go on unseen.
      onClose={() => {
        if (!busy) onClose();
      }}
      title="New session"
      subtitle="Tell an agent what to do. It starts working as soon as you send."
      maxWidth="max-w-2xl"
      // Options open in place under the message box: the dialog grows with
      // them from a fixed top edge (it does not jump) and scrolls inside
      // when the window is short.
      placement="top"
    >
      <SessionStarter
        variant="dialog"
        autoFocus
        initialAgentId={initialAgentId}
        initialEnvironmentId={initialEnvironmentId}
        onNavigate={onClose}
        onBusyChange={setBusy}
        className="pt-1"
      />
    </Modal>
  );
}

/**
 * The one place a session starts from, mounted once by the shell.
 *
 * It answers `startSession()` the same way wherever it was called from:
 * on Home the starter that is already on the page takes focus (with the
 * agent that was asked for); on every other page the same starter opens in
 * a dialog over that page. So the sidebar's "New session", the palette's,
 * a page's own button, an agent's and an environment's all do one thing.
 */
export function NewSessionHost() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [request, setRequest] = useState<(StartSessionRequest & { open: boolean; nonce: number }) | null>(null);

  useEffect(
    () =>
      onStartSession((next) => {
        // Home already shows the starter. An environment is the one thing its
        // inline form cannot be handed, so that request still gets the dialog.
        if (pathname === "/" && !next.environmentId) {
          navigate("/", { state: composeIntent(next.agentId), replace: true });
          return;
        }
        setRequest({ ...next, open: true, nonce: Date.now() });
      }),
    [pathname, navigate],
  );

  // Going somewhere else (a chord, the back button) leaves the dialog behind.
  useEffect(() => {
    setRequest((cur) => (cur?.open ? { ...cur, open: false } : cur));
  }, [pathname]);

  if (!request) return null;
  return (
    <NewSessionDialog
      // A new request is a new dialog: the agent and the environment asked
      // for now, not the ones from the last time it was open.
      key={request.nonce}
      open={request.open}
      initialAgentId={request.agentId}
      initialEnvironmentId={request.environmentId}
      onClose={() => setRequest((cur) => (cur ? { ...cur, open: false } : cur))}
    />
  );
}
