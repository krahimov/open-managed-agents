// Vault credentials → session MCP servers.
//
// A session's MCP servers are the agent's declared `mcp_servers` plus any
// server an integration injects for that session. Vault credentials are
// used for AUTH ONLY: the MCP proxy matches a declared server's URL
// against the credentials in the session's vaults and injects the token.
//
// Before this, attaching a vault turned EVERY active MCP credential in it
// into a session server (pinned into agent_snapshot): an agent declaring
// only GitHub got Notion, Sentry, Railway and a Composio router on every
// turn — Notion alone is ~59k tokens of tool definitions per model call —
// under hostname-derived names ("mcp", "mcp_2", "api"). That inference is
// kept only behind the agent-level opt-in `_oma.vault_mcp_servers: "all"`.
// One exception in the default mode: a declared GENERIC Composio server
// also mounts the vaults' other Composio routers (vaultMcpServersForAgent).

import type { AgentConfig, VaultMcpServersMode } from "@open-managed-agents/api-types";

type McpServer = NonNullable<AgentConfig["mcp_servers"]>[number];

/** The slice of a vault credential this module reads — loose on purpose so
 *  both the route DTOs and the Node credential service rows fit. */
export interface VaultMcpCredentialLike {
  archived_at?: string | null;
  created_at?: string | number | null;
  auth?: {
    type?: string;
    mcp_server_url?: string;
    composio_toolkits?: string[];
    composio_user_id?: string;
    composio_previous_mcp_server_urls?: string[];
  } | null;
}

export type VaultMcpCredentialGroups = ReadonlyArray<{
  vault_id: string;
  credentials: ReadonlyArray<VaultMcpCredentialLike>;
}>;

/** The agent's mode; anything but an explicit "all" means "declared". */
export function vaultMcpServersMode(agent: { vault_mcp_servers?: unknown } | null | undefined): VaultMcpServersMode {
  return agent?.vault_mcp_servers === "all" ? "all" : "declared";
}

/** origin + path without trailing slashes; query/hash dropped. Null when
 *  `raw` isn't a URL. Same rule the CF MCP proxy matches credentials by. */
export function normalizeMcpServerUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

/** A Composio tool-router endpoint (per-session, generic sentinel, or the
 *  connect.composio.dev gateway). */
export function isComposioMcpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (url.hostname === "connect.composio.dev" && path === "/mcp") return true;
    return (
      (url.hostname === "app.composio.dev" || url.hostname === "backend.composio.dev") &&
      path.includes("/tool_router/") &&
      path.endsWith("/mcp")
    );
  } catch {
    return false;
  }
}

/** The session-less tool-router base URL (only a name target, not servable). */
export function isGenericComposioMcpUrl(raw: string): boolean {
  const normalized = normalizeMcpServerUrl(raw);
  return normalized === "https://app.composio.dev/tool_router/v3/session/mcp";
}

/** The one environment variable a composio_mcp credential may name as its
 *  key (`api_key_env`): the operator's platform Composio key. */
export const COMPOSIO_PLATFORM_API_KEY_ENV = "COMPOSIO_API_KEY";

/**
 * Which environment variable the MCP proxies may read to authenticate a
 * composio_mcp credential's upstream — null when none may be.
 *
 * `api_key_env` is tenant-writable (generic credential create), and both
 * proxies send the named env var's value as `x-api-key` to the stored
 * `mcp_server_url`. Without these checks a tenant could store
 * {type:"composio_mcp", mcp_server_url:"https://attacker.example/tool_router/x/mcp",
 * api_key_env:"DATABASE_URL"} and receive any operator secret — or the
 * shared platform Composio key, which reads every tenant's Composio users.
 * So: only the platform key's variable, and only towards a real Composio
 * endpoint. A credential's own raw `api_key` is its tenant's secret and
 * needs neither check.
 */
export function composioPlatformKeyEnvFor(
  auth: { api_key_env?: string | null },
  upstreamUrl: string,
): string | null {
  const name = auth.api_key_env || COMPOSIO_PLATFORM_API_KEY_ENV;
  if (name !== COMPOSIO_PLATFORM_API_KEY_ENV) return null;
  return isComposioMcpUrl(upstreamUrl) ? name : null;
}

/** Why a composio_mcp credential auth must be refused at create/update
 *  (see composioPlatformKeyEnvFor), or null when it is acceptable. */
export function composioCredentialAuthError(auth: {
  type?: string;
  mcp_server_url?: string;
  api_key?: string;
  api_key_env?: string;
} | null | undefined): string | null {
  if (!auth) return null;
  if (auth.api_key_env !== undefined && auth.api_key_env !== null && auth.api_key_env !== COMPOSIO_PLATFORM_API_KEY_ENV) {
    return `api_key_env may only be "${COMPOSIO_PLATFORM_API_KEY_ENV}"`;
  }
  if (auth.type !== "composio_mcp") return null;
  if (typeof auth.mcp_server_url === "string" && auth.mcp_server_url && !isComposioMcpUrl(auth.mcp_server_url)) {
    return "composio_mcp credentials must point at a Composio tool-router endpoint (app/backend.composio.dev …/tool_router/…/mcp or connect.composio.dev/mcp)";
  }
  return null;
}

function isMcpCredentialType(type: string | undefined): boolean {
  return type === "mcp_oauth" || type === "static_bearer" || type === "composio_mcp";
}

export interface InferVaultMcpServersOptions {
  /** Server names the agent's configuration references: its
   *  `mcp_toolset.mcp_server_name`s and the `mcp__<server>__…` prefixes of
   *  its pinned access-policy selectors. An inferred server whose PREVIOUS
   *  name (first DNS label: "mcp", "mcp_2", "api") is referenced keeps it,
   *  so permission configs and deny/ask rules stored against the old
   *  naming still govern it (a rule that stops matching falls through to
   *  allow). */
  referencedServerNames?: Iterable<string>;
  /** `metadata.mcp_vault_bindings` (normalized URL → vault id): which vault
   *  the MCP proxy prefers for a declared server — needed to know which
   *  router a declared generic Composio server resolves to. */
  vaultBindings?: Record<string, unknown> | null;
}

type Candidate = {
  auth: NonNullable<VaultMcpCredentialLike["auth"]>;
  url: string;
  vaultId: string;
  createdAt: number;
  order: number;
};

/**
 * Servers the vaults would add on top of `declared` under the legacy "all"
 * inference: one per active MCP credential whose URL isn't declared yet.
 *
 * Composio routers: every router with a distinct toolkit set is mounted
 * under its own name (composio_<toolkits>; MCP tools are namespaced
 * mcp__<server>__*, so two routers don't collide) — a session with a
 * Notion/Slack vault and a Google vault needs both. Before, only ONE router
 * survived across all vaults and the Google one was silently dropped. Only
 * true duplicates are deduped: the same URL, or a router of the same
 * composio user whose toolkits are a subset of another's (the superset —
 * or, for equal sets, the newest — is kept). A declared Composio server
 * suppresses just the routers it covers: the router it resolves to and the
 * others of that router's composio user. The generic sentinel URL is never
 * servable (it 301s), so a sentinel-only credential is inferred only when
 * there is no concrete router at all and none is declared.
 */
export function inferVaultMcpServers(
  declared: ReadonlyArray<McpServer>,
  vaultCredentials: VaultMcpCredentialGroups,
  options: InferVaultMcpServersOptions = {},
): McpServer[] {
  const existingUrls = new Set(
    declared
      .map((server) => (typeof server.url === "string" ? normalizeMcpServerUrl(server.url) : null))
      .filter((url): url is string => Boolean(url)),
  );
  const usedNames = new Set(declared.map((server) => server.name).filter(Boolean));

  // Every active Composio credential, declared URL or not — coverage of a
  // declared server is decided against these.
  const allComposio: Candidate[] = [];
  const candidates: Candidate[] = [];
  let order = 0;
  for (const vault of vaultCredentials) {
    for (const credential of vault.credentials) {
      if (credential.archived_at) continue;
      const auth = credential.auth;
      const url = auth?.mcp_server_url?.trim();
      if (!auth || !url || !isMcpCredentialType(auth.type)) continue;
      const candidate: Candidate = {
        auth,
        url,
        vaultId: vault.vault_id,
        createdAt: timestampOf(credential.created_at),
        order: order++,
      };
      if (auth.type === "composio_mcp") allComposio.push(candidate);
      const normalizedUrl = normalizeMcpServerUrl(url);
      if (normalizedUrl && existingUrls.has(normalizedUrl)) continue;
      if (normalizedUrl) existingUrls.add(normalizedUrl);
      candidates.push(candidate);
    }
  }

  const keptComposio = selectComposioRouters(declared, candidates, allComposio, options.vaultBindings);
  const kept = candidates.filter(
    (candidate) => candidate.auth.type !== "composio_mcp" || keptComposio.has(candidate),
  );

  // Names: a referenced legacy name is reserved first, then everything else
  // is named in order from its brand label.
  const referenced = new Set(options.referencedServerNames ?? []);
  const legacyUsed = new Set(usedNames);
  const names = new Map<Candidate, string>();
  for (const candidate of kept) {
    if (candidate.auth.type === "composio_mcp") continue;
    const legacy = uniqueMcpServerName(legacyHostnameLabel(candidate.url), legacyUsed);
    if (referenced.has(legacy) && !usedNames.has(legacy)) {
      usedNames.add(legacy);
      names.set(candidate, legacy);
    }
  }
  const inferred: McpServer[] = [];
  for (const candidate of kept) {
    const name =
      names.get(candidate) ??
      uniqueMcpServerName(mcpServerNameBase(candidate.auth, candidate.url), usedNames);
    inferred.push({ name, type: "url", url: candidate.url });
  }
  return inferred;
}

/** Which Composio candidates to mount (see inferVaultMcpServers). */
function selectComposioRouters(
  declared: ReadonlyArray<McpServer>,
  candidates: ReadonlyArray<Candidate>,
  allComposio: ReadonlyArray<Candidate>,
  vaultBindings: InferVaultMcpServersOptions["vaultBindings"],
): Set<Candidate> {
  const concreteAll = allComposio.filter((c) => !isGenericComposioMcpUrl(c.url));
  const declaredComposio = declared
    .map((server) => (typeof server.url === "string" ? server.url : ""))
    .filter((url) => url && isComposioMcpUrl(url));

  // What each declared server covers: the router it resolves to (same rule
  // as the MCP proxy) plus every router of that router's composio user.
  const coveredUrls = new Set<string>();
  const coveredUsers = new Set<string>();
  for (const url of declaredComposio) {
    const resolved = resolveDeclaredComposio(url, concreteAll, vaultBindings);
    if (!resolved) continue;
    coveredUrls.add(normalizeMcpServerUrl(resolved.url) ?? resolved.url);
    if (resolved.auth.composio_user_id) coveredUsers.add(resolved.auth.composio_user_id);
  }

  const composio = candidates.filter((c) => c.auth.type === "composio_mcp");
  const concrete = composio.filter((c) => {
    if (isGenericComposioMcpUrl(c.url)) return false;
    if (coveredUrls.has(normalizeMcpServerUrl(c.url) ?? c.url)) return false;
    return !(c.auth.composio_user_id && coveredUsers.has(c.auth.composio_user_id));
  });

  const kept = new Set<Candidate>();
  for (const router of concrete) {
    const user = router.auth.composio_user_id;
    const shadowed = user
      ? concrete.some(
          (other) =>
            other !== router &&
            other.auth.composio_user_id === user &&
            coversToolkits(other, router),
        )
      : false;
    if (!shadowed) kept.add(router);
  }
  if (kept.size === 0 && concreteAll.length === 0 && declaredComposio.length === 0) {
    const sentinel = composio[0];
    if (sentinel) kept.add(sentinel);
  }
  return kept;
}

/** The concrete router a declared Composio URL is served by — the same
 *  pick as the MCP proxy (apps/main-node pickComposioCandidate): the
 *  credential stored under it, else the one whose lineage holds it, else
 *  (the generic sentinel, or a URL no credential knows any more) the first
 *  concrete router, bound vault first. */
function resolveDeclaredComposio(
  url: string,
  concrete: ReadonlyArray<Candidate>,
  vaultBindings: InferVaultMcpServersOptions["vaultBindings"],
): Candidate | null {
  const normalized = normalizeMcpServerUrl(url) ?? url;
  const exact = concrete.find((c) => (normalizeMcpServerUrl(c.url) ?? c.url) === normalized);
  if (exact) return exact;
  const successor = concrete.find((c) =>
    (c.auth.composio_previous_mcp_server_urls ?? []).some(
      (prev) => (normalizeMcpServerUrl(prev) ?? prev) === normalized,
    ),
  );
  if (successor) return successor;
  // setup-harness keys bindings by the lowercased normalized URL.
  const bound = vaultBindings?.[normalized] ?? vaultBindings?.[normalized.toLowerCase()];
  const boundVault = typeof bound === "string" && bound ? bound : null;
  return (
    (boundVault ? concrete.find((c) => c.vaultId === boundVault) : undefined) ??
    concrete[0] ??
    null
  );
}

/** Does `a` expose every toolkit `b` does? An unlocked router (no toolkit
 *  list) exposes all. Equal sets: the newer one covers the older. */
function coversToolkits(a: Candidate, b: Candidate): boolean {
  const as = toolkitSet(a);
  const bs = toolkitSet(b);
  if (as === null) {
    if (bs !== null) return true;
    return isNewer(a, b);
  }
  if (bs === null) return false;
  for (const toolkit of bs) if (!as.has(toolkit)) return false;
  return as.size > bs.size || isNewer(a, b);
}

function toolkitSet(c: Candidate): Set<string> | null {
  const list = Array.isArray(c.auth.composio_toolkits)
    ? c.auth.composio_toolkits.map((t) => String(t).toLowerCase().replace(/[^a-z0-9]+/g, "")).filter(Boolean)
    : [];
  return list.length > 0 ? new Set(list) : null;
}

function isNewer(a: Candidate, b: Candidate): boolean {
  if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt;
  return a.order > b.order;
}

function timestampOf(raw: string | number | null | undefined): number {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : 0;
  const ms = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/** Names of the MCP servers `tools` holds an mcp_toolset for. */
export function mcpToolsetServerNames(tools: unknown): string[] {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (t): t is { type: string; mcp_server_name: string } =>
        !!t &&
        typeof (t as { type?: unknown }).type === "string" &&
        (t as { type: string }).type.startsWith("mcp_toolset") &&
        typeof (t as { mcp_server_name?: unknown }).mcp_server_name === "string",
    )
    .map((t) => t.mcp_server_name);
}

/** The literal server segment of an `mcp__<server>__<tool>` policy
 *  selector ("mcp__mcp__delete_*" → "mcp"); null when the selector isn't
 *  MCP-scoped or its server part is itself a wildcard. */
function policySelectorServerName(selector: unknown): string | null {
  if (typeof selector !== "string" || !selector.startsWith("mcp__")) return null;
  const rest = selector.slice("mcp__".length);
  const idx = rest.indexOf("__");
  const server = idx > 0 ? rest.slice(0, idx) : rest.replace(/\*+$/, "");
  if (!server || server.includes("*")) return null;
  return server;
}

/** Server names the agent's pinned access policy names in its selectors. */
export function policySelectorServerNames(policy: unknown): string[] {
  const rules = (policy as { rules?: unknown } | null | undefined)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules
    .map((rule) => policySelectorServerName((rule as { selector?: unknown } | null)?.selector))
    .filter((name): name is string => !!name);
}

type InferenceAgent = { tools?: unknown; metadata?: unknown; effective_policy?: unknown };

/** The inference options an agent implies: the server names its toolsets
 *  and pinned access policy reference (legacy-name reservation) and its
 *  vault bindings. */
export function vaultMcpInferenceOptions(
  agent: InferenceAgent | null | undefined,
): InferVaultMcpServersOptions {
  const bindings = (agent?.metadata as { mcp_vault_bindings?: unknown } | null | undefined)?.mcp_vault_bindings;
  return {
    referencedServerNames: [
      ...mcpToolsetServerNames(agent?.tools),
      ...policySelectorServerNames(agent?.effective_policy),
    ],
    vaultBindings: bindings && typeof bindings === "object" ? (bindings as Record<string, unknown>) : null,
  };
}

/** Does `servers` declare the generic Composio tool router (the console's
 *  and the graft route's "Composio, whichever router the vaults hold")? */
export function declaresGenericComposioServer(servers: ReadonlyArray<{ url?: unknown }> | null | undefined): boolean {
  return (servers ?? []).some((server) => typeof server?.url === "string" && isGenericComposioMcpUrl(server.url));
}

/** Can the session's vaults add servers to `agent` at all? ("all" mode, or
 *  a declared generic Composio server — see vaultMcpServersForAgent.)
 *  Callers use it to skip listing credentials for nothing. */
export function vaultMcpServersMayAdd(
  agent: Pick<AgentConfig, "mcp_servers" | "vault_mcp_servers"> | null | undefined,
): boolean {
  return vaultMcpServersMode(agent) === "all" || declaresGenericComposioServer(agent?.mcp_servers);
}

/**
 * What the session's vaults add to `agent`'s servers:
 * - "all" mode: the legacy inference (one server per active MCP credential).
 * - "declared" mode (the default): nothing — EXCEPT that a declared generic
 *   Composio server (…/tool_router/v3/session/mcp, written by the console
 *   and the graft route) means "Composio, whatever routers the vaults
 *   hold". The proxy serves that one server from a single router, so an
 *   agent grafted from two vaults (Notion/Slack + Google) reached only the
 *   first. The vaults' other Composio routers — those the declared one
 *   doesn't cover, by the same rules as "all" mode — are mounted next to
 *   it. Non-Composio credentials still only authenticate.
 */
export function vaultMcpServersForAgent(
  agent: Pick<AgentConfig, "mcp_servers" | "vault_mcp_servers"> & InferenceAgent,
  vaultCredentials: VaultMcpCredentialGroups,
): McpServer[] {
  const declared = agent.mcp_servers ?? [];
  if (vaultMcpServersMode(agent) === "all") {
    return inferVaultMcpServers(declared, vaultCredentials, vaultMcpInferenceOptions(agent));
  }
  if (!declaresGenericComposioServer(declared)) return [];
  const composioOnly = vaultCredentials.map((group) => ({
    vault_id: group.vault_id,
    credentials: group.credentials.filter((credential) => credential.auth?.type === "composio_mcp"),
  }));
  return inferVaultMcpServers(declared, composioOnly, vaultMcpInferenceOptions(agent));
}

type ToolsetLike = { type?: unknown; mcp_server_name?: unknown; default_config?: unknown };
type PolicyRuleLike = { effect?: unknown; selector?: unknown; description?: unknown };

function askingToolset(toolset: ToolsetLike): boolean {
  const dflt = toolset.default_config as { permission_policy?: { type?: unknown } } | undefined;
  return dflt?.permission_policy?.type === "always_ask";
}

/**
 * `agent` with its vault-contributed servers appended (identity when none).
 *
 * A Composio router mounted next to another Composio server inherits that
 * server's governance — tool permissions and access-policy rules are keyed
 * by server name (mcp__<server>__*), so a second router under a new name
 * (composio_gmail_…) would otherwise fall through to the built-in default
 * (usually always_allow) and to policy allow: an agent whose Composio
 * toolset asks before every call would start sending mail unasked. So for
 * each added router without its own toolset, the agent's Composio toolset
 * (declared Composio server first; an always_ask one wins) is copied under
 * the new name, and every pinned policy rule on a Composio server name is
 * mirrored onto it.
 */
export function withVaultMcpServers<
  A extends Pick<AgentConfig, "mcp_servers" | "vault_mcp_servers"> & InferenceAgent,
>(
  agent: A,
  vaultCredentials: VaultMcpCredentialGroups,
): A {
  const added = vaultMcpServersForAgent(agent, vaultCredentials);
  if (added.length === 0) return agent;
  const out: A = { ...agent, mcp_servers: [...(agent.mcp_servers ?? []), ...added] };

  const isComposio = (server: { url?: unknown }) => typeof server.url === "string" && isComposioMcpUrl(server.url);
  const addedComposio = added.filter(isComposio).map((server) => server.name);
  if (addedComposio.length === 0) return out;
  const composioNames = [
    ...(agent.mcp_servers ?? []).filter(isComposio).map((server) => server.name),
    ...addedComposio,
  ];

  const tools = Array.isArray(agent.tools) ? (agent.tools as ToolsetLike[]) : null;
  if (tools) {
    const own = new Set(mcpToolsetServerNames(tools));
    const sources = composioNames
      .map((name) => tools.find((t) => typeof t?.type === "string" && t.type.startsWith("mcp_toolset") && t.mcp_server_name === name))
      .filter((t): t is ToolsetLike => !!t);
    const parent = sources.find(askingToolset) ?? sources[0];
    if (parent) {
      const synthesized = addedComposio
        .filter((name) => !own.has(name))
        .map((name) => ({ ...parent, mcp_server_name: name }));
      if (synthesized.length > 0) (out as InferenceAgent).tools = [...tools, ...synthesized];
    }
  }

  const policy = agent.effective_policy as { rules?: unknown } | null | undefined;
  if (policy && Array.isArray(policy.rules)) {
    const rules = policy.rules as PolicyRuleLike[];
    const existing = new Set(rules.map((rule) => `${String(rule.effect)}|${String(rule.selector)}`));
    const mirrored: PolicyRuleLike[] = [];
    for (const rule of rules) {
      const server = policySelectorServerName(rule.selector);
      if (!server || !composioNames.includes(server)) continue;
      const rest = (rule.selector as string).slice(`mcp__${server}`.length);
      for (const name of addedComposio) {
        if (name === server) continue;
        const selector = `mcp__${name}${rest}`;
        const key = `${String(rule.effect)}|${selector}`;
        if (existing.has(key)) continue;
        existing.add(key);
        mirrored.push({ ...rule, selector });
      }
    }
    if (mirrored.length > 0) {
      (out as InferenceAgent).effective_policy = { ...policy, rules: [...rules, ...mirrored] };
    }
  }
  return out;
}

function mcpServerNameBase(auth: NonNullable<VaultMcpCredentialLike["auth"]>, url: string): string {
  if (auth.type === "composio_mcp") {
    const toolkits = Array.isArray(auth.composio_toolkits)
      ? auth.composio_toolkits
          .map((toolkit) => String(toolkit).toLowerCase().replace(/[^a-z0-9]+/g, "_"))
          .filter(Boolean)
      : [];
    return ["composio", ...toolkits.slice(0, 3)].join("_");
  }
  return mcpServerBrandLabel(url);
}

/** The pre-2026-11 inferred name: the first DNS label ("mcp" for
 *  mcp.posthog.com). Only used to keep referenced old names stable. */
function legacyHostnameLabel(url: string): string {
  try {
    return new URL(url).hostname.split(".").filter(Boolean)[0] || "mcp";
  } catch {
    return "mcp";
  }
}

// Suffixes under which the label to the LEFT is the registrant — multi-part
// country suffixes and the hosting platforms MCP servers commonly live on
// (my-tools.vercel.app → my_tools, not vercel). Not the full Public Suffix
// List; a miss only costs a less specific name.
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "co.jp", "ne.jp", "or.jp",
  "com.au", "net.au", "org.au", "co.nz", "org.nz", "com.br", "com.cn", "com.hk",
  "com.sg", "com.tw", "com.mx", "com.tr", "co.in", "co.kr", "co.za", "com.ar",
  "vercel.app", "netlify.app", "pages.dev", "workers.dev", "fly.dev", "onrender.com",
  "herokuapp.com", "railway.app", "up.railway.app", "github.io", "deno.dev",
  "web.app", "firebaseapp.com", "azurewebsites.net", "run.app", "replit.app",
  "ngrok.io", "ngrok.app", "ngrok-free.app", "modal.run", "supabase.co",
]);

/** The registrable ("brand") label of `url`'s host: mcp.posthog.com →
 *  posthog, api.example.com → example, mcp.linear.app → linear,
 *  foo.example.co.uk → example. IPs and bare hosts fall back sensibly. */
export function mcpServerBrandLabel(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "mcp";
  }
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(":")) return "mcp";
  const labels = hostname.split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] || "mcp";
  let suffixLength = 1;
  for (const length of [3, 2]) {
    if (labels.length > length && MULTI_LABEL_SUFFIXES.has(labels.slice(-length).join("."))) {
      suffixLength = length;
      break;
    }
  }
  return labels[labels.length - suffixLength - 1] || labels[0] || "mcp";
}

/** `base` cleaned to [a-z0-9_] (≤48 chars), suffixed _2, _3… until unused.
 *  Adds the result to `usedNames`. */
export function uniqueMcpServerName(base: string, usedNames: Set<string>): string {
  const cleanBase = (base || "mcp").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "") || "mcp";
  const trimmedBase = cleanBase.slice(0, 48);
  if (!usedNames.has(trimmedBase)) {
    usedNames.add(trimmedBase);
    return trimmedBase;
  }
  for (let i = 2; ; i++) {
    const suffix = `_${i}`;
    const candidate = `${trimmedBase.slice(0, 48 - suffix.length)}${suffix}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
}
