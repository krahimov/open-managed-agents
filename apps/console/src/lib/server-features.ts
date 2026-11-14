import { useQuery } from "@tanstack/react-query";
import { useApi, isNotOnServer } from "./api";

/**
 * What this server can do, for the surfaces whose endpoints only some
 * servers have.
 *
 * The source is one cached read of `GET /v1/server_features`, which answers
 * `{ features: string[] }` (main-node adds it in the B1 slice; each later
 * backend wave adds its key there). A surface asks `useServerFeature(key)`
 * and is hidden while the answer is false, so a missing endpoint never shows
 * as an error.
 *
 * A server without `/v1/server_features` itself (it answers 404, 501, or the
 * app page that `api()` turns into a 404 `not_on_server`) is an older one.
 * There every feature is off, except the ones the console can confirm with a
 * quiet GET of its own (`PROBES`): those are on when that GET succeeds.
 * Write-only features (missions, draft_scenarios, memory_writes,
 * skill_versions, runtimes, cap_cli) have nothing to probe, so on an older
 * server they stay off.
 *
 * Any other failure of the read (network, 5xx) also leaves every feature
 * off; the query retries on its normal schedule.
 */

/** Every feature key a server may list. Add a key here when a backend wave adds it. */
export const SERVER_FEATURE_KEYS = [
  /** GET /v1/operations and its approve / stop / retry / discard writes. */
  "operations",
  /** GET /v1/workspace/access (role of the caller; read-only shim on main). */
  "workspace_access",
  /** GET /v1/usage (usage tracker). */
  "usage",
  /** POST /v1/missions, GET /v1/missions/:id, POST /v1/missions/:id/stop. */
  "missions",
  /** GET /v1/workspace/members + PUT role, GET /v1/workspace/audit. */
  "workspace_admin",
  /** GET/PUT /v1/workspace/budgets. */
  "budgets",
  /** API keys honour scopes, resource_ids and expires_at. */
  "scoped_keys",
  /** Simulation tasks in eval suites and runs. */
  "simulations",
  /** POST /v1/evals/draft_scenarios. */
  "draft_scenarios",
  /** GET/POST /v1/evals/comparisons. */
  "comparisons",
  /** Memory-store delete/archive, memory write/delete, versions + redact. */
  "memory_writes",
  /** POST /v1/skills/upload and /v1/skills/:id/versions*. */
  "skill_versions",
  /** POST /v1/runtimes/connect-runtime, DELETE /v1/runtimes/:id. */
  "runtimes",
  /** POST /v1/cap-cli/oauth/initiate and /poll. */
  "cap_cli",
] as const;

export type ServerFeature = (typeof SERVER_FEATURE_KEYS)[number];

/**
 * Features an older server (no `/v1/server_features`) can still show, each
 * confirmed by a quiet GET. A 2xx JSON answer turns it on; 404 / 501 /
 * not_on_server (or any other failure) leaves it off.
 */
const PROBES: Partial<Record<ServerFeature, string>> = {
  operations: "/v1/operations",
  workspace_access: "/v1/workspace/access",
  // A one-millisecond window: an empty report is enough to know it is there.
  usage: "/v1/usage?since=1&until=2",
  workspace_admin: "/v1/workspace/members",
  budgets: "/v1/workspace/budgets",
  comparisons: "/v1/evals/comparisons",
};

/** React-query key of the feature list. Tests may seed it with `setQueryData`. */
export const SERVER_FEATURES_QUERY_KEY = ["server_features"] as const;

export interface ServerFeatures {
  /** The keys that are on. */
  features: ReadonlySet<ServerFeature>;
  /** Where the answer came from: the server's own list, or the console's probes. */
  source: "server" | "probe";
}

function isFeature(value: unknown): value is ServerFeature {
  return typeof value === "string" && (SERVER_FEATURE_KEYS as readonly string[]).includes(value);
}

type Api = ReturnType<typeof useApi>["api"];

export async function loadServerFeatures(api: Api, signal?: AbortSignal): Promise<ServerFeatures> {
  try {
    const body = await api<{ features?: unknown }>("/v1/server_features", { signal, silentErrors: true });
    const list = Array.isArray(body?.features) ? body.features.filter(isFeature) : [];
    return { features: new Set(list), source: "server" };
  } catch (err) {
    if (!isNotOnServer(err)) throw err;
  }
  const entries = Object.entries(PROBES) as Array<[ServerFeature, string]>;
  const results = await Promise.all(
    entries.map(async ([key, path]) => {
      try {
        await api(path, { signal, silentErrors: true });
        return key;
      } catch {
        return null;
      }
    }),
  );
  return { features: new Set(results.filter((k): k is ServerFeature => k !== null)), source: "probe" };
}

/** The whole answer. `isLoading` is true until the first answer arrives. */
export function useServerFeatures() {
  const { api } = useApi();
  return useQuery<ServerFeatures>({
    queryKey: SERVER_FEATURES_QUERY_KEY,
    queryFn: ({ signal }) => loadServerFeatures(api, signal),
    // What a server can do does not change while the tab is open; a deploy
    // that adds a feature is picked up on the next load (the update prompt
    // reloads the page).
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  });
}

/**
 * True when this server has `key`. False while the answer is loading and
 * when the read failed, so a surface that depends on it stays hidden rather
 * than flashing in and erroring.
 */
export function useServerFeature(key: ServerFeature): boolean {
  const { data } = useServerFeatures();
  return data?.features.has(key) ?? false;
}
