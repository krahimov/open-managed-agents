/**
 * Environment model + display helpers, shared by the Environments list,
 * the record page and its edit dialog.
 *
 * The pure helpers at the bottom map the API's config shape to the
 * editor's row arrays and back. They are unchanged in behaviour from the
 * original page: unknown config fields round-trip untouched, `gem`
 * packages are preserved even though they are not editable.
 */

/** Package managers the editor offers. `gem` exists in the schema but the
 *  sandbox base image has no Ruby yet, so it is read-only (see below). */
export const MANAGERS = ["apt", "cargo", "go", "npm", "pip"] as const;
export type Manager = (typeof MANAGERS)[number];
export const ALL_MANAGERS = [...MANAGERS, "gem"] as const;
export type AnyManager = (typeof ALL_MANAGERS)[number];

export interface NetworkingConfig {
  type: "unrestricted" | "limited";
  allowed_hosts?: string[];
  allow_mcp_servers?: boolean;
  allow_package_managers?: boolean;
}

export interface SandboxConfig {
  provider?: string;
  image?: string;
  workdir?: string;
  ephemeral?: boolean;
  bootstrap_tools?: boolean;
  bootstrap_apt_packages?: string[];
  max_file_bytes?: number;
}

export interface MemoryMount {
  id?: string;
  store_id?: string;
  memory_store_id?: string;
  name?: string;
  access?: string;
  instructions?: string;
}

export interface EnvConfigBlock {
  type: string;
  packages?: Partial<Record<AnyManager, string[]>>;
  networking?: NetworkingConfig;
  sandbox?: SandboxConfig;
  memory?: { stores?: MemoryMount[] } & Record<string, unknown>;
  resources?: { outputs?: boolean; memory_stores?: MemoryMount[] } & Record<string, unknown>;
  dockerfile?: string;
}

export interface Environment {
  id: string;
  name: string;
  description?: string;
  config: EnvConfigBlock;
  status?: "building" | "ready" | "error";
  build_error?: string;
  metadata?: Record<string, unknown>;
  image_strategy?: "base_snapshot" | "dockerfile";
  created_at: string;
  updated_at?: string;
  archived_at?: string | null;
}

// ── Display ─────────────────────────────────────────────────────────

export const SANDBOX_PROVIDERS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: "daytona", label: "Daytona", hint: "Cloud workspace, can persist between sessions" },
  { value: "subprocess", label: "Local subprocess", hint: "Runs on the server host. No isolation" },
  { value: "litebox", label: "LiteBox", hint: "Lightweight local sandbox" },
  { value: "boxrun", label: "BoxRun", hint: "Self-hosted micro-VM" },
  { value: "e2b", label: "E2B", hint: "Cloud sandbox, short-lived" },
];

export function providerLabel(provider: string | undefined | null): string {
  const key = provider || "subprocess";
  return SANDBOX_PROVIDERS.find((p) => p.value === key)?.label ?? key;
}

/** Total package count and a per-manager breakdown ("apt 5 · npm 4"). */
export function packageSummary(env: Pick<Environment, "config">): {
  total: number;
  groups: Array<{ manager: AnyManager; packages: string[] }>;
} {
  const groups: Array<{ manager: AnyManager; packages: string[] }> = [];
  let total = 0;
  for (const manager of ALL_MANAGERS) {
    const list = env.config?.packages?.[manager];
    if (list && list.length > 0) {
      groups.push({ manager, packages: list });
      total += list.length;
    }
  }
  return { total, groups };
}

export function networkSummary(env: Pick<Environment, "config">): {
  limited: boolean;
  /** For a header chip: "6 allowed hosts", "Open internet". */
  label: string;
  /** For a narrow table cell: "6 hosts", "Open". */
  short: string;
  hosts: string[];
} {
  const net = env.config?.networking;
  const limited = net?.type === "limited";
  const hosts = limited ? (net?.allowed_hosts ?? []) : [];
  return {
    limited,
    hosts,
    label: limited ? (hosts.length === 0 ? "No outbound hosts" : `${hosts.length} allowed ${hosts.length === 1 ? "host" : "hosts"}`) : "Open internet",
    short: limited ? (hosts.length === 0 ? "No hosts" : `${hosts.length} ${hosts.length === 1 ? "host" : "hosts"}`) : "Open",
  };
}

/** Memory stores mounted by default, from either place the config keeps them. */
export function memoryMounts(env: Pick<Environment, "config">): Array<{ storeId: string; readOnly: boolean; instructions?: string }> {
  const seen = new Set<string>();
  const out: Array<{ storeId: string; readOnly: boolean; instructions?: string }> = [];
  for (const m of [...(env.config?.memory?.stores ?? []), ...(env.config?.resources?.memory_stores ?? [])]) {
    const storeId = m.memory_store_id ?? m.store_id ?? m.id;
    if (!storeId || seen.has(storeId)) continue;
    seen.add(storeId);
    out.push({ storeId, readOnly: m.access === "read_only", instructions: m.instructions });
  }
  return out;
}

// ── Editor row shapes ───────────────────────────────────────────────
// Packages and metadata use ordered row arrays so a row keeps its visual
// position while it is edited, instead of reshuffling when the object's
// key order changes on save.

export interface PackageRow {
  manager: Manager;
  /** Space-separated package specs, e.g. `pandas numpy==2.0`. */
  packages: string;
}
export interface MetadataRow {
  key: string;
  value: string;
}

export function packagesToRows(packages: Partial<Record<AnyManager, string[]>> | undefined): PackageRow[] {
  if (!packages) return [];
  const rows: PackageRow[] = [];
  for (const m of MANAGERS) {
    const list = packages[m];
    if (list && list.length > 0) rows.push({ manager: m, packages: list.join(" ") });
  }
  return rows;
}

export function rowsToPackages(
  rows: PackageRow[],
  preservedGem?: string[],
): Partial<Record<AnyManager, string[]>> {
  const out: Partial<Record<AnyManager, string[]>> = {};
  for (const row of rows) {
    const specs = row.packages
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (specs.length === 0) continue;
    // Rows that share a manager merge: the editor does not enforce uniqueness.
    out[row.manager] = [...(out[row.manager] ?? []), ...specs];
  }
  if (preservedGem && preservedGem.length > 0) out.gem = preservedGem;
  return out;
}

export function metadataToRows(metadata: Record<string, unknown> | undefined): MetadataRow[] {
  if (!metadata) return [];
  return Object.entries(metadata).map(([key, value]) => ({
    key,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
}

export function rowsToMetadata(rows: MetadataRow[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const k = row.key.trim();
    if (!k) continue;
    out[k] = row.value;
  }
  return out;
}

export function buildNetworking(net: NetworkingConfig, allowedHostsText: string): NetworkingConfig {
  const hosts = allowedHostsText
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (net.type === "unrestricted") {
    // allowed_hosts is meaningless when unrestricted, and the backend may
    // reject stale entries: drop it.
    return {
      type: "unrestricted",
      allow_mcp_servers: !!net.allow_mcp_servers,
      allow_package_managers: !!net.allow_package_managers,
    };
  }
  return {
    type: "limited",
    allow_mcp_servers: !!net.allow_mcp_servers,
    allow_package_managers: !!net.allow_package_managers,
    allowed_hosts: hosts,
  };
}

export function buildSandboxConfig(
  sandbox: SandboxConfig,
  bootstrapPackagesText: string,
  maxFileBytesText: string,
): SandboxConfig {
  const packages = bootstrapPackagesText
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const maxFileBytes = Number(maxFileBytesText);
  return {
    ...(sandbox.provider?.trim() ? { provider: sandbox.provider.trim() } : {}),
    ...(sandbox.image?.trim() ? { image: sandbox.image.trim() } : {}),
    ...(sandbox.workdir?.trim() ? { workdir: sandbox.workdir.trim() } : {}),
    ...(typeof sandbox.ephemeral === "boolean" ? { ephemeral: sandbox.ephemeral } : {}),
    ...(typeof sandbox.bootstrap_tools === "boolean" ? { bootstrap_tools: sandbox.bootstrap_tools } : {}),
    ...(packages.length > 0 ? { bootstrap_apt_packages: packages } : {}),
    ...(Number.isFinite(maxFileBytes) && maxFileBytes > 0 ? { max_file_bytes: Math.floor(maxFileBytes) } : {}),
  };
}
