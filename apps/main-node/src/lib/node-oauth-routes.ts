import { Hono } from "hono";
import type { CredentialAuth } from "@open-managed-agents/shared";
import type { RouteServices } from "@open-managed-agents/http-routes";

interface OAuthState {
  tenant_id: string;
  vault_id: string;
  credential_id?: string;
  mcp_server_url: string;
  code_verifier: string;
  client_id: string;
  client_secret?: string;
  token_endpoint: string;
  authorization_server: string;
  redirect_uri: string;
  resource_uri: string;
  /** KV key of the cached dynamic client registration this flow used —
   *  deleted when token exchange reports invalid_client. */
  dcr_cache_key?: string;
}

interface ProtectedResourceMeta {
  resource: string;
  authorization_servers: string[];
  scopes_supported?: string[];
}

interface AuthServerMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  scopes_supported?: string[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
}

export interface NodeOAuthRoutesDeps {
  services: RouteServices;
  env?: Record<string, string | undefined>;
}

type NodeOAuthVars = {
  Variables: { tenant_id: string; user_id?: string };
};

export function buildNodeOAuthRoutes(deps: NodeOAuthRoutesDeps): Hono<NodeOAuthVars> {
  const app = new Hono<NodeOAuthVars>();

  app.get("/authorize", async (c) => {
    const mcpServerUrl = c.req.query("mcp_server_url");
    const vaultId = c.req.query("vault_id");
    const credentialId = c.req.query("credential_id");
    const clientRedirectUri = c.req.query("redirect_uri");

    if (!mcpServerUrl || !vaultId) {
      return c.json({ error: "mcp_server_url and vault_id are required" }, 400);
    }

    let parsedMcpUrl: URL;
    try {
      parsedMcpUrl = new URL(mcpServerUrl);
    } catch {
      return c.json({ error: "mcp_server_url must be an absolute URL" }, 400);
    }
    if (parsedMcpUrl.protocol !== "https:" && parsedMcpUrl.hostname !== "localhost") {
      return c.json({ error: "mcp_server_url must use https, except localhost during development" }, 400);
    }

    const tenantId = c.get("tenant_id");
    const vault = await deps.services.vaults.get({ tenantId, vaultId });
    if (!vault) return c.json({ error: "Vault not found" }, 404);

    const baseUrl = getBaseUrl(c.req.url);
    const callbackUri = `${baseUrl}/v1/oauth/callback`;
    let meta: Awaited<ReturnType<typeof discoverOAuthMeta>>;
    try {
      meta = await discoverOAuthMeta(mcpServerUrl);
    } catch (err) {
      return c.html(closeHtml("OAuth discovery failed", htmlEscape((err as Error).message)), 502);
    }

    const callerClientId = c.req.query("client_id");
    const callerClientSecret = c.req.query("client_secret");
    let clientId: string | null = callerClientId || null;
    let clientSecret: string | undefined = callerClientSecret || undefined;

    // One dynamically-registered client per (issuer, callback), cached — a
    // fresh registration on every attempt spams the provider's client store
    // and aggravates proxy-state failures on retries (mcp.linear.app's
    // "Invalid flow state"). Invalidated on invalid_client at token exchange.
    const dcrCacheKey = `oauth_dcr:${meta.authServer.issuer}|${callbackUri}`;
    if (!clientId && meta.authServer.registration_endpoint) {
      const cached = await deps.services.kv.get(dcrCacheKey).catch(() => null);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as { client_id: string; client_secret?: string };
          clientId = parsed.client_id;
          clientSecret = parsed.client_secret;
        } catch {
          // fall through to fresh registration
        }
      }
      if (!clientId) {
        const reg = await dynamicClientRegistration(
          meta.authServer.registration_endpoint,
          callbackUri,
        );
        if (reg) {
          clientId = reg.client_id;
          clientSecret = reg.client_secret;
          await deps.services.kv
            .put(dcrCacheKey, JSON.stringify({ client_id: reg.client_id, client_secret: reg.client_secret }), {
              expirationTtl: 60 * 60 * 24 * 30,
            })
            .catch(() => {});
        }
      }
    }

    if (!clientId) {
      const preset = presetForIssuer(meta.authServer.issuer);
      if (preset) {
        const presetClientId = envValue(deps.env, preset.clientIdEnv);
        const presetClientSecret = envValue(deps.env, preset.clientSecretEnv);
        if (presetClientId && presetClientSecret) {
          clientId = presetClientId;
          clientSecret = presetClientSecret;
        } else {
          return c.html(
            closeHtml(
              `${preset.label} MCP OAuth needs a pre-registered app`,
              htmlEscape(
                `Create an OAuth app with callback ${callbackUri}, then set ${preset.clientIdEnv} and ${preset.clientSecretEnv} on the main-node server and retry.`,
              ),
            ),
            501,
          );
        }
      }
    }

    if (!clientId) {
      return c.html(
        closeHtml(
          "OAuth client unavailable",
          htmlEscape(
            `MCP server ${mcpServerUrl} does not support Dynamic Client Registration and no preset client_id is configured for issuer ${meta.authServer.issuer}.`,
          ),
        ),
        501,
      );
    }

    const codeVerifier = randomString(64);
    const codeChallenge = await sha256Base64url(codeVerifier);
    const state = randomString(32);
    const oauthState: OAuthState = {
      tenant_id: tenantId,
      vault_id: vaultId,
      credential_id: credentialId,
      mcp_server_url: mcpServerUrl,
      code_verifier: codeVerifier,
      client_id: clientId,
      client_secret: clientSecret,
      token_endpoint: meta.authServer.token_endpoint,
      authorization_server: meta.authServer.issuer,
      redirect_uri: clientRedirectUri || `${baseUrl}/`,
      resource_uri: meta.resource.resource,
      dcr_cache_key: dcrCacheKey,
    };

    await deps.services.kv.put(`oauth_state:${state}`, JSON.stringify(oauthState), {
      expirationTtl: 600,
    });

    const authUrl = new URL(meta.authServer.authorization_endpoint);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", callbackUri);
    authUrl.searchParams.set("state", state);
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("resource", meta.resource.resource);
    const requestedScope = c.req.query("scope");
    if (requestedScope) {
      authUrl.searchParams.set("scope", requestedScope);
    } else if (meta.resource.scopes_supported?.length) {
      authUrl.searchParams.set("scope", meta.resource.scopes_supported.join(" "));
    }

    return c.redirect(authUrl.toString());
  });

  app.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const error = c.req.query("error");

    if (error) {
      const desc = c.req.query("error_description") || error;
      return c.html(closeHtml("Authorization failed", htmlEscape(desc)), 400);
    }
    if (!code || !state) {
      return c.json({ error: "code and state are required" }, 400);
    }

    const stateKey = `oauth_state:${state}`;
    const stateData = await deps.services.kv.get(stateKey);
    if (!stateData) return c.json({ error: "Invalid or expired OAuth state" }, 400);
    const oauthState = JSON.parse(stateData) as OAuthState;

    const baseUrl = getBaseUrl(c.req.url);
    const tokenBody = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: `${baseUrl}/v1/oauth/callback`,
      client_id: oauthState.client_id,
      code_verifier: oauthState.code_verifier,
      resource: oauthState.resource_uri,
    });
    if (oauthState.client_secret) tokenBody.set("client_secret", oauthState.client_secret);

    const tokenRes = await fetch(oauthState.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text().catch(() => "");
      await deps.services.kv.delete(stateKey);
      // A dead cached registration surfaces as invalid_client — drop it so
      // the next attempt re-registers instead of failing forever.
      if (oauthState.dcr_cache_key && /invalid_client/i.test(errBody)) {
        await deps.services.kv.delete(oauthState.dcr_cache_key).catch(() => {});
      }
      return c.html(closeHtml("Token exchange failed", htmlEscape(errBody || String(tokenRes.status))), 502);
    }

    const tokens = await readTokenResponse(tokenRes);
    if (!tokens.access_token) {
      await deps.services.kv.delete(stateKey);
      return c.html(closeHtml("Token exchange failed", "Provider did not return an access token."), 502);
    }

    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;
    const mcpHost = new URL(oauthState.mcp_server_url).hostname;
    const serverName = mcpHost.replace(/^mcp\./, "").replace(/\.(com|app|dev|io)$/, "");
    const credAuth: CredentialAuth = {
      type: "mcp_oauth",
      mcp_server_url: oauthState.mcp_server_url,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      token_endpoint: oauthState.token_endpoint,
      client_id: oauthState.client_id,
      client_secret: oauthState.client_secret,
      expires_at: expiresAt,
      authorization_server: oauthState.authorization_server,
    };

    if (oauthState.credential_id) {
      await deps.services.credentials
        .update({
          tenantId: oauthState.tenant_id,
          vaultId: oauthState.vault_id,
          credentialId: oauthState.credential_id,
          auth: credAuth,
        })
        .catch(() => {});
    } else {
      await deps.services.credentials.create({
        tenantId: oauthState.tenant_id,
        vaultId: oauthState.vault_id,
        displayName: `${serverName} (OAuth)`,
        auth: credAuth,
      });
    }

    await deps.services.kv.delete(stateKey);
    const probeResult = await probeMcpServer(oauthState.mcp_server_url, tokens.access_token);

    const redirectUrl = new URL(oauthState.redirect_uri);
    redirectUrl.searchParams.set("oauth", "success");
    redirectUrl.searchParams.set("service", serverName);
    redirectUrl.searchParams.set("probe_ok", probeResult.ok ? "1" : "0");
    if (probeResult.message) redirectUrl.searchParams.set("probe_message", probeResult.message);

    return c.html(`
      <html><body>
      <p>Connected to ${htmlEscape(serverName)}. Closing...</p>
      <script>
        (function(){
          var msg = ${JSON.stringify({
            type: "oauth_complete",
            service: serverName,
            vault_id: oauthState.vault_id,
            probe_ok: probeResult.ok,
            probe_message: probeResult.message ?? null,
          })};
          var notified = false;
          try {
            if (window.opener && !window.opener.closed) {
              window.opener.postMessage(msg, "*");
              notified = true;
            }
          } catch (e) {}
          try {
            var bc = new BroadcastChannel("openma-oauth");
            bc.postMessage(msg);
            bc.close();
            notified = true;
          } catch (e) {}
          if (notified) window.close();
          else window.location.href = ${JSON.stringify(redirectUrl.toString())};
        })();
      </script>
      </body></html>
    `);
  });

  app.post("/refresh", async (c) => {
    const body = await c.req.json<{ vault_id?: string; credential_id?: string }>();
    if (!body.vault_id || !body.credential_id) {
      return c.json({ error: "vault_id and credential_id are required" }, 400);
    }
    const tenantId = c.get("tenant_id");
    const cred = await deps.services.credentials.get({
      tenantId,
      vaultId: body.vault_id,
      credentialId: body.credential_id,
    });
    if (!cred) return c.json({ error: "Credential not found" }, 404);
    if (cred.auth.type !== "mcp_oauth") {
      return c.json({ error: "Credential is not mcp_oauth type" }, 400);
    }
    if (!cred.auth.refresh_token || !cred.auth.token_endpoint) {
      return c.json({ error: "No refresh_token or token_endpoint" }, 400);
    }

    const tokenBody = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: cred.auth.refresh_token,
      client_id: cred.auth.client_id || "open-managed-agents",
    });
    if (cred.auth.client_secret) tokenBody.set("client_secret", cred.auth.client_secret);

    const tokenRes = await fetch(cred.auth.token_endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: tokenBody.toString(),
    });
    if (!tokenRes.ok) return c.json({ error: "Token refresh failed", status: tokenRes.status }, 502);

    const tokens = await readTokenResponse(tokenRes);
    if (!tokens.access_token) return c.json({ error: "Provider did not return an access token" }, 502);
    const expiresAt = tokens.expires_in
      ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
      : undefined;
    await deps.services.credentials.refreshAuth({
      tenantId,
      vaultId: body.vault_id,
      credentialId: body.credential_id,
      auth: {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? cred.auth.refresh_token,
        expires_at: expiresAt,
      },
    });
    return c.json({ access_token: tokens.access_token, expires_at: expiresAt });
  });

  return app;
}

function getBaseUrl(rawUrl: string): string {
  const url = new URL(rawUrl);
  return `${url.protocol}//${url.host}`;
}

function randomString(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("").slice(0, length);
}

async function sha256Base64url(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return Buffer.from(hash).toString("base64url");
}

async function discoverOAuthMeta(mcpServerUrl: string): Promise<{
  resource: ProtectedResourceMeta;
  authServer: AuthServerMeta;
}> {
  const url = new URL(mcpServerUrl);
  const origin = url.origin;
  const path = url.pathname.replace(/\/+$/, "");
  const prmCandidates = [
    ...(path ? [`${origin}/.well-known/oauth-protected-resource${path}`] : []),
    `${origin}/.well-known/oauth-protected-resource`,
  ];

  let resource: ProtectedResourceMeta | null = null;
  let lastErr = "";
  for (const candidateUrl of prmCandidates) {
    const res = await fetch(candidateUrl);
    if (res.ok) {
      resource = (await res.json()) as ProtectedResourceMeta;
      break;
    }
    lastErr = `${candidateUrl}: ${res.status}`;
  }
  if (!resource) {
    throw new Error(`Failed to fetch Protected Resource Metadata (tried ${prmCandidates.length}): ${lastErr}`);
  }
  if (!resource.authorization_servers?.length) {
    throw new Error("No authorization_servers in Protected Resource Metadata");
  }

  const authServerUrl = resource.authorization_servers[0];
  const issuer = new URL(authServerUrl);
  const issuerOrigin = issuer.origin;
  const issuerPath = issuer.pathname.replace(/\/+$/, "");
  const asmCandidates = [
    ...(issuerPath
      ? [
          `${issuerOrigin}/.well-known/oauth-authorization-server${issuerPath}`,
          `${issuerOrigin}/.well-known/openid-configuration${issuerPath}`,
        ]
      : []),
    `${issuerOrigin}/.well-known/oauth-authorization-server`,
    `${issuerOrigin}/.well-known/openid-configuration`,
    `${authServerUrl}/.well-known/oauth-authorization-server`,
  ];

  let authServer: AuthServerMeta | null = null;
  let asmLastErr = "";
  for (const candidateUrl of asmCandidates) {
    const res = await fetch(candidateUrl);
    if (res.ok) {
      authServer = (await res.json()) as AuthServerMeta;
      break;
    }
    asmLastErr = `${candidateUrl}: ${res.status}`;
  }

  if (!authServer && /^https:\/\/github\.com\/login\/oauth\/?$/.test(authServerUrl)) {
    authServer = {
      issuer: "https://github.com/login/oauth",
      authorization_endpoint: "https://github.com/login/oauth/authorize",
      token_endpoint: "https://github.com/login/oauth/access_token",
    };
  }

  if (!authServer) {
    throw new Error(`Failed to fetch Auth Server Metadata (tried ${asmCandidates.length}): ${asmLastErr}`);
  }
  if (!authServer.authorization_endpoint || !authServer.token_endpoint) {
    throw new Error("Auth Server Metadata missing authorization_endpoint or token_endpoint");
  }
  return { resource, authServer };
}

async function dynamicClientRegistration(
  registrationEndpoint: string,
  redirectUri: string,
): Promise<{ client_id: string; client_secret?: string } | null> {
  try {
    const res = await fetch(registrationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Open Managed Agents",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { client_id?: string; client_secret?: string };
    return data.client_id ? { client_id: data.client_id, client_secret: data.client_secret } : null;
  } catch {
    return null;
  }
}

function presetForIssuer(issuer: string):
  | { label: string; clientIdEnv: string; clientSecretEnv: string }
  | null {
  const presets: Array<{
    label: string;
    test: RegExp;
    clientIdEnv: string;
    clientSecretEnv: string;
  }> = [
    {
      label: "GitHub",
      test: /^https:\/\/github\.com\/login\/oauth\/?$/,
      clientIdEnv: "GITHUB_OAUTH_CLIENT_ID",
      clientSecretEnv: "GITHUB_OAUTH_CLIENT_SECRET",
    },
    {
      label: "Slack",
      test: /^https:\/\/slack\.com\/?$/,
      clientIdEnv: "SLACK_OAUTH_CLIENT_ID",
      clientSecretEnv: "SLACK_OAUTH_CLIENT_SECRET",
    },
    {
      label: "Asana",
      test: /^https:\/\/app\.asana\.com\/?$/,
      clientIdEnv: "ASANA_OAUTH_CLIENT_ID",
      clientSecretEnv: "ASANA_OAUTH_CLIENT_SECRET",
    },
    {
      label: "ClickUp",
      test: /^https:\/\/mcp\.clickup\.com\/?$/,
      clientIdEnv: "CLICKUP_OAUTH_CLIENT_ID",
      clientSecretEnv: "CLICKUP_OAUTH_CLIENT_SECRET",
    },
    {
      label: "Feishu",
      test: /^https:\/\/accounts\.feishu\.cn\//,
      clientIdEnv: "FEISHU_OAUTH_CLIENT_ID",
      clientSecretEnv: "FEISHU_OAUTH_CLIENT_SECRET",
    },
    {
      label: "Lark",
      test: /^https:\/\/accounts\.larksuite\.com\//,
      clientIdEnv: "LARK_OAUTH_CLIENT_ID",
      clientSecretEnv: "LARK_OAUTH_CLIENT_SECRET",
    },
  ];
  return presets.find((preset) => preset.test.test(issuer)) ?? null;
}

function envValue(env: Record<string, string | undefined> | undefined, key: string): string | undefined {
  return env?.[key] ?? process.env[key];
}

async function readTokenResponse(res: Response): Promise<TokenResponse> {
  const text = await res.text();
  try {
    return JSON.parse(text) as TokenResponse;
  } catch {
    const params = new URLSearchParams(text);
    return {
      access_token: params.get("access_token") ?? "",
      refresh_token: params.get("refresh_token") ?? undefined,
      token_type: params.get("token_type") ?? undefined,
      expires_in: params.get("expires_in") ? Number(params.get("expires_in")) : undefined,
    };
  }
}

async function probeMcpServer(
  url: string,
  bearerToken: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${bearerToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) return { ok: true };
    const body = await res.text().catch(() => "");
    const slice = body.slice(0, 240).trim();
    return {
      ok: false,
      message: `MCP probe HTTP ${res.status}${slice ? `: ${slice}` : ""}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `MCP probe failed: ${msg.slice(0, 120)}` };
  }
}

/** Popup error page: broadcasts oauth_error on the openma-oauth channel so
 *  connect cards/panels leave their "waiting" state and show the message,
 *  then stays open (readable) with the details — a silent window.close()
 *  buried every OAuth failure. */
function closeHtml(title: string, body: string): string {
  const msg = JSON.stringify({ type: "oauth_error", message: `${title}: ${body}`.slice(0, 500) });
  return `<html><body style="font-family:system-ui;max-width:36rem;margin:3rem auto;line-height:1.5">
<h2>${htmlEscape(title)}</h2><p>${body}</p>
<p style="color:#888">You can close this window.</p>
<script>
  (function(){
    var msg = ${msg};
    try { if (window.opener && !window.opener.closed) window.opener.postMessage(msg, "*"); } catch (e) {}
    try { var bc = new BroadcastChannel("openma-oauth"); bc.postMessage(msg); bc.close(); } catch (e) {}
  })();
</script></body></html>`;
}

function htmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
