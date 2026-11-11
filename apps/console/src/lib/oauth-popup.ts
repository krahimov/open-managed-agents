import { getClerkBearerToken } from "./clerk-auth";

/**
 * Open the MCP OAuth popup for `/v1/oauth/authorize?<params>`.
 *
 * /authorize only starts a flow straight away when it carries a one-time
 * `oauth_confirm` token (anything else, including same-origin links, gets a
 * confirm page — see packages/http-routes/src/oauth-initiator.ts). The popup
 * opens synchronously (popup blockers), then the token is minted with a
 * fetch and the popup is pointed at the authorize URL carrying it. If the
 * mint fails the popup still goes to /authorize and the user sees the
 * confirm page instead of a dead window.
 *
 * Returns the popup, or null when the browser blocked it.
 */
export function openOAuthPopup(
  params: URLSearchParams,
  name: string,
  features = "width=600,height=700,popup=yes",
): Window | null {
  const popup = window.open("", name, features);
  if (!popup) return null;
  const query = params.toString();
  void (async () => {
    let url = `/v1/oauth/authorize?${query}`;
    try {
      const token = await mintStartToken(query);
      if (token) url += `&oauth_confirm=${encodeURIComponent(token)}`;
    } catch {
      // Fall through to the confirm page.
    }
    if (!popup.closed) popup.location.href = url;
  })();
  return popup;
}

/** With Clerk the mint authenticates by bearer; the popup's navigations
 *  can't carry one, so main-node reads clerk-js's `__session` cookie on
 *  /v1/oauth/authorize and /v1/oauth/callback (clerkSessionTokenFrom). */
async function mintStartToken(query: string): Promise<string | null> {
  const clerkToken = await getClerkBearerToken();
  const res = await fetch("/v1/oauth/start-token", {
    method: "POST",
    credentials: "include",
    // No x-active-tenant on purpose: the popup's navigation can't send it,
    // so the token must be minted under the tenant that navigation resolves.
    headers: {
      "content-type": "application/json",
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
    },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { token?: unknown } | null;
  return typeof body?.token === "string" ? body.token : null;
}

/** Same-origin channel the OAuth / Composio callback pages broadcast on. */
export const OAUTH_CHANNEL_NAME = "openma-oauth";

/** How long one transport's copy of a message waits for the other's. */
export const OAUTH_DEDUPE_WINDOW_MS = 10_000;

export type OAuthTransport = "window" | "broadcast";

/**
 * The callback pages post each result twice: `window.opener.postMessage`
 * (lost when the provider's COOP severs the opener) and
 * BroadcastChannel("openma-oauth") (survives COOP). The payloads carry no
 * per-flow nonce (the vault flow sends `request_id: null`, the CF callback
 * none at all), so a message is keyed by its origin + content and the copy
 * arriving on the OTHER transport within the window is dropped. A repeat on
 * the SAME transport is always a new result and is delivered.
 */
export function createOAuthMessageDeduper(windowMs = OAUTH_DEDUPE_WINDOW_MS) {
  let seen: { key: string; transport: OAuthTransport; at: number }[] = [];
  return {
    /** Whether to deliver this message (false = the other transport's copy). */
    accept(
      event: { data: unknown; origin?: string },
      transport: OAuthTransport,
      now = Date.now(),
    ): boolean {
      const data = event.data as { type?: unknown } | null;
      if (!data || typeof data !== "object" || typeof data.type !== "string") return true;
      let key: string;
      try {
        key = `${event.origin ?? ""} ${JSON.stringify(data)}`;
      } catch {
        return true;
      }
      seen = seen.filter((s) => s.at <= now && now - s.at < windowMs);
      const copy = seen.findIndex((s) => s.key === key && s.transport !== transport);
      if (copy >= 0) {
        seen.splice(copy, 1);
        return false;
      }
      seen.push({ key, transport, at: now });
      return true;
    },
  };
}

type OAuthMessageHandler = (event: MessageEvent) => void;

/**
 * One `window` "message" listener plus one BroadcastChannel, shared by all
 * subscribers, delivering each callback message once. The dedupe state
 * outlives subscriptions, so a component that re-subscribes between the two
 * copies (re-render from handling the first) still drops the second.
 */
export function createOAuthMessageHub({
  win = window,
  openChannel = (name: string) => new BroadcastChannel(name),
  windowMs = OAUTH_DEDUPE_WINDOW_MS,
}: {
  win?: Window;
  openChannel?: (name: string) => BroadcastChannel;
  windowMs?: number;
} = {}) {
  const deduper = createOAuthMessageDeduper(windowMs);
  const handlers = new Set<OAuthMessageHandler>();
  let stop: (() => void) | null = null;

  const deliver = (transport: OAuthTransport) => (event: Event) => {
    const msg = event as MessageEvent;
    if (!deduper.accept(msg, transport)) return;
    for (const handler of [...handlers]) handler(msg);
  };

  const start = () => {
    const onWindow = deliver("window");
    const onBroadcast = deliver("broadcast");
    win.addEventListener("message", onWindow);
    let bc: BroadcastChannel | null = null;
    try {
      bc = openChannel(OAUTH_CHANNEL_NAME);
      bc.addEventListener("message", onBroadcast);
    } catch {
      // BroadcastChannel is best effort for browsers without support.
    }
    return () => {
      win.removeEventListener("message", onWindow);
      if (bc) {
        bc.removeEventListener("message", onBroadcast);
        bc.close();
      }
    };
  };

  return {
    subscribe(handler: OAuthMessageHandler): () => void {
      handlers.add(handler);
      stop ??= start();
      return () => {
        handlers.delete(handler);
        if (handlers.size === 0 && stop) {
          stop();
          stop = null;
        }
      };
    },
  };
}

let defaultHub: ReturnType<typeof createOAuthMessageHub> | null = null;

/** Subscribe to OAuth / Composio popup results from both transports, each
 *  delivered once. Returns the unsubscribe function. */
export function subscribeOAuthMessages(handler: OAuthMessageHandler): () => void {
  defaultHub ??= createOAuthMessageHub();
  return defaultHub.subscribe(handler);
}
