const BASE = "";

import { useCallback, useMemo } from "react";
import { toast } from "sonner";
import { FatalSseError, streamSse } from "./sse";
import { getClerkBearerToken } from "./clerk-auth";
import { failureSentence } from "./failure-text";
import { reportReadFailure } from "./read-failures";

/**
 * Telling the person a request failed, when the caller does not do it
 * itself (`silentErrors`).
 *
 * A write that fails says so at once, in a whole sentence: the server's own
 * when it wrote one, ours around its word when it sent a bare token
 * ("unavailable"). A read that fails is drawn where its data would have
 * been, so it only raises a toast when nothing on the page reports it
 * (lib/read-failures.ts).
 */
function tellFailure(method: string | undefined, error: unknown): void {
  const isRead = !method || method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD";
  if (isRead) reportReadFailure(error);
  else toast.error(failureSentence(error));
}

/**
 * Server error envelope after the Anthropic-compatible migration:
 *   { type: "error", error: { type, message }, request_id? }
 * Older endpoints still emit the bare-string shape `{ error: "<string>" }`,
 * which we read defensively in `readApiError`.
 */
interface ApiErrorBody {
  type?: "error";
  error?:
    | string
    | {
        type?: string;
        message?: string;
      };
  request_id?: string;
}

export interface ApiErrorInfo {
  /** Stable error code from the server, e.g. `"not_a_member"`. Empty
   *  string when the response only carried a message. */
  code: string;
  /** Human-readable message, suitable for toasts. Falls back to
   *  `HTTP <status>` when the body had nothing usable. */
  message: string;
}

/** Parse `{code, message}` out of an API response body. Handles both the
 *  current Anthropic-style envelope and the legacy bare-string shape so
 *  callers can dispatch on `code` (stable wire-format identifier) without
 *  ever string-matching the human message. */
export function readApiError(body: unknown, status: number): ApiErrorInfo {
  if (body && typeof body === "object") {
    const e = (body as ApiErrorBody).error;
    if (typeof e === "string") return { code: "", message: e };
    if (e && typeof e === "object") {
      return {
        code: typeof e.type === "string" ? e.type : "",
        message: typeof e.message === "string" ? e.message : `HTTP ${status}`,
      };
    }
  }
  return { code: "", message: `HTTP ${status}` };
}

/** Back-compat wrapper for the older message-only callers (readApiErrorMessage
 *  was the single export before the `code` channel existed). New code should
 *  reach for `readApiError` and use `code` for dispatch. */
export function readApiErrorMessage(body: unknown, status: number): string {
  return readApiError(body, status).message;
}

/**
 * Structured API error. Replaces the previous `Error & { status?: number }`
 * property-extension trick — callers branch on `err instanceof ApiError`
 * and then read `status` / `code` rather than poking at an Error object's
 * tacked-on properties (which break under structuredClone, Error
 * subclassing, and most error-reporting libraries).
 */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId?: string;

  constructor(info: ApiErrorInfo & { status: number; requestId?: string }) {
    super(info.message);
    this.name = "ApiError";
    this.status = info.status;
    this.code = info.code;
    this.requestId = info.requestId;
  }
}

/** The `code` of the ApiError (status 404) raised when a `/v1` path answers
 *  with a web page instead of JSON: the server has no such endpoint. */
export const NOT_ON_SERVER_CODE = "not_on_server";

const NOT_ON_SERVER: ApiErrorInfo = {
  code: NOT_ON_SERVER_CODE,
  message: "This server does not have that feature.",
};

/** True when `err` says the endpoint is not on this server: a 404 (including
 *  the `not_on_server` one above) or a 501. */
export function isNotOnServer(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 404 || err.status === 501);
}

function isApiPath(path: string): boolean {
  const p = path.startsWith("http") ? (() => { try { return new URL(path).pathname; } catch { return path; } })() : path;
  return p.startsWith("/v1/") || p === "/v1" || p.startsWith("/public/v1/");
}

/** A 2xx body that is a web page, not JSON (or empty). */
function looksLikeHtml(res: Response, text: string): boolean {
  const type = (res.headers.get("content-type") || "").toLowerCase();
  if (type.includes("text/html")) return true;
  if (type.includes("json")) return false;
  return /^\s*</.test(text);
}

/** localStorage key for the active tenant the Console wants to operate as.
 *  Sent on every /v1/* request as `x-active-tenant`; the backend validates
 *  membership before honoring. Single-tenant users never write this. */
export const ACTIVE_TENANT_KEY = "oma_active_tenant_id";

export function getActiveTenantId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_TENANT_KEY);
  } catch {
    return null;
  }
}

export function setActiveTenantId(id: string | null): void {
  try {
    if (id) localStorage.setItem(ACTIVE_TENANT_KEY, id);
    else localStorage.removeItem(ACTIVE_TENANT_KEY);
  } catch {
    // localStorage may be disabled (private mode, embedded webview);
    // the user just won't get the multi-tenant switcher.
  }
}

/** Endpoints whose 401/403 are part of normal app flow and should NOT
 *  surface as a toast. /auth-info is checked on every page load to decide
 *  whether to show the login screen — a 401 means "not logged in", which
 *  the login screen already communicates. /v1/me 401 is handled the same
 *  way by the sidebar bootstrapping path. */
const SILENT_AUTH_PATHS = ["/auth-info", "/v1/me"];

function shouldSilenceAuthError(path: string, status: number): boolean {
  if (status !== 401 && status !== 403) return false;
  return SILENT_AUTH_PATHS.some((p) => path === p || path.startsWith(`${p}?`));
}

export function useApi() {
  // `api` and `streamEvents` are wrapped in useCallback with an empty dep
  // list so a render of any consumer doesn't produce a fresh closure.
  // Before this, every component calling `useApi()` got new function identities
  // each render — including them in a `useEffect` dep array would loop the
  // effect, so callers had to either omit `api` (eslint-disable) or stash it
  // in a ref. With these stable refs, `useApiQuery` / `useInfiniteApiQuery` /
  // `useEffect([id])` can include `api` cleanly without retriggering.
  // `toast` is imported from sonner at module scope; the module-level
  // function reference is stable across renders.
  const api = useCallback(
    async function api<T = unknown>(
      path: string,
      init?: RequestInit & {
        /** Suppress the automatic error toast for non-OK responses. For
         *  probe-style calls where a failure is part of normal flow (e.g.
         *  a 501 from a runtime that lacks the endpoint) and the caller
         *  renders the outcome itself. The `ApiError` still throws. */
        silentErrors?: boolean;
        /** Suppress the toast for a 404 only. For reads of one record,
         *  where "it does not exist" is a state the page draws itself (a
         *  not-found page, a "no longer exists" reference). Other failures
         *  still toast. */
        quietNotFound?: boolean;
      }
    ): Promise<T> {
      const activeTenant = getActiveTenantId();
      // Don't auto-set JSON content-type for FormData — the browser must add
      // multipart boundaries itself, and a manually set content-type without
      // the boundary breaks parsing on the server.
      const isFormData = init?.body instanceof FormData;
      // Clerk mode: short-lived session JWT per request (null when Clerk
      // is disabled or signed out — better-auth cookies still ride along
      // via credentials: "include").
      const clerkToken = await getClerkBearerToken();
      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, {
          ...init,
          credentials: "include",
          headers: {
            ...(init?.body && !isFormData ? { "content-type": "application/json" } : {}),
            ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
            // Pin the workspace for this request. Backend validates membership;
            // a stale value (deleted tenant, removed membership) yields 403 and
            // the sidebar's catch-and-retry path clears + reloads.
            ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
            ...init?.headers,
          },
        });
      } catch (err) {
        // Network-level failure (DNS, CORS, offline, request aborted by route
        // change).
        const msg = err instanceof Error ? err.message : "network error";
        // Don't report aborted requests (component unmount is a normal flow).
        if (!(err instanceof DOMException && err.name === "AbortError")) {
          // The browser's own words ("Failed to fetch") go to the console for
          // dev triage; the person is told the server could not be reached.
          console.error(`[api] ${(init?.method || "GET")} ${path}: ${msg}`);
          // A caller that draws the failure itself (`silentErrors`: a notice
          // on the composer, a Try again in place) gets no second copy of it.
          if (!init?.silentErrors) tellFailure(init?.method, err);
        }
        throw err;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const info = readApiError(body, res.status);
        const requestId = (body as { request_id?: unknown })?.request_id;

        // Safety net for stale-tenant lockout. The primary fix is in Login.tsx
        // (clears localStorage on every successful auth transition). This still
        // catches edge cases the login fix can't:
        //   - User opens 2 tabs, signs out + signs in as a different user in
        //     tab A; tab B still has the old user's tenant pin in localStorage
        //   - A tenant the user belonged to gets revoked while they're already
        //     logged in
        //   - Cross-domain edge cases where localStorage carries over via
        //     extension / shared profile sync
        // Dispatch on the stable wire-format code (`not_a_member`) rather
        // than the human message — the backend emits this from auth.ts /
        // http-routes/tenants/index.ts / apps/main/src/auth.ts via the
        // Anthropic-style envelope. Reload-loop guard prevents bouncing if
        // 403 is from some unrelated membership check.
        if (
          res.status === 403 &&
          activeTenant &&
          info.code === "not_a_member" &&
          !sessionStorage.getItem("oma_tenant_self_heal")
        ) {
          sessionStorage.setItem("oma_tenant_self_heal", "1");
          setActiveTenantId(null);
          toast.info("Reset stored workspace pin (was unrecognized) — reloading");
          // Give the toast a tick to render before navigation.
          setTimeout(() => location.reload(), 250);
          throw new ApiError({ ...info, status: res.status });
        }

        // Surface non-OK responses to the user. Silently dropped errors had us
        // chasing "why don't I see anything" issues for far too long; almost
        // every endpoint failure here is something the user could act on
        // (re-login, switch tenant, retry) once they know it happened.
        //
        // What is said is a sentence (`failureSentence`): the server's
        // message when it is one, never a bare token such as "unavailable",
        // and never the API path. Path + status go to the console for dev
        // triage. A read is only toasted when the page does not report it.
        const failure = new ApiError({
          ...info,
          status: res.status,
          requestId: typeof requestId === "string" ? requestId : undefined,
        });
        const drawnInPlace = init?.silentErrors || (init?.quietNotFound && res.status === 404);
        if (!drawnInPlace && !shouldSilenceAuthError(path, res.status)) {
          console.error(`[api] ${res.status} ${path}: ${info.message}`);
          tellFailure(init?.method, failure);
        }
        throw failure;
      }
      // Successful response — clear the self-heal sentinel so a future stale
      // tenant can self-heal again later in the same browser session.
      sessionStorage.removeItem("oma_tenant_self_heal");
      // Some endpoints return a success with no body (e.g. POST /events → 202,
      // 204 No Content). res.json() rejects on an empty string, which would
      // turn a successful write into a thrown error for the caller. Parse
      // defensively: empty body → undefined.
      const text = await res.text();
      // A server whose console fallback answers every unknown GET with the
      // app page (index.html, 200) means "this server has no such endpoint".
      // Report it as the 404 it is, so the quiet 404 handling everywhere
      // (useQuietQuery, quietNotFound, feature probes) applies instead of a
      // JSON SyntaxError.
      if (isApiPath(path) && looksLikeHtml(res, text)) {
        const failure = new ApiError({ ...NOT_ON_SERVER, status: 404 });
        const drawnInPlace = init?.silentErrors || init?.quietNotFound;
        if (!drawnInPlace) {
          console.error(`[api] 404 (not on this server) ${path}`);
          tellFailure(init?.method, failure);
        }
        throw failure;
      }
      return (text ? JSON.parse(text) : undefined) as T;
    },
    [],
  );

  const streamEvents = useCallback(
    (
      sessionId: string,
      onEvent: (event: Record<string, unknown>) => void,
      signal?: AbortSignal,
    ) => {
      const activeTenant = getActiveTenantId();
      // SSE endpoint goes through the same auth middleware so it needs the
      // header too. The native fetch we use under the hood lets us set it;
      // EventSource wouldn't.
      //
      // Console opts into both `chunks` (token-by-token rendering, pending
      // queue events, session.warning, extra spans) and `replay=1` (full
      // history on connect — Console renders the persistent timeline view
      // and the dedup keyset at SessionDetail.tsx:108-121 already handles
      // any seq-overlap from concurrent live broadcasts; replay-on-reconnect
      // is therefore safe — duplicates get dropped before render).
      //
      // Default endpoint behavior is Anthropic-spec — third-party clients
      // using @anthropic-ai/sdk against an OMA server get a clean stream
      // without these flags. See SPEC_EVENT_TYPES in @open-managed-agents/api-types.
      const path = `/v1/sessions/${sessionId}/events/stream?include=chunks&replay=1`;

      // Reconnect schedule for transient failures (network blip, 5xx, EOF).
      // Resets to zero on a successful onOpen so a healthy session that
      // briefly drops doesn't keep accumulating backoff. After 5 consecutive
      // failures we surface a single "Reconnecting…" toast — silent before
      // that so a 1-second blip doesn't pop UI noise.
      const backoffMs = [1000, 2000, 4000, 8000];
      let consecutiveFailures = 0;
      let reconnectToastShown = false;

      void streamSse(path, {
        signal,
        // Factory: re-resolved on every (re)connect so a fresh Clerk token
        // is attached — the static form would go stale mid-stream.
        headers: async () => {
          const clerkToken = await getClerkBearerToken();
          return {
            ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
            ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
          };
        },
        async onOpen(response) {
          if (response.ok) {
            // Connection (re)established — clear the failure counter so the
            // next drop starts a fresh backoff schedule, and clear the toast
            // sentinel so a future degraded period can re-notify the user.
            consecutiveFailures = 0;
            reconnectToastShown = false;
            return;
          }
          if (response.status >= 500) {
            // 5xx is TRANSIENT here: a backend restart behind the dev proxy
            // answers the reconnect with 502/500 while the server boots —
            // treating that as fatal froze open session pages at their last
            // rendered state (status chip stuck "Running", tools stuck
            // mid-run) until a manual refresh. Fall through to onError's
            // backoff; replay=1 heals the missed events on reconnect.
            throw new Error(`status ${response.status}`);
          }
          if (response.status >= 400) {
            // Surface stream open failures the same way as regular API calls —
            // previously a 401 / 500 on the SSE handshake meant the timeline
            // just never updated.
            const body = await response.json().catch(() => ({}));
            const message = readApiErrorMessage(body, response.status);
            // The server's message, without the API path (debug noise; it
            // is in the console). A 404 raises nothing: the session does not
            // exist, and the page says so itself.
            console.error(`[api] ${response.status} /v1/sessions/${sessionId}/events/stream: ${message}`);
            if (response.status !== 404) {
              toast.error(`The live updates for this session could not start. ${failureSentence(message, response.status)}`);
            }
            // Non-retriable: 401/403/404 won't fix themselves on retry.
            throw new FatalSseError(message);
          }
          // Anything non-ok that isn't ≥400 (3xx etc.) — fall through to
          // onError for the retry decision.
          throw new Error(`status ${response.status}`);
        },
        onMessage(data) {
          try {
            onEvent(JSON.parse(data) as Record<string, unknown>);
          } catch {
            // Malformed payload — silently skip, matches prior behavior.
          }
        },
        onError(err) {
          // FatalSseError or caller abort never reach here — streamSse
          // re-throws them directly. Everything else is a transient
          // failure: stream closed cleanly, network blip, transient
          // 5xx. Apply the backoff schedule and reconnect.
          if (err instanceof FatalSseError) return null;
          consecutiveFailures += 1;
          if (consecutiveFailures === 5 && !reconnectToastShown) {
            reconnectToastShown = true;
            toast.info("Reconnecting…");
          }
          const idx = Math.min(consecutiveFailures - 1, backoffMs.length - 1);
          return backoffMs[idx];
        },
      }).catch(() => {
        // Promise rejects on FatalSseError (already toasted) or an abort
        // we missed — both are expected terminal states. Nothing more to do.
      });
    },
    [],
  );

  return useMemo(() => ({ api, streamEvents }), [api, streamEvents]);
}
