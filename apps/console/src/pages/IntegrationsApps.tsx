import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import {
  COMPOSIO_NOT_CONFIGURED_MESSAGE,
  composioEntriesFromCatalog,
  composioIntegrationIcon,
  filterComposioEntries,
  type ComposioToolkitCatalogResponse,
  type ComposioIntegrationEntry,
  type ComposioStatusResponse,
} from "../lib/composio-integrations";

interface Vault {
  id: string;
  name: string;
  archived_at?: string | null;
}

export function IntegrationsApps() {
  const nav = useNavigate();
  const { api } = useApi();
  const { data: vaultsRes, refetch } = useApiQuery<{ data: Vault[] }>(
    "/v1/vaults?status=active&limit=100",
  );
  const { data: composioStatus, isLoading: composioStatusLoading } =
    useApiQuery<ComposioStatusResponse>("/v1/composio/status");
  const composioConfigured = composioStatus?.configured === true;
  const { data: catalogRes, isLoading: catalogLoading } =
    useApiQuery<ComposioToolkitCatalogResponse>("/v1/composio/toolkits?limit=500", undefined, {
      enabled: composioConfigured,
    });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const composioLoading = composioStatusLoading || (composioConfigured && catalogLoading);

  const activeVaults = useMemo(
    () => (vaultsRes?.data ?? []).filter((v) => !v.archived_at),
    [vaultsRes],
  );
  const catalogEntries = useMemo(() => composioEntriesFromCatalog(catalogRes), [catalogRes]);
  const filtered = useMemo(
    () => filterComposioEntries(catalogEntries, search),
    [catalogEntries, search],
  );

  const ensureVault = async (): Promise<Vault> => {
    if (activeVaults[0]) return activeVaults[0];
    const created = await api<Vault>("/v1/vaults", {
      method: "POST",
      body: JSON.stringify({ name: "Connected Apps" }),
    });
    await refetch();
    return created;
  };

  const connect = async (entry: ComposioIntegrationEntry) => {
    if (!composioConfigured) {
      toast.error(COMPOSIO_NOT_CONFIGURED_MESSAGE);
      return;
    }
    setConnecting(entry.slug);
    try {
      const vault = await ensureVault();
      nav(`/vaults/${vault.id}?connect=composio&toolkit=${encodeURIComponent(entry.slug)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to open integration");
    } finally {
      setConnecting(null);
    }
  };

  return (
    <Page
      header={
        <PageHeader
          title="Apps"
          subtitle={
            composioLoading
              ? "Composio catalog loading..."
              : composioConfigured
                ? `${catalogEntries.length} Composio apps`
                : "Composio not configured"
          }
          toolbar={
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search apps..."
              className="w-full max-w-sm border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle"
            />
          }
        />
      }
    >
      {!composioStatusLoading && !composioConfigured && (
        <div className="mb-4 rounded-md border border-warning/30 bg-warning-subtle px-3 py-2 text-sm text-warning">
          {COMPOSIO_NOT_CONFIGURED_MESSAGE}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {filtered.map((entry) => (
          <div
            key={entry.slug}
            className="border border-border rounded-md p-3 flex items-start gap-3 bg-bg"
          >
            <img
              src={composioIntegrationIcon(entry)}
              alt=""
              loading="lazy"
              decoding="async"
              className="w-7 h-7 rounded shrink-0"
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 min-w-0">
                <div className="font-medium text-sm text-fg truncate">{entry.name}</div>
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-bg-surface text-fg-subtle shrink-0">
                  {entry.category}
                </span>
              </div>
              <div className="text-xs text-fg-subtle font-mono mt-1 truncate">
                {entry.slug}
              </div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void connect(entry)}
              disabled={!composioConfigured || !!connecting}
            >
              Connect
            </Button>
          </div>
        ))}
      </div>
    </Page>
  );
}
