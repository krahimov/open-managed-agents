import type { VaultService } from "@open-managed-agents/vaults-store";

/** Same selection as AccessRequestCard.ensureVault without its explicit-vault override:
 *  Connected Apps, else the first active vault. Read-only; null when none exists. */
export async function findConnectedAppsVault(vaults: Pick<VaultService, "list">, tenantId: string) {
  const active = (await vaults.list({ tenantId, includeArchived: false })).filter(v => !v.archived_at);
  return active.find(v => v.name === "Connected Apps") ?? active[0] ?? null;
}

/** findConnectedAppsVault, creating "Connected Apps" when the workspace has no active vault. */
export async function ensureConnectedAppsVault(vaults: Pick<VaultService, "list" | "create">, tenantId: string) {
  return await findConnectedAppsVault(vaults, tenantId) ?? await vaults.create({ tenantId, name: "Connected Apps" });
}
