import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ArchiveIcon, CopyIcon, LockKeyholeIcon, PlusIcon, Trash2Icon } from "lucide-react";

import { VaultIcon } from "@/components/icons";

import { ApiError, useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { formatDate, plural, toDate } from "../lib/format";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { EntityAvatar } from "../components/AgentAvatar";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DetailHeader } from "../components/DetailHeader";
import { EmptyState, RecordNotFound } from "../components/EmptyState";
import { CopyButton, IdChip } from "../components/IdChip";
import { Page } from "../components/Page";
import { Property, PropertyList } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu, type RowAction } from "../components/RowActionsMenu";
import { SectionCard } from "../components/SectionCard";
import { Skeleton, SkeletonDetail } from "../components/Skeleton";
import { Tip } from "../components/Tip";
import { AddCredentialDialog } from "../components/resources/AddCredentialDialog";
import {
  credentialBreakdown,
  credentialKind,
  credentialTarget,
  isConnectedAppsVault,
  useVaultCredentials,
  type Credential,
  type Vault,
} from "../components/resources/credentials";
import { ArchiveStatusFilter, MaskedSecret, type ArchiveStatus } from "../components/resources/ResourceBits";
import { UsedByList, useResourceUsage } from "../components/resources/usage";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/** Label column for the narrow aside, so a full id fits beside it. */
// The aside's label column: the same width as PropertyList labelWidth="narrow".
const ASIDE_ROW = "grid-cols-[6.5rem_minmax(0,1fr)]";

/** Columns of the credentials list: credential · secret · updated · menu. */
const COLS = "grid grid-cols-[minmax(0,1fr)_40px] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,148px)_76px_40px]";

function joinWords(parts: string[]): string {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/** When an OAuth access token runs out, with a tone when that is soon or past. */
function TokenExpiry({ value }: { value: string | null | undefined }) {
  const date = toDate(value);
  if (!date) return null;
  const days = (date.getTime() - Date.now()) / 86_400_000;
  const text = days < 0 ? "Token expired" : `Valid until ${formatDate(date)}`;
  return (
    <span className={cn("block truncate text-xs", days < 0 ? "text-danger" : days < 7 ? "text-warning" : "text-fg-subtle")} title={text}>
      {text}
    </span>
  );
}

function CredentialRow({
  cred,
  onDelete,
}: {
  cred: Credential;
  onDelete: () => void;
}) {
  const kind = credentialKind(cred);
  const target = credentialTarget(cred);
  const archived = !!cred.archived_at;
  const keyId = typeof cred.auth.extras?.access_key_id === "string" ? cred.auth.extras.access_key_id : null;

  const actions: RowAction[] = [
    { label: "Copy credential id", icon: <CopyIcon />, onSelect: () => void copyText(cred.id) },
    ...(cred.auth.mcp_server_url
      ? [{ label: "Copy server URL", icon: <CopyIcon />, onSelect: () => void copyText(cred.auth.mcp_server_url!) }]
      : []),
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: onDelete },
  ];

  return (
    <li className={cn(COLS, "min-h-[60px] border-t border-border px-5 py-2.5 first:border-t-0")}>
      <div className="flex min-w-0 items-center gap-3">
        <EntityAvatar icon={kind.icon} size="md" className={cn(archived && "opacity-60")} />
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <span className={cn("truncate text-small-size font-medium", archived ? "text-fg-muted" : "text-fg")} title={cred.display_name}>
              {cred.display_name}
            </span>
            {archived && <Chip tone="outline">Archived</Chip>}
          </div>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
            <Tip label={kind.about}>
              <span className="shrink-0 text-fg-muted">{kind.label}</span>
            </Tip>
            <span aria-hidden="true">·</span>
            <span className={cn("truncate", target.mono && "font-mono text-micro-size")} title={target.full ?? target.text}>
              {target.text}
            </span>
          </div>
        </div>
      </div>

      <div className="hidden min-w-0 sm:block">
        <MaskedSecret />
        {keyId && (
          <span className="mt-1 flex min-w-0 items-center gap-0.5 text-xs text-fg-subtle">
            <span className="truncate" title={`Access key id ${keyId}`}>
              Key id{" "}
              <span className="font-mono text-micro-size text-fg-muted">
                {keyId.length > 12 ? `${keyId.slice(0, 4)}…${keyId.slice(-4)}` : keyId}
              </span>
            </span>
            <CopyButton value={keyId} label="Copy access key id" className="size-5" />
          </span>
        )}
        {cred.auth.type === "mcp_oauth" && <TokenExpiry value={cred.auth.expires_at} />}
      </div>

      <div className="hidden sm:block">
        <RelativeTime value={cred.updated_at ?? cred.created_at} className="text-small text-fg-muted" />
      </div>

      <RowActionsMenu label={`Actions for ${cred.display_name}`} actions={actions} />
    </li>
  );
}

/**
 * Vault — the record of one vault and everything in it. The credentials
 * are the page: each row says what the secret is for, how it is held and
 * when it changed, and never the secret itself. "Add credential" is the
 * one primary action; it also opens from Integrations
 * (`?connect=composio&toolkit=…`).
 */
export function VaultDetail() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const usage = useResourceUsage();

  const { data: vault, error: vaultError, isLoading, refetch: refetchVault } = useApiQuery<Vault>(
    id ? `/v1/vaults/${id}` : null,
  );
  const { credentials: loaded, isLoading: credsLoading, error: credsError, refetch: refetchCreds } = useVaultCredentials(id);
  const credentials = useMemo(() => loaded ?? [], [loaded]);

  // Filtered here: the credentials endpoint takes no status param and
  // returns the vault's whole (small) list in one response.
  const [status, setStatus] = useState<ArchiveStatus>("active");
  const shown = useMemo(() => {
    if (status === "any") return credentials;
    if (status === "active") return credentials.filter((c) => !c.archived_at);
    return credentials.filter((c) => !!c.archived_at);
  }, [credentials, status]);
  const active = useMemo(() => credentials.filter((c) => !c.archived_at), [credentials]);

  const [showAdd, setShowAdd] = useState(false);
  const connectMode = searchParams.get("connect");
  const connectToolkit = searchParams.get("toolkit") ?? "";
  useEffect(() => {
    if (connectMode === "composio" && vault && !vault.archived_at) setShowAdd(true);
  }, [connectMode, vault]);

  const reloadCredentials = useCallback(() => {
    if (!id) return;
    void refetchCreds();
    void queryClient.invalidateQueries({ queryKey: [`/v1/vaults/${id}/credentials`] });
  }, [id, refetchCreds, queryClient]);

  const closeAdd = () => {
    setShowAdd(false);
    if (searchParams.has("connect") || searchParams.has("toolkit")) {
      setSearchParams(new URLSearchParams(), { replace: true });
    }
  };

  const [confirm, setConfirm] = useState<
    { kind: "archive" } | { kind: "delete" } | { kind: "credential"; cred: Credential } | null
  >(null);

  if (vaultError && !vault) {
    const missing = vaultError instanceof ApiError && vaultError.status === 404;
    return (
      <Page>
        {missing ? (
          <RecordNotFound thing="vault" kind="vault" back={{ to: "/vaults", label: "vaults" }} className="mt-4" />
        ) : (
          <ErrorState title="This vault could not be loaded" error={vaultError} retry={() => void refetchVault()} className="mt-4" />
        )}
      </Page>
    );
  }
  if (isLoading || !vault) {
    return (
      <Page>
        <SkeletonDetail />
      </Page>
    );
  }

  const archived = !!vault.archived_at;
  const managed = isConnectedAppsVault(vault);
  const agents = usage.vaults.get(vault.id) ?? [];
  const breakdown = credentialBreakdown(active);

  const description = managed
    ? "Created for you to hold the apps you connect from Integrations or while setting up an agent."
    : credsLoading
      ? undefined
      : active.length === 0
        ? "Nothing is stored here yet."
        : `Credentials for ${joinWords(breakdown.map((b) => b.label))}.`;

  const addButton = (variant: "default" | "secondary" = "default", size: "default" | "sm" = "default") => (
    <Button variant={variant} size={size} onClick={() => setShowAdd(true)}>
      <PlusIcon data-icon="inline-start" className={variant === "default" ? "stroke-[2.25]" : undefined} />
      Add credential
    </Button>
  );

  return (
    <Page>
      <DetailHeader
        avatar={<EntityAvatar icon={VaultIcon} size="xl" />}
        title={vault.name}
        status={<StatusBadge status={archived ? "archived" : "active"} variant="soft" />}
        description={description}
        meta={
          <>
            {managed && <Chip title="Created and used by the product">Managed</Chip>}
            {managed && !credsLoading && <Chip icon={LockKeyholeIcon}>{plural(active.length, "credential")}</Chip>}
            {!usage.isLoading && (
              <Chip>{agents.length === 0 ? "Not used by an agent" : `Used by ${plural(agents.length, "agent")}`}</Chip>
            )}
          </>
        }
        actions={!archived ? addButton() : undefined}
        menu={
          <RowActionsMenu
            label={`Actions for ${vault.name}`}
            actions={[
              { label: "Copy vault id", icon: <CopyIcon />, onSelect: () => void copyText(vault.id) },
              { label: "Archive", icon: <ArchiveIcon />, disabled: archived, onSelect: () => setConfirm({ kind: "archive" }) },
              { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm({ kind: "delete" }) },
            ]}
          />
        }
      />

      {archived && (
        <Callout tone="neutral" icon={ArchiveIcon} title="This vault is archived" className="mb-6">
          Agents can no longer borrow from it, and nothing can be added. Its credentials were archived with it.
        </Callout>
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <SectionCard
          title="Credentials"
          description="What agents can borrow from this vault."
          actions={<ArchiveStatusFilter value={status} onChange={setStatus} align="end" />}
          flush
          footer={
            <span className="flex items-start gap-2">
              <LockKeyholeIcon className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
              <span>
                Secrets are encrypted and write-only. Nothing on this page can reveal one; to change a secret, delete
                the credential and add it again.
              </span>
            </span>
          }
          className="min-w-0 self-start"
        >
          {credsError && credentials.length === 0 ? (
            <div className="p-5">
              <ErrorState compact title="Credentials could not be loaded" error={credsError} retry={() => void refetchCreds()} />
            </div>
          ) : credsLoading ? (
            <ul aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex h-[60px] items-center gap-3 border-t border-border px-5 first:border-t-0">
                  <Skeleton className="size-8 shrink-0" rounded="lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3" rounded="sm" style={{ width: `${28 + i * 9}%` }} />
                    <Skeleton className="h-2.5" rounded="sm" style={{ width: `${18 + i * 5}%` }} />
                  </div>
                  <Skeleton className="hidden h-[22px] w-24 sm:block" rounded="full" />
                </li>
              ))}
            </ul>
          ) : shown.length === 0 ? (
            credentials.length === 0 ? (
              <EmptyState
                kind="vault"
                size="md"
                variant="plain"
                title="No credentials yet"
                body={
                  managed
                    ? "Apps you connect from Integrations land here. You can also add an MCP server or a CLI token directly."
                    : "Sign in to an MCP server, paste a token, or add a command-line tool. Agents that use this vault can then reach it."
                }
                action={
                  !archived && (
                    <>
                      {addButton("secondary", "sm")}
                      {managed && (
                        <Button variant="ghost" size="sm" asChild>
                          <Link to="/integrations/apps">Browse apps</Link>
                        </Button>
                      )}
                    </>
                  )
                }
              />
            ) : (
              <EmptyState
                size="md"
                variant="plain"
                icon={<LockKeyholeIcon />}
                title={status === "archived" ? "No archived credentials" : "No active credentials"}
                body={
                  status === "archived"
                    ? "Nothing in this vault has been archived."
                    : "Every credential in this vault is archived."
                }
                action={
                  <Button variant="outline" size="sm" onClick={() => setStatus("any")}>
                    Show all
                  </Button>
                }
              />
            )
          ) : (
            <>
              <div className={cn(COLS, "hidden h-9 border-b border-border px-5 text-xs font-medium text-fg-subtle sm:grid")}>
                <span>Credential</span>
                <span>Secret</span>
                <span>Updated</span>
                <span className="sr-only">Actions</span>
              </div>
              <ul>
                {shown.map((c) => (
                  <CredentialRow key={c.id} cred={c} onDelete={() => setConfirm({ kind: "credential", cred: c })} />
                ))}
              </ul>
            </>
          )}
        </SectionCard>

        <aside className="min-w-0 space-y-4">
          <SectionCard title="Used by" description={agents.length > 0 ? `${plural(agents.length, "agent")} can borrow from this vault.` : undefined}>
            <UsedByList
              agents={usage.vaults.get(vault.id)}
              loading={usage.isLoading}
              empty="No agent uses this vault yet. Attach it in an agent's settings and its sessions can use these credentials."
            />
          </SectionCard>
          <SectionCard title="Details">
            <PropertyList>
              <Property label="Created" className={ASIDE_ROW}>
                <RelativeTime value={vault.created_at} />
              </Property>
              <Property label="Updated" className={ASIDE_ROW}>
                <RelativeTime value={vault.updated_at ?? vault.created_at} />
              </Property>
              {archived && (
                <Property label="Archived" className={ASIDE_ROW}>
                  <RelativeTime value={vault.archived_at} />
                </Property>
              )}
              <Property label="Vault id" className={ASIDE_ROW}>
                <IdChip id={vault.id} full />
              </Property>
            </PropertyList>
          </SectionCard>
        </aside>
      </div>

      {showAdd && !archived && (
        <AddCredentialDialog
          key={`${connectMode}:${connectToolkit}`}
          vault={vault}
          initialKind={connectMode === "composio" ? "composio" : undefined}
          initialToolkits={connectToolkit ? [connectToolkit] : undefined}
          hasComposioCredential={credentials.some((cred) => !cred.archived_at && cred.auth.type === "composio_mcp")}
          onClose={closeAdd}
          onCreated={() => {
            closeAdd();
            reloadCredentials();
          }}
        />
      )}

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind !== "archive"}
        title={
          confirm?.kind === "credential"
            ? `Delete ${confirm.cred.display_name}?`
            : confirm?.kind === "delete"
              ? `Delete ${vault.name}?`
              : `Archive ${vault.name}?`
        }
        body={
          confirm?.kind === "credential"
            ? "The stored secret is removed, and agents that borrow from this vault lose this access. This cannot be undone."
            : confirm?.kind === "delete"
              ? `The vault and ${active.length === 0 ? "everything in it" : `its ${plural(active.length, "credential")}`} are removed. ${agents.length > 0 ? `${plural(agents.length, "agent")} will lose that access. ` : ""}This cannot be undone.`
              : "The vault and all of its credentials are archived, and agents can no longer borrow from it. Archiving cannot be reversed."
        }
        confirmLabel={
          confirm?.kind === "credential" ? "Delete credential" : confirm?.kind === "delete" ? "Delete vault" : "Archive vault"
        }
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === "credential") {
            await api(`/v1/vaults/${vault.id}/credentials/${confirm.cred.id}`, { method: "DELETE" });
            reloadCredentials();
            return;
          }
          if (confirm.kind === "delete") await api(`/v1/vaults/${vault.id}`, { method: "DELETE" });
          else await api(`/v1/vaults/${vault.id}/archive`, { method: "POST" });
          void queryClient.invalidateQueries({ queryKey: ["/v1/vaults"] });
          nav("/vaults");
        }}
      />
    </Page>
  );
}
