import { isComposioMcpUrl, normalizeMcpServerUrl } from "@open-managed-agents/shared";

export const SENSITIVE_UPSTREAM_AUTH_HEADERS = ["authorization", "x-api-key"] as const;

export type NodeMcpProxyTarget = {
  upstreamUrl: string;
  upstreamToken: string;
  upstreamAuthHeader?: { name: string; value: string };
  /** URL declared on the agent snapshot; may differ when a vault credential rewrites upstreamUrl. */
  declaredServerUrl?: string;
  /** Present for mcp_oauth credentials that can be refreshed. Lets the
   *  proxy renew an expired access token (pre-emptively via expiresAtMs,
   *  or on a 401) instead of failing every call until the user reconnects
   *  — Sentry's MCP tokens live one hour. */
  refresh?: NodeMcpProxyRefresh;
};

export type NodeMcpProxyRefresh = {
  refreshToken: string;
  tokenEndpoint: string;
  clientId?: string;
  clientSecret?: string;
  /** Stored expiry (ms since epoch); when within REFRESH_SKEW_MS of now the
   *  proxy refreshes before the first attempt. */
  expiresAtMs?: number;
  /** Persist rotated tokens (best-effort; a failed write only means the
   *  next call refreshes again). */
  persist: (tokens: RefreshedMcpTokens) => Promise<void>;
};

export type RefreshedMcpTokens = {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
};

/** Refresh this far ahead of the stored expiry so a token doesn't die
 *  mid-request. */
export const REFRESH_SKEW_MS = 60_000;

/** RFC 6749 §6 refresh_token grant against the credential's token_endpoint.
 *  Public clients (DCR with token_endpoint_auth_method "none", e.g. Sentry)
 *  send client_id only; confidential presets add client_secret. Returns
 *  null on any failure so the caller can surface the upstream's own 401. */
export async function refreshNodeMcpOAuthToken(
  refresh: Pick<NodeMcpProxyRefresh, "refreshToken" | "tokenEndpoint" | "clientId" | "clientSecret">,
  fetcher: typeof fetch = fetch,
): Promise<RefreshedMcpTokens | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh.refreshToken,
    client_id: refresh.clientId || "open-managed-agents",
  });
  if (refresh.clientSecret) body.set("client_secret", refresh.clientSecret);
  let res: Response;
  try {
    res = await fetcher(refresh.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let tokens: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    tokens = (await res.json()) as typeof tokens;
  } catch {
    return null;
  }
  if (!tokens.access_token) return null;
  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token ?? refresh.refreshToken,
    expires_in: tokens.expires_in,
  };
}

export type McpCredentialCheck = "ok" | "refreshed" | "invalid" | "unreachable";

/**
 * Is this stored credential actually usable against its MCP server?
 * Probes tools/list with the access token; on 401/403 tries a refresh
 * (when refresh metadata exists), persists rotated tokens and re-probes.
 * "unreachable" = network/timeout — the caller decides (setup treats it as
 * "can't tell, assume fine" so a flaky provider doesn't spam connect cards).
 * Added after setup reported Linear + Sentry "already connected" on the
 * strength of expired rows alone (2026-09-02).
 */
export async function verifyMcpCredential(
  input: { url: string; token: string; refresh?: NodeMcpProxyRefresh },
  fetcher: typeof fetch = fetch,
  timeoutMs = 6000,
): Promise<McpCredentialCheck> {
  const probe = async (token: string): Promise<number | null> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetcher(input.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: ac.signal,
      });
      try {
        await res.body?.cancel();
      } catch {
        /* ignore */
      }
      return res.status;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
  const authRejected = (status: number) => status === 401 || status === 403;

  const first = await probe(input.token);
  if (first === null) return "unreachable";
  if (!authRejected(first)) return "ok";
  if (!input.refresh) return "invalid";
  const next = await refreshNodeMcpOAuthToken(input.refresh, fetcher);
  if (!next) return "invalid";
  try {
    await input.refresh.persist(next);
  } catch {
    /* best-effort */
  }
  const second = await probe(next.access_token);
  if (second === null) return "unreachable";
  return authRejected(second) ? "invalid" : "refreshed";
}

/**
 * forwardNodeMcpRequest + token renewal. Order:
 *   1. stored expiry already passed (or about to) → refresh first;
 *   2. upstream answers 401 and we haven't refreshed yet → refresh + retry
 *      once with the same pre-buffered body;
 *   3. refresh fails → re-send with the original token so the caller sees
 *      the upstream's real 401 (matches vault-forward's CF behaviour).
 * `body` must be pre-buffered (string/ArrayBuffer/Uint8Array/null) so the
 * retry can replay it.
 */
export async function forwardNodeMcpRequestWithRefresh(
  target: NodeMcpProxyTarget,
  incomingUrl: string | undefined,
  method: string,
  inboundHeaders: Headers,
  body: string | ArrayBuffer | Uint8Array | null,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Response> {
  const refresh = target.refresh;
  if (!refresh) {
    return forwardNodeMcpRequest(target, incomingUrl, method, inboundHeaders, body, fetcher);
  }

  let token = target.upstreamToken;
  let refreshed = false;
  const renew = async (): Promise<boolean> => {
    const next = await refreshNodeMcpOAuthToken(refresh, fetcher);
    if (!next) return false;
    refreshed = true;
    token = next.access_token;
    try {
      await refresh.persist(next);
    } catch {
      // best-effort persistence
    }
    return true;
  };
  const send = () =>
    forwardNodeMcpRequest(
      { ...target, upstreamToken: token, upstreamAuthHeader: undefined },
      incomingUrl,
      method,
      inboundHeaders,
      body,
      fetcher,
    );

  if (refresh.expiresAtMs !== undefined && refresh.expiresAtMs - now() <= REFRESH_SKEW_MS) {
    await renew();
  }

  const first = await send();
  if (first.status !== 401 || refreshed) return first;
  try {
    await first.body?.cancel();
  } catch {
    /* already consumed */
  }
  if (!(await renew())) return send();
  return send();
}

export function buildNodeMcpForwardUrl(
  target: Pick<NodeMcpProxyTarget, "upstreamUrl" | "declaredServerUrl">,
  incomingUrl?: string,
): string {
  const upstream = new URL(target.upstreamUrl);
  if (!incomingUrl) return upstream.toString();

  let incoming: URL;
  let declared: URL;
  try {
    incoming = new URL(incomingUrl);
    declared = new URL(target.declaredServerUrl || target.upstreamUrl);
  } catch {
    return upstream.toString();
  }

  upstream.search = incoming.search;

  const declaredPath = normalizePath(declared.pathname);
  const incomingPath = normalizePath(incoming.pathname);
  const upstreamPath = normalizePath(upstream.pathname);

  if (incomingPath === declaredPath) return upstream.toString();

  const declaredPrefix = declaredPath === "/" ? "" : declaredPath;
  if (declaredPrefix && incomingPath.startsWith(`${declaredPrefix}/`)) {
    const suffix = incomingPath.slice(declaredPrefix.length);
    upstream.pathname = `${upstreamPath === "/" ? "" : upstreamPath}${suffix}`;
    return upstream.toString();
  }

  if (!target.declaredServerUrl || target.declaredServerUrl === target.upstreamUrl) {
    upstream.pathname = incomingPath;
  }
  return upstream.toString();
}

export async function forwardNodeMcpRequest(
  target: NodeMcpProxyTarget,
  incomingUrl: string | undefined,
  method: string,
  inboundHeaders: Headers,
  body: BodyInit | null,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const upstreamHeaders = new Headers(inboundHeaders);
  for (const header of SENSITIVE_UPSTREAM_AUTH_HEADERS) upstreamHeaders.delete(header);
  const authHeader = target.upstreamAuthHeader ?? {
    name: "authorization",
    value: `Bearer ${target.upstreamToken}`,
  };
  upstreamHeaders.set(authHeader.name, authHeader.value);
  upstreamHeaders.delete("host");
  upstreamHeaders.delete("connection");
  upstreamHeaders.delete("content-length");
  upstreamHeaders.delete("x-forwarded-for");
  upstreamHeaders.delete("x-forwarded-proto");
  upstreamHeaders.delete("x-real-ip");

  return fetcher(new Request(buildNodeMcpForwardUrl(target, incomingUrl), {
    method,
    headers: upstreamHeaders,
    body: ["GET", "HEAD"].includes(method) ? undefined : body,
  }));
}

function normalizePath(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

// ─── Credential ↔ declared server URL match ───────────────────────────────
//
// Which vault credential authenticates a declared MCP server
// (resolveNodeMcpProxyTarget). Vault credentials only AUTHENTICATE the
// agent's declared servers — they no longer add servers of their own (see
// packages/shared/src/vault-mcp-servers.ts) — so a declared URL that differs
// from the stored credential URL only cosmetically (trailing slash, host
// case, query param order) must still match, for every credential type.
// Before, Node matched non-Composio credentials by exact string, so `…/mcp`
// vs `…/mcp/` silently went unauthenticated. The query is NOT cosmetic for
// non-Composio credentials: `…/mcp?project_ref=aaa` and `…?project_ref=bbb`
// are different accounts, so their params must agree. Composio keeps the
// query-free compare (its router URLs cross-match anyway). Mirrored in the
// CF proxy (apps/main/src/routes/mcp-proxy.ts credentialMatchesServerUrl).

export function credentialMatchesMcpServerUrl(
  auth: { type?: string; mcp_server_url?: string },
  serverUrl: string,
): boolean {
  if (!auth.mcp_server_url) return false;
  if (auth.mcp_server_url === serverUrl) return true;
  const credentialUrl = normalizeMcpServerUrl(auth.mcp_server_url);
  if (credentialUrl && credentialUrl === normalizeMcpServerUrl(serverUrl)) {
    if (auth.type === "composio_mcp") return true;
    if (canonicalMcpQuery(auth.mcp_server_url) === canonicalMcpQuery(serverUrl)) return true;
  }
  // Composio: any tool-router URL matches any other — the proxy prefers a
  // concrete per-session router over the generic sentinel among candidates.
  if (auth.type !== "composio_mcp") return false;
  return isComposioMcpUrl(auth.mcp_server_url) && isComposioMcpUrl(serverUrl);
}

/** Search params sorted by key then value, so only their order is cosmetic. */
function canonicalMcpQuery(raw: string): string {
  try {
    const params = [...new URL(raw).searchParams.entries()];
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    params.sort(([ak, av], [bk, bv]) => (ak === bk ? cmp(av, bv) : cmp(ak, bk)));
    return new URLSearchParams(params).toString();
  } catch {
    return "";
  }
}

/**
 * The credentials that may authenticate `serverUrl`, in the order the proxy
 * tries them (first usable one wins): the vault bound for this server
 * (Switch account, `metadata.mcp_vault_bindings`) first, then the rest in
 * listing order; within each, a credential stored under exactly `serverUrl`
 * before a cosmetic look-alike. One vault can hold both `…/mcp/` and
 * `…/mcp` (the unique index is on the raw string, and the OAuth reconnect
 * lookup compares raw strings too), so without the exact-first pass the
 * older look-alike shadowed the exact credential — and once its login
 * lapsed the declared server 401'd for good.
 */
export function orderMatchingCredentials<C extends { auth?: unknown; archived_at?: string | null }>(
  groups: ReadonlyArray<{ vault_id: string; credentials: ReadonlyArray<C> }>,
  serverUrl: string,
  boundVaultId?: string | null,
): Array<{ vault_id: string; credential: C }> {
  const tiers = boundVaultId
    ? [groups.filter((g) => g.vault_id === boundVaultId), groups.filter((g) => g.vault_id !== boundVaultId)]
    : [groups];
  const ordered: Array<{ vault_id: string; credential: C }> = [];
  for (const tier of tiers) {
    const exact: typeof ordered = [];
    const loose: typeof ordered = [];
    for (const group of tier) {
      for (const credential of group.credentials) {
        if (credential.archived_at) continue;
        const auth = credential.auth as { type?: string; mcp_server_url?: string } | null | undefined;
        if (!auth || !credentialMatchesMcpServerUrl(auth, serverUrl)) continue;
        (auth.mcp_server_url === serverUrl ? exact : loose).push({ vault_id: group.vault_id, credential });
      }
    }
    ordered.push(...exact, ...loose);
  }
  return ordered;
}
