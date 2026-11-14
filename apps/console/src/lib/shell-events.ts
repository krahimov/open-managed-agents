/**
 * Tiny window-event bridge for shell-level actions that any component can
 * trigger without threading context: opening the command palette, and
 * starting a session.
 */
const PALETTE_EVENT = "oma:command-palette";

export function openCommandPalette(): void {
  window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
}

export function onOpenCommandPalette(handler: () => void): () => void {
  window.addEventListener(PALETTE_EVENT, handler);
  return () => window.removeEventListener(PALETTE_EVENT, handler);
}

/** Route state understood by Home: focus the composer, optionally with an agent preselected. */
export interface ComposeIntent {
  compose: number;
  agentId?: string;
}

export function composeIntent(agentId?: string): ComposeIntent {
  return { compose: Date.now(), ...(agentId ? { agentId } : {}) };
}

/**
 * "New session", from anywhere: the sidebar, the palette, a page's button, an
 * agent's card or profile, an environment, an ended session.
 *
 * Every one of them calls `startSession()`, and the shell answers the same
 * way each time (<NewSessionHost> in components/sessions/NewSessionDialog):
 * on Home the session starter that is already on the page takes focus;
 * everywhere else the same starter opens in a dialog over the page you are
 * on. Nobody navigates to start a session, so nothing is left behind.
 */
export interface StartSessionRequest {
  /** Start with this agent chosen. */
  agentId?: string;
  /** Start in this environment, whichever agent is chosen. */
  environmentId?: string;
}

const START_SESSION_EVENT = "oma:start-session";

export function startSession(request: StartSessionRequest = {}): void {
  window.dispatchEvent(new CustomEvent<StartSessionRequest>(START_SESSION_EVENT, { detail: request }));
}

export function onStartSession(handler: (request: StartSessionRequest) => void): () => void {
  const listener = (e: Event) => handler((e as CustomEvent<StartSessionRequest>).detail ?? {});
  window.addEventListener(START_SESSION_EVENT, listener);
  return () => window.removeEventListener(START_SESSION_EVENT, listener);
}

/** True on Apple platforms: show ⌘ instead of Ctrl in shortcut hints. */
export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || "");

export const MOD_KEY = IS_MAC ? "⌘" : "Ctrl";
