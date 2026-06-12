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
  const {
    data: composioStatus,
    isLoading: composioStatusLoading,
    refetch: refetchComposioStatus,
  } = useApiQuery<ComposioStatusResponse>("/v1/composio/status");
  const composioConfigured = composioStatus?.configured === true;
  const composioKeySource = composioStatus?.source ?? null;
  const [keyInput, setKeyInput] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [showKeyForm, setShowKeyForm] = useState(false);

  const saveComposioKey = async () => {
    const apiKey = keyInput.trim();
    if (!apiKey) return;
    setSavingKey(true);
    try {
      await api(`/v1/composio/key`, {
        method: "PUT",
        body: JSON.stringify({ api_key: apiKey }),
      });
      setKeyInput("");
      setShowKeyForm(false);
      toast.success("Composio connected — loading your app catalog");
      await refetchComposioStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save Composio key");
    } finally {
      setSavingKey(false);
    }
  };
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
                : "Connect Composio to get started"
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
      {!composioStatusLoading && (!composioConfigured || showKeyForm) && (
        <div className="mb-4 max-w-xl rounded-md border border-border bg-bg-surface p-4 shadow-sm">
          <div className="text-sm font-medium text-fg">Connect Composio</div>
          <p className="mt-1 text-[13px] leading-relaxed text-fg-muted">
            Powers the app catalog and account connections (Gmail, GitHub, Calendar, …).
            Paste an API key from{" "}
            <a
              href="https://app.composio.dev"
              target="_blank"
              rel="noreferrer"
              className="text-brand hover:underline"
            >
              app.composio.dev
            </a>{" "}
            — it&apos;s stored encrypted in your workspace and only used for your agents.
          </p>
          <div className="mt-3 flex gap-2">
            <input
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveComposioKey();
              }}
              placeholder="Composio API key"
              autoComplete="off"
              className="flex-1 border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle font-mono"
            />
            <Button onClick={() => void saveComposioKey()} disabled={savingKey || !keyInput.trim()}>
              {savingKey ? "Verifying…" : "Connect"}
            </Button>
            {showKeyForm && (
              <Button variant="outline" onClick={() => setShowKeyForm(false)}>
                Cancel
              </Button>
            )}
          </div>
        </div>
      )}
      {!composioStatusLoading && composioConfigured && composioKeySource === "tenant" && !showKeyForm && (
        <div className="mb-4 flex items-center gap-2 text-[13px] text-fg-muted">
          <span className="inline-block size-1.5 rounded-full bg-success" />
          Using your Composio key
          <button
            type="button"
            onClick={() => setShowKeyForm(true)}
            className="text-brand hover:underline"
          >
            Replace
          </button>
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
