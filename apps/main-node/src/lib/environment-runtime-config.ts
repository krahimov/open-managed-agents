import type { EnvironmentConfig } from "@open-managed-agents/shared";

export interface EnvironmentMemoryStoreRef {
  storeId?: string;
  name?: string;
  access: "read_only" | "read_write";
  instructions?: string;
}

type EnvMap = Record<string, string | undefined>;

export function buildSandboxEnvForEnvironment(
  base: EnvMap,
  environment?: EnvironmentConfig | null,
): EnvMap {
  const sandbox = asRecord(environment?.config?.sandbox);
  if (!sandbox) return { ...base };

  const out: EnvMap = { ...base };
  setString(out, "SANDBOX_PROVIDER", sandbox.provider);
  setString(out, "SANDBOX_IMAGE", sandbox.image);
  setString(out, "DAYTONA_WORKDIR", sandbox.workdir);
  setBoolean(out, "DAYTONA_EPHEMERAL", sandbox.ephemeral);
  setBoolean(out, "DAYTONA_BOOTSTRAP_TOOLS", sandbox.bootstrap_tools);
  setStringArray(out, "DAYTONA_BOOTSTRAP_APT_PACKAGES", sandbox.bootstrap_apt_packages);
  setPositiveNumber(out, "DAYTONA_MAX_FILE_BYTES", sandbox.max_file_bytes);
  return out;
}

export function sandboxProviderFromEnvironment(
  base: EnvMap,
  environment?: EnvironmentConfig | null,
): string {
  return (buildSandboxEnvForEnvironment(base, environment).SANDBOX_PROVIDER ?? "subprocess")
    .toLowerCase();
}

export function environmentMountsSessionOutputs(
  environment?: EnvironmentConfig | null,
): boolean {
  const resources = environment?.config?.resources;
  if (asRecord(resources)?.outputs === false) return false;
  return true;
}

export function environmentMemoryStoreRefs(
  environment?: EnvironmentConfig | null,
): EnvironmentMemoryStoreRef[] {
  const config = environment?.config;
  if (!config) return [];

  const refs: EnvironmentMemoryStoreRef[] = [];
  const memoryStores = asArray(asRecord(config.memory)?.stores);
  const resourceMemoryStores = asArray(asRecord(config.resources)?.memory_stores);
  const resourceArray = asArray(config.resources);

  for (const value of [...memoryStores, ...resourceMemoryStores, ...resourceArray]) {
    const row = asRecord(value);
    if (!row) continue;
    if (row.type !== undefined && row.type !== "memory_store") continue;
    const ref = normalizeMemoryStoreRef(row);
    if (ref) refs.push(ref);
  }

  return refs;
}

function normalizeMemoryStoreRef(
  row: Record<string, unknown>,
): EnvironmentMemoryStoreRef | null {
  const storeId = stringValue(row.memory_store_id) ?? stringValue(row.store_id) ?? stringValue(row.id);
  const name = stringValue(row.name);
  if (!storeId && !name) return null;
  return {
    ...(storeId ? { storeId } : {}),
    ...(name ? { name } : {}),
    access: row.access === "read_only" ? "read_only" : "read_write",
    ...(stringValue(row.instructions)
      ? { instructions: stringValue(row.instructions)!.slice(0, 4096) }
      : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function setString(out: EnvMap, key: string, value: unknown): void {
  const str = stringValue(value);
  if (str) out[key] = str;
}

function setBoolean(out: EnvMap, key: string, value: unknown): void {
  if (typeof value === "boolean") out[key] = value ? "true" : "false";
}

function setStringArray(out: EnvMap, key: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  const parts = value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
  if (parts.length > 0) out[key] = parts.join(",");
}

function setPositiveNumber(out: EnvMap, key: string, value: unknown): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return;
  out[key] = String(Math.floor(value));
}
