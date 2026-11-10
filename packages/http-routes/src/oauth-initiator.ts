// MCP OAuth initiator binding — shared by the Node and CF /v1/oauth routes.
//
// The `state` a provider echoes back to /v1/oauth/callback used to be the
// only thing the callback checked, so whoever finished the flow decided
// whose provider account landed in the initiator's vault: an attacker
// with the authorize link could attach their own account to a victim's
// vault (account mix-up), or hand a victim a link that saves the victim's
// login into the attacker's tenant (login CSRF). The state record now
// carries who started the flow, and the callback refuses anyone else:
//
//   - session-started flows (console popup): the 302 also sets a
//     per-flow HttpOnly SameSite=Lax nonce cookie scoped to the callback
//     path; the callback must present it AND be the same console user.
//   - API-key-started flows: the 302 goes to an API client, so no cookie
//     can reach the user's browser. The flow is bound to the key's
//     identity instead — the callback (behind the console auth
//     middleware) must be the key's user, or, for legacy keys minted
//     without a user, a session in the key's tenant.
//   - internal dispatch (Telegram connect, no auth middleware): bound to
//     the dispatching tenant; the Telegram identity check gates who ever
//     receives the authorize URL.
//
// Every state is single use (the callback deletes it before doing any
// work) and carries its own expiry, checked even if the KV TTL lags.
//
// Binding proves the finishing browser is the starting one — not that the
// user meant to start. A cross-site page could navigate a signed-in victim
// to /authorize with an attacker MCP server, then bounce the victim's own
// browser to the callback. So a cookie-session start must also come from
// our own origin (the console's same-origin popup) per Sec-Fetch-Site, or
// be confirmed on a page only our origin can read (gateOAuthStart).

import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";

export type OAuthInitiatorAuth = "session" | "api_key" | "disabled" | "internal";

export interface OAuthInitiator {
  tenant_id: string;
  user_id?: string;
  auth: OAuthInitiatorAuth;
  /** sha256(nonce) of the browser cookie — session-started flows only. */
  nonce_hash?: string;
  /** Epoch ms after which the callback refuses the state. */
  expires_at: number;
}

export const OAUTH_STATE_TTL_SECONDS = 600;
const COOKIE_PREFIX = "oma_oauth_";
const COOKIE_PATH = "/v1/oauth";

async function sha256Base64url(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  let bin = "";
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** One cookie per flow so two concurrent popups don't clobber each other.
 *  Named by a hash of the state, never the state itself. */
async function cookieNameFor(state: string): Promise<string> {
  return COOKIE_PREFIX + (await sha256Base64url(state)).slice(0, 22);
}

function normalizeAuth(authType: string | undefined): OAuthInitiatorAuth {
  return authType === "session" || authType === "api_key" || authType === "disabled"
    ? authType
    : "internal";
}

/**
 * Bind a freshly minted `state` to the caller of /authorize. Returns the
 * initiator record to store inside the state; for session-started flows it
 * also sets the nonce cookie on `c`'s response (call before c.redirect()).
 */
export async function bindOAuthInitiator(
  c: Context,
  input: {
    state: string;
    tenantId: string;
    userId?: string;
    authType?: string;
    /** https → Secure cookie. */
    baseUrl: string;
    ttlSeconds?: number;
  },
): Promise<OAuthInitiator> {
  const ttl = input.ttlSeconds ?? OAUTH_STATE_TTL_SECONDS;
  const auth = normalizeAuth(input.authType);
  const initiator: OAuthInitiator = {
    tenant_id: input.tenantId,
    ...(input.userId ? { user_id: input.userId } : {}),
    auth,
    expires_at: Date.now() + ttl * 1000,
  };
  if (auth === "session") {
    const nonce = randomNonce();
    initiator.nonce_hash = await sha256Base64url(nonce);
    setCookie(c, await cookieNameFor(input.state), nonce, {
      path: COOKIE_PATH,
      httpOnly: true,
      sameSite: "Lax",
      secure: input.baseUrl.startsWith("https:"),
      maxAge: ttl,
    });
  }
  return initiator;
}

/** Minimal KV surface shared by Node's services.kv and CF's services.kv. */
export interface OAuthStartKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

/** Query param carrying the one-time token minted by the confirm page. */
export const OAUTH_START_CONFIRM_PARAM = "oauth_confirm";
const START_CONFIRM_TTL_SECONDS = 300;

export type OAuthStartGate =
  | { kind: "ok" }
  | { kind: "refuse"; reason: string }
  /** Render `html` (with `headers`) instead of starting the flow. */
  | { kind: "confirm"; html: string; headers: Record<string, string> };

/** The /authorize request minus the confirm token, order-independent. */
function startRequestKey(c: Context): string {
  const u = new URL(c.req.url);
  u.searchParams.delete(OAUTH_START_CONFIRM_PARAM);
  u.searchParams.sort();
  return `${u.pathname}?${u.searchParams.toString()}`;
}

/**
 * Decide whether a cookie-session /authorize may start a flow. Non-browser
 * callers (API keys, internal dispatch) aren't session-bound and pass.
 *
 *   - Sec-Fetch-Site cross-site / same-site → refused.
 *   - same-origin (the console's popup) → starts.
 *   - "none" or no header → a confirm page first. "none" is every
 *     navigation without a web initiator — typed URLs, but also links
 *     opened from Slack, email or chat desktop apps — and older browsers
 *     send nothing, so neither proves the user meant to start. The page's
 *     Continue link carries a one-time token bound to this user and this
 *     exact request, which only a reader of the page (our origin) has.
 */
export async function gateOAuthStart(
  c: Context,
  input: { authType?: string; tenantId: string; userId?: string; kv: OAuthStartKv; target: string },
): Promise<OAuthStartGate> {
  if (normalizeAuth(input.authType) !== "session") return { kind: "ok" };
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return { kind: "refuse", reason: "This connection was started from another site. Start it again from the console." };
  }
  const requestKey = startRequestKey(c);
  const token = c.req.query(OAUTH_START_CONFIRM_PARAM);
  if (token) {
    const key = `oauth_start:${await sha256Base64url(token)}`;
    const raw = await input.kv.get(key);
    if (raw) await input.kv.delete(key);
    let rec: { tenant_id?: string; user_id?: string; request?: string; expires_at?: number } | null = null;
    try {
      rec = raw ? JSON.parse(raw) : null;
    } catch {
      rec = null;
    }
    if (
      !rec ||
      rec.tenant_id !== input.tenantId ||
      rec.user_id !== input.userId ||
      rec.request !== requestKey ||
      typeof rec.expires_at !== "number" ||
      Date.now() > rec.expires_at
    ) {
      return { kind: "refuse", reason: "This confirmation is no longer valid. Start the connection again from the console." };
    }
    return { kind: "ok" };
  }
  if (site === "same-origin") return { kind: "ok" };

  const fresh = randomNonce();
  await input.kv.put(
    `oauth_start:${await sha256Base64url(fresh)}`,
    JSON.stringify({
      tenant_id: input.tenantId,
      user_id: input.userId,
      request: requestKey,
      expires_at: Date.now() + START_CONFIRM_TTL_SECONDS * 1000,
    }),
    { expirationTtl: START_CONFIRM_TTL_SECONDS },
  );
  const u = new URL(c.req.url);
  u.searchParams.set(OAUTH_START_CONFIRM_PARAM, fresh);
  const continueHref = `${u.pathname}${u.search}`;
  const target = escapeHtml(input.target);
  return {
    kind: "confirm",
    headers: {
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
      "Referrer-Policy": "no-referrer",
    },
    html: `<!doctype html><html><head><meta charset="utf-8"><title>Connect ${target}?</title></head>
<body style="font-family:system-ui;max-width:36rem;margin:3rem auto;line-height:1.5">
<h2>Connect ${target}?</h2>
<p>This link signs in to <strong>${target}</strong> and saves that login in your workspace.
Continue only if you started this connection yourself.</p>
<p><a href="${escapeHtml(continueHref)}">Continue</a> &nbsp; <span style="color:#888">or close this window to cancel.</span></p>
</body></html>`,
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!
  ));
}

/**
 * JSON for an inline <script>: JSON.stringify leaves `<` alone, so a value
 * holding `</script>` (a provider's error text, an MCP server's probe
 * body) would end the script element and run as markup on our origin.
 */
export function inlineScriptJson(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export type OAuthInitiatorCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify the browser finishing the flow is the one that started it. Caller
 * identity comes from the auth middleware in front of /callback. Clears the
 * flow's nonce cookie either way (the state is single use).
 */
export async function verifyOAuthInitiator(
  c: Context,
  input: {
    state: string;
    initiator: OAuthInitiator | undefined;
    callerTenantId?: string;
    callerUserId?: string;
    now?: number;
  },
): Promise<OAuthInitiatorCheck> {
  const name = await cookieNameFor(input.state);
  const presented = getCookie(c, name);
  if (presented !== undefined) deleteCookie(c, name, { path: COOKIE_PATH });

  const init = input.initiator;
  if (!init || typeof init.tenant_id !== "string" || typeof init.expires_at !== "number") {
    // States written before initiator binding (in flight across a deploy).
    return { ok: false, reason: "This sign-in link is no longer valid. Start the connection again." };
  }
  if ((input.now ?? Date.now()) > init.expires_at) {
    return { ok: false, reason: "This sign-in link expired. Start the connection again." };
  }
  if (init.user_id) {
    if (input.callerUserId !== init.user_id) {
      return {
        ok: false,
        reason:
          "This sign-in was started by a different user. Sign in to the console as the user who started it, then start the connection again.",
      };
    }
  } else if (input.callerTenantId !== init.tenant_id) {
    return {
      ok: false,
      reason: "This sign-in was started in a different workspace. Start the connection again from this workspace.",
    };
  }
  if (init.nonce_hash) {
    if (!presented || (await sha256Base64url(presented)) !== init.nonce_hash) {
      return {
        ok: false,
        reason: "This sign-in must finish in the browser that started it. Start the connection again here.",
      };
    }
  }
  return { ok: true };
}
