import { useEffect, useMemo, useRef, useState } from "react";
import { AppIcon } from "../components/agents/controls";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { ArrowRightIcon, ExternalLinkIcon, PlugIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import { EntityAvatar } from "../components/AgentAvatar";
import { StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { EmptyState } from "../components/EmptyState";
import { FacetedFilter } from "../components/FacetedFilter";
import { FilterChip } from "../components/FilterChip";
import { SecretInput } from "../components/Input";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { Section } from "../components/SectionCard";
import { Skeleton } from "../components/Skeleton";
import { ListToolbar } from "../components/Toolbar";
import { IntegrationsApi } from "../integrations/api/client";
import { PROVIDERS, ProviderMark, type ProviderId } from "../integrations/components/providers";
import { useApi } from "../lib/api";
import { plural } from "../lib/format";
import { useApiQuery } from "../lib/useApiQuery";
import {
  composioEntriesFromCatalog,
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

const integrations = new IntegrationsApi();
const NATIVE: ProviderId[] = ["slack", "github", "linear"];
const NATIVE_BLURB: Record<ProviderId, string> = {
  slack: "Mentions, threads and DMs",
  github: "Issues, pull requests and reviews",
  linear: "Assigned issues and comments",
};

// Categories the curated list uses, in the order people look for them.
// Anything else the catalog brings sorts after these, alphabetically.
const CATEGORY_ORDER = ["Development", "Communication", "Knowledge", "Tasks", "Business", "Data", "Commerce", "Files"];

const link = inlineLink;

/**
 * Apps — the directory of what agents can connect to. Two shelves: the
 * three native integrations where an agent becomes a teammate, and the
 * Composio catalog of tools an agent can use. Connecting an app opens the
 * vault that will hold its sign-in.
 */
export function IntegrationsApps() {
  const nav = useNavigate();
  const { api } = useApi();
  const { data: vaultsRes, refetch } = useApiQuery<{ data: Vault[] }>("/v1/vaults?status=active&limit=100");
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
  // The app someone tried to connect before Composio was set up.
  const [wanted, setWanted] = useState<string | null>(null);
  const keyRef = useRef<HTMLDivElement>(null);

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
      setWanted(null);
      toast.success("Composio connected. Loading your app catalog.");
      await refetchComposioStatus();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The Composio key could not be saved");
    } finally {
      setSavingKey(false);
    }
  };

  const {
    data: catalogRes,
    isLoading: catalogLoading,
    error: catalogError,
    refetch: refetchCatalog,
  } = useApiQuery<ComposioToolkitCatalogResponse>("/v1/composio/toolkits?limit=500", undefined, {
    enabled: composioConfigured,
  });
  const [connecting, setConnecting] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const composioLoading = composioStatusLoading || (composioConfigured && catalogLoading);

  const activeVaults = useMemo(() => (vaultsRes?.data ?? []).filter((v) => !v.archived_at), [vaultsRes]);
  const catalogEntries = useMemo(() => composioEntriesFromCatalog(catalogRes), [catalogRes]);

  const categories = useMemo(() => {
    const seen = [...new Set(catalogEntries.map((e) => e.category))];
    const rank = (c: string) => (CATEGORY_ORDER.includes(c) ? CATEGORY_ORDER.indexOf(c) : CATEGORY_ORDER.length);
    return seen.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  }, [catalogEntries]);

  const filtered = useMemo(() => {
    const bySearch = filterComposioEntries(catalogEntries, search);
    return category === "all" ? bySearch : bySearch.filter((e) => e.category === category);
  }, [catalogEntries, search, category]);

  const grouped = useMemo(() => {
    const map = new Map<string, ComposioIntegrationEntry[]>();
    for (const c of categories) map.set(c, []);
    for (const e of filtered) map.get(e.category)?.push(e);
    return [...map.entries()].filter(([, list]) => list.length > 0);
  }, [categories, filtered]);

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
      // No dead end: take the person to the one thing that is missing.
      setWanted(entry.name);
      keyRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      keyRef.current?.querySelector("input")?.focus({ preventScroll: true });
      return;
    }
    setConnecting(entry.slug);
    try {
      const vault = await ensureVault();
      nav(`/vaults/${vault.id}?connect=composio&toolkit=${encodeURIComponent(entry.slug)}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "The app could not be opened");
    } finally {
      setConnecting(null);
    }
  };

  const showForm = !composioStatusLoading && (!composioConfigured || showKeyForm);
  const filtering = !!search || category !== "all";

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          title="Apps"
          width="wide"
          subtitle="What your agents can connect to: places they work as teammates, and tools they can use."
        />
      }
    >
      <div className="space-y-10">
        <Section title="Agents as teammates" description="Native integrations. The agent gets its own name and identity there.">
          <div className="grid gap-4 xl:grid-cols-3">
            {NATIVE.map((p) => (
              <NativeCard key={p} provider={p} />
            ))}
          </div>
        </Section>

        <Section
          title="Tools agents can use"
          description="Sign an app in once, keep the sign-in in a vault, and attach it to any agent."
        >
          <div className="space-y-4">
            {/* Composio: the service behind this shelf. */}
            <div ref={keyRef}>
              {composioStatusLoading ? (
                <div className="surface flex items-center gap-4 rounded-xl p-5" aria-hidden="true">
                  <Skeleton className="size-10" rounded="lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-48" rounded="sm" />
                    <Skeleton className="h-3 w-96 max-w-full" rounded="sm" />
                  </div>
                </div>
              ) : showForm ? (
                <section className="surface rounded-xl p-5" aria-label="Connect Composio">
                  <div className="flex gap-4">
                    <EntityAvatar icon={PlugIcon} size="lg" />
                    <div className="min-w-0 flex-1">
                      <h3 className="text-h3 text-fg">
                        {composioConfigured
                          ? "Replace the Composio key"
                          : wanted
                            ? `Connect Composio to finish connecting ${wanted}`
                            : "Connect Composio to turn these on"}
                      </h3>
                      <p className="mt-0.5 max-w-[88ch] text-small text-fg-muted">
                        Composio provides this catalog and handles each app's sign-in. Paste an API key from{" "}
                        <a href="https://app.composio.dev" target="_blank" rel="noreferrer" className={link}>
                          app.composio.dev
                          <ExternalLinkIcon className="ml-0.5 inline size-3 align-[-1px]" />
                        </a>
                        . It is stored encrypted in your workspace and used only for your agents.
                      </p>
                      <form
                        className="mt-4 flex max-w-xl flex-col gap-2 sm:flex-row sm:items-start"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void saveComposioKey();
                        }}
                      >
                        <div className="min-w-0 flex-1">
                          <SecretInput
                            value={keyInput}
                            onChange={(e) => setKeyInput(e.target.value)}
                            placeholder="Composio API key"
                            aria-label="Composio API key"
                            disabled={savingKey}
                          />
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {showKeyForm && (
                            <Button type="button" variant="ghost" onClick={() => setShowKeyForm(false)} disabled={savingKey}>
                              Cancel
                            </Button>
                          )}
                          <Button type="submit" disabled={!keyInput.trim()} loading={savingKey}>
                            {composioConfigured ? "Replace key" : "Connect Composio"}
                          </Button>
                        </div>
                      </form>
                    </div>
                  </div>
                </section>
              ) : (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-bg-soft px-4 py-2.5 text-small text-fg-muted">
                  <StatusBadge status="connected" label="Composio connected" />
                  <span className="min-w-0 flex-1">
                    {composioKeySource === "tenant"
                      ? "Using your workspace's own Composio key."
                      : "Composio is provided by this workspace's host."}
                  </span>
                  {composioKeySource === "tenant" && (
                    <Button variant="ghost" size="sm" onClick={() => setShowKeyForm(true)}>
                      Replace key
                    </Button>
                  )}
                </div>
              )}
            </div>

            <ListToolbar
              search={{ value: search, onChange: setSearch, placeholder: "Search apps" }}
              filters={
                <FilterChip
                  label="Category"
                  active={category !== "all"}
                  display={category !== "all" ? category : undefined}
                  onClear={() => setCategory("all")}
                >
                  <PopoverContent align="start" sideOffset={6} collisionPadding={8} className="w-56 gap-0 p-0">
                    <FacetedFilter
                      options={[{ value: "all", label: "All categories" }, ...categories.map((c) => ({ value: c, label: c }))]}
                      value={category}
                      onValueChange={setCategory}
                      searchPlaceholder="Category"
                    />
                  </PopoverContent>
                </FilterChip>
              }
              summary={composioLoading ? undefined : filtering ? `${filtered.length} of ${plural(catalogEntries.length, "app")}` : plural(catalogEntries.length, "app")}
            />

            {catalogError != null && (
              <Callout
                tone="warning"
                title="The full catalog could not be loaded"
                action={
                  <Button variant="outline" size="sm" onClick={() => void refetchCatalog()}>
                    Try again
                  </Button>
                }
              >
                Showing the most used apps for now.
              </Callout>
            )}

            {composioLoading ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4" aria-hidden="true">
                {Array.from({ length: 9 }).map((_, i) => (
                  <div key={i} className="surface flex items-center gap-3.5 rounded-xl p-4">
                    <Skeleton className="size-10" rounded="lg" />
                    <div className="flex-1 space-y-2">
                      <Skeleton className="h-3.5 w-28" rounded="sm" />
                      <Skeleton className="h-3 w-full" rounded="sm" />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState
                size="md"
                title={search ? `No apps match "${search}"` : "No apps in this category"}
                body="Try a different name, or look across every category."
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setSearch("");
                      setCategory("all");
                    }}
                  >
                    Clear filters
                  </Button>
                }
              />
            ) : (
              <div className="space-y-7">
                {grouped.map(([name, list]) => (
                  <section key={name} aria-label={name}>
                    <h3 className="mb-2.5 flex items-baseline gap-2 text-small-size font-medium text-fg">
                      {name}
                      <span className="text-xs font-normal text-fg-subtle">{list.length}</span>
                    </h3>
                    <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                      {list.map((entry) => (
                        <li key={entry.slug} className="surface flex min-h-[84px] items-center gap-3.5 rounded-xl p-4">
                          <AppMark entry={entry} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-h3 text-fg" title={entry.name}>
                              {entry.name}
                            </p>
                            <p className="line-clamp-2 text-xs text-fg-subtle" title={entry.description}>
                              {entry.description}
                            </p>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void connect(entry)}
                            loading={connecting === entry.slug}
                            disabled={!!connecting && connecting !== entry.slug}
                            aria-label={`Connect ${entry.name}`}
                          >
                            Connect
                          </Button>
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        </Section>
      </div>
    </Page>
  );
}

/** An app's mark: its vendored brand glyph, or its initial. */
function AppMark({ entry }: { entry: ComposioIntegrationEntry }) {
  return <AppIcon slug={entry.slug} name={entry.name} size="lg" tone="surface" />;
}

/** One native integration: its mark, what it covers, and whether it is set up. */
function NativeCard({ provider }: { provider: ProviderId }) {
  const meta = PROVIDERS[provider];
  const [count, setCount] = useState<number | null | "error">(null);

  useEffect(() => {
    let alive = true;
    integrations[provider]
      .listInstallations()
      .then((list) => alive && setCount(list.length))
      .catch(() => alive && setCount("error"));
    return () => {
      alive = false;
    };
  }, [provider]);

  return (
    <Link
      to={meta.listPath}
      className={cn("surface lift group/native flex items-center gap-3.5 rounded-xl p-4")}
      aria-label={`${meta.name}: ${NATIVE_BLURB[provider]}`}
    >
      <ProviderMark provider={provider} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-h3 text-fg">{meta.name}</p>
        <p className="line-clamp-2 text-xs text-fg-subtle">{NATIVE_BLURB[provider]}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {count === null ? (
          <Skeleton className="h-3.5 w-20" rounded="sm" />
        ) : count === "error" ? (
          <span className="text-xs text-fg-subtle">Status unavailable</span>
        ) : count > 0 ? (
          <StatusBadge status="connected" label={plural(count, meta.workspaceNoun)} />
        ) : (
          <span className="text-small-size font-medium text-fg-muted">Set up</span>
        )}
        <ArrowRightIcon className="size-4 text-fg-faint transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)] group-hover/native:translate-x-0.5 group-hover/native:text-fg" />
      </div>
    </Link>
  );
}
