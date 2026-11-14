import { useEffect, useMemo, useRef, useState } from "react";
import { BanIcon, CopyIcon, LockIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

import { useAsyncAction } from "../hooks/useAsyncAction";
import { useApi } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { formatAbsolute, formatDate, formatRelativeTime, plural, toDate } from "../lib/format";
import { useServerFeature } from "../lib/server-features";
import { Chip, StatusBadge } from "../components/Badge";
import { Callout } from "../components/Callout";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DateField } from "../components/DateField";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { Disclosure } from "../components/Disclosure";
import { Field } from "../components/Field";
import { TextInput } from "../components/Input";
import { Modal } from "../components/Modal";
import { Page } from "../components/Page";
import { PageHeader } from "../components/PageHeader";
import { PropertyList, Property } from "../components/PropertyList";
import { ErrorState } from "../components/QueryProblem";
import { RelativeTime } from "../components/RelativeTime";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { ChipRow, ResourceIdentity } from "../components/resources/ResourceBits";
import { Tip } from "../components/Tip";
import { useLocalSearch } from "../lib/useLocalSearch";
import { CommandLine, SecretOnce } from "../components/settings/CopyField";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  scopes?: string[];
  resource_ids?: Record<string, string[]>;
  expires_at?: string | null;
  last_used_at?: string | null;
}

const DAY = 86_400_000;
const SUBTITLE = "Keys let the CLI, the SDK and your own services act in this workspace.";

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const defaultExpiry = () => isoDay(90);

/** Quick fills for the scopes field. The field stays editable. */
const SCOPE_PRESETS: Array<{ label: string; value: string; hint: string }> = [
  { label: "Read only", value: "*:read", hint: "Can read everything your role can see. Cannot change anything." },
  { label: "Session automation", value: "sessions:read, sessions:write", hint: "Can start sessions and read their results." },
  { label: "Full access", value: "*", hint: "Can do everything your workspace role allows." },
];

const EXPIRY_PRESETS: Array<{ label: string; days: number | null }> = [
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
  { label: "1 year", days: 365 },
  { label: "No expiry", days: null },
];

const normalizeScopes = (value: string) => value.split(/[\s,]+/).filter(Boolean).join(",");

/** How a key's scopes read to a person. Raw scope strings stay in the tooltip. */
function describeScopes(scopes: string[]): { label: string; mono?: boolean }[] {
  if (scopes.includes("*")) return [{ label: "Full access" }];
  if (scopes.length === 1 && scopes[0] === "*:read") return [{ label: "Read only" }];
  if (scopes.length === 1 && scopes[0] === "*:write") return [{ label: "Write only" }];
  return scopes.map((s) => ({ label: s, mono: true }));
}

type ExpiryState = "none" | "ok" | "soon" | "expired";

function expiryState(expiresAt: string | null | undefined): ExpiryState {
  const d = toDate(expiresAt);
  if (!d) return "none";
  const left = d.getTime() - Date.now();
  if (left <= 0) return "expired";
  return left < 14 * DAY ? "soon" : "ok";
}

/**
 * API keys. A short list with the three things you check before trusting a
 * key (what it can do, when it stops working, when it was last used), a
 * create dialog that defaults to the safest choice, and a one-time reveal
 * of the secret.
 *
 * Scopes, resource restrictions and expiry are offered only where the server
 * honours them (`useServerFeature("scoped_keys")`). Elsewhere a key has full
 * access and never expires whatever the form says, so the form asks for a
 * name only, says so, and lists every key as "Full access". "Last used" is
 * shown only when the server records it.
 */
export function ApiKeysList() {
  const { api } = useApi();
  const scoped = useServerFeature("scoped_keys");
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const found = useLocalSearch(keys, (k) => [k.name, k.prefix, ...(k.scopes ?? [])]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);

  // Create dialog. `created` holds the secret for as long as the dialog is
  // open and is wiped once it has closed.
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("*:read");
  const [expiry, setExpiry] = useState(defaultExpiry);
  const [resourceIds, setResourceIds] = useState("");
  const [error, setError] = useState("");
  const [created, setCreated] = useState<{ key: string; name: string; scopes: string[]; expiresAt: string | null } | null>(null);
  const resetTimer = useRef<number | null>(null);

  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  // A server that records when a key was last used sends the field on every
  // row (null until first use); one that does not, never sends it.
  const lastUsedKept = keys.some((k) => "last_used_at" in k);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setKeys((await api<{ data: ApiKey[] }>("/v1/api_keys")).data);
    } catch (err) {
      setLoadError(err);
    }
    setLoading(false);
  };

  useEffect(() => {
    void load();
    return () => {
      if (resetTimer.current) window.clearTimeout(resetTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetForm = () => {
    setCreated(null);
    setName("");
    setError("");
    setScopes("*:read");
    setExpiry(defaultExpiry());
    setResourceIds("");
  };

  const openCreate = () => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetForm();
    setShowCreate(true);
  };

  // The secret leaves memory after the dialog's exit animation, so the
  // closing dialog does not flash back to an empty form.
  const closeDialog = () => {
    setShowCreate(false);
    if (resetTimer.current) window.clearTimeout(resetTimer.current);
    resetTimer.current = window.setTimeout(resetForm, 260);
  };

  // useAsyncAction guards re-entry: a fast double-click on the create
  // button used to fire two POSTs and produce two records.
  const create = useAsyncAction(async () => {
    setError("");
    try {
      const keyName = name.trim() || "Untitled key";
      if (!scoped) {
        // The server makes every key a full-access key that does not expire.
        const result = await api<{ key: string }>("/v1/api_keys", { method: "POST", body: JSON.stringify({ name: keyName }) });
        setCreated({ key: result.key, name: keyName, scopes: ["*"], expiresAt: null });
        void load();
        return;
      }
      const parsedScopes = scopes.split(/[\s,]+/).filter(Boolean);
      if (!parsedScopes.length) throw new Error("Choose at least one permission scope.");
      const expiresAt = expiry ? new Date(`${expiry}T23:59:59.999Z`).toISOString() : null;
      if (expiresAt && Date.parse(expiresAt) <= Date.now()) throw new Error("Choose a future expiration date.");
      let ids: Record<string, string[]> | undefined;
      if (resourceIds.trim()) {
        try {
          ids = JSON.parse(resourceIds);
        } catch {
          throw new Error("Resource restrictions must be a JSON object mapping resource names to ID lists.");
        }
        if (
          !ids ||
          typeof ids !== "object" ||
          Array.isArray(ids) ||
          Object.values(ids).some((value) => !Array.isArray(value) || !value.length || value.some((id) => typeof id !== "string"))
        ) {
          throw new Error("Each resource restriction needs a nonempty list of IDs.");
        }
      }
      const result = await api<{ key: string }>("/v1/api_keys", {
        method: "POST",
        body: JSON.stringify({ name: keyName, scopes: parsedScopes, expires_at: expiresAt, ...(ids ? { resource_ids: ids } : {}) }),
      });
      setCreated({ key: result.key, name: keyName, scopes: parsedScopes, expiresAt });
      void load();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "The key could not be created.");
    }
  });

  const columns = useMemo<ColumnDef<ApiKey>[]>(
    () => {
      const all: ColumnDef<ApiKey>[] = [
        {
          id: "name",
          accessorKey: "name",
          header: "Key",
          size: 280,
          enableHiding: false,
          enableSorting: true,
          cell: ({ row }) => {
            const k = row.original;
            return (
              // Every row here is a key: the name leads, with no icon to repeat.
              <ResourceIdentity
                name={k.name?.trim() || "Untitled key"}
                mono
                secondary={
                  <>
                    {k.prefix}
                    <span aria-hidden="true">••••••••</span>
                  </>
                }
                secondaryTitle={`Starts with ${k.prefix}. Only the first characters of a key are kept.`}
              />
            );
          },
        },
        {
          id: "access",
          header: "Access",
          size: 320,
          cell: ({ row }) => {
            const k = row.original;
            const raw = scoped ? (k.scopes ?? ["*"]) : ["*"];
            const parts = describeScopes(raw);
            const restricted = scoped ? Object.entries(k.resource_ids ?? {}) : [];
            return (
              <div className="flex min-w-0 items-center gap-1.5">
                <ChipRow label="Scopes" items={parts.map((p) => ({ key: p.label, label: p.label, mono: p.mono }))} />
                {restricted.length > 0 && (
                  <Tip label={`Restricted to ${restricted.map(([resource, ids]) => `${ids.length} ${resource}`).join(", ")}`}>
                    <span
                      role="img"
                      aria-label="Restricted to specific resources"
                      className="inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border border-border-strong text-fg-muted"
                    >
                      <LockIcon className="size-3" />
                    </span>
                  </Tip>
                )}
              </div>
            );
          },
        },
        {
          id: "expires",
          // A key that never expires sorts after every dated one.
          accessorFn: (k) => toDate(k.expires_at)?.getTime(),
          header: "Expires",
          size: 170,
          enableSorting: true,
          cell: ({ row }) => {
            const k = row.original;
            const state = scoped ? expiryState(k.expires_at) : "none";
            if (state === "none") return <span className="text-fg-subtle">Never</span>;
            if (state === "expired") return <StatusBadge status="expired" />;
            if (state === "soon") {
              return (
                <Tip label={formatAbsolute(k.expires_at)}>
                  <span className="inline-flex">
                    <StatusBadge status="warning" label={`Expires ${formatRelativeTime(k.expires_at)}`} />
                  </span>
                </Tip>
              );
            }
            return (
              <Tip label={formatAbsolute(k.expires_at)}>
                <span className="text-fg-muted">{formatDate(k.expires_at)}</span>
              </Tip>
            );
          },
        },
        {
          id: "last_used",
          accessorFn: (k) => toDate(k.last_used_at)?.getTime(),
          header: "Last used",
          size: 130,
          enableSorting: true,
          sortDescFirst: true,
          cell: ({ row }) => <RelativeTime value={row.original.last_used_at} className="text-fg-muted" fallback="Never" />,
        },
        {
          id: "created",
          accessorFn: (k) => toDate(k.created_at)?.getTime(),
          header: "Created",
          size: 124,
          enableSorting: true,
          sortDescFirst: true,
          meta: { hideBelow: 760 },
          cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" />,
        },
        {
          id: "actions",
          header: "",
          size: 56,
          enableHiding: false,
          cell: ({ row }) => (
            <RowActionsMenu
              label={`Actions for ${row.original.name}`}
              actions={[
                { label: "Copy key id", icon: <CopyIcon />, onSelect: () => void copyText(row.original.id) },
                { label: "Revoke", icon: <BanIcon />, destructive: true, onSelect: () => setRevoking(row.original) },
              ]}
            />
          ),
        },
      ];
      return all.filter((c) => c.id !== "last_used" || lastUsedKept);
    },
    [scoped, lastUsedKept],
  );

  const activePreset = SCOPE_PRESETS.find((p) => normalizeScopes(p.value) === normalizeScopes(scopes));
  const expiryPreset = EXPIRY_PRESETS.find((p) => (p.days === null ? expiry === "" : expiry === isoDay(p.days)));

  const dialogs = (
    <>
      <Modal
        open={showCreate}
        onClose={closeDialog}
        title={created ? "Save your new key" : "New API key"}
        subtitle={
          created
            ? "This is the only time the full key is shown."
            : scoped
              ? "Give the key the least access that does the job."
              : "A key can do everything in this workspace until it is revoked."
        }
        footer={
          created ? (
            <Button onClick={closeDialog}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={create.loading}>
                Cancel
              </Button>
              <Button onClick={create.run} loading={create.loading}>
                Create key
              </Button>
            </>
          )
        }
      >
        {created ? (
          <div className="space-y-5">
            <SecretOnce label={created.name} value={created.key} />
            <Callout tone="warning" title="Copy it before you close this dialog">
              Only the first characters are kept after this. If the key is lost, revoke it and create another.
            </Callout>
            <PropertyList>
              <Property label="Access">
                <span className="flex flex-wrap gap-1.5">
                  {describeScopes(created.scopes).map((p) => (
                    <Chip key={p.label} mono={p.mono}>
                      {p.label}
                    </Chip>
                  ))}
                </span>
              </Property>
              <Property label="Expires">{created.expiresAt ? formatDate(created.expiresAt) : "Never"}</Property>
            </PropertyList>
            <div>
              <p className="mb-1.5 text-xs font-medium text-fg-subtle">Send it as the x-api-key header</p>
              <CommandLine wrap command={`curl ${window.location.origin}/v1/agents -H "x-api-key: $OMA_API_KEY"`} />
            </div>
          </div>
        ) : (
          <div className="space-y-5">
            {error && (
              <Callout tone="danger" title="The key was not created">
                {error}
              </Callout>
            )}
            <Field label="Name (optional)" hint="Name it after where it will live, so it is easy to revoke later.">
              <TextInput
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="CI pipeline, local CLI, Zapier"
                autoFocus
              />
            </Field>

            {!scoped ? (
              <Callout tone="neutral" title="Full access, no expiry">
                This server does not limit what a key can do or how long it works. Keep the key somewhere safe, and revoke it as soon
                as it is no longer needed.
              </Callout>
            ) : (
              <>
                <div>
                  <Field label="Permission scopes">
                    <TextInput value={scopes} onChange={(e) => setScopes(e.target.value)} className="font-mono" spellCheck={false} />
                  </Field>
                  <PresetRow label="Scope presets">
                    {SCOPE_PRESETS.map((p) => (
                      <PresetButton key={p.label} active={activePreset?.label === p.label} onClick={() => setScopes(p.value)}>
                        {p.label}
                      </PresetButton>
                    ))}
                  </PresetRow>
                  <p className="mt-2 text-xs text-fg-subtle">
                    {activePreset
                      ? activePreset.hint
                      : "Comma-separated, as resource:read or resource:write. For example agents:read, sessions:write."}
                  </p>
                </div>

                <div>
                  <Field label="Expiration date">
                    <DateField
                      value={expiry}
                      onChange={setExpiry}
                      min={isoDay(0)}
                      // The key ends at the end of a UTC day, so "today" is the UTC one.
                      today={isoDay(0)}
                      placeholder="No expiry"
                      className="max-w-[13rem]"
                    />
                  </Field>
                  <PresetRow label="Expiry presets">
                    {EXPIRY_PRESETS.map((p) => (
                      <PresetButton
                        key={p.label}
                        active={expiryPreset?.label === p.label}
                        onClick={() => setExpiry(p.days === null ? "" : isoDay(p.days))}
                      >
                        {p.label}
                      </PresetButton>
                    ))}
                  </PresetRow>
                  <p className="mt-2 text-xs text-fg-subtle">
                    {expiry ? "The key stops working at the end of this day, UTC." : "The key works until someone revokes it."}
                  </p>
                </div>

                <Disclosure title="Restrict to specific resources" meta={resourceIds.trim() ? "On" : "Optional"}>
                  <Field
                    label="Resource IDs as JSON"
                    hint="A restricted key cannot list a restricted collection or read workspace-wide reports."
                  >
                    <Textarea
                      rows={3}
                      value={resourceIds}
                      onChange={(e) => setResourceIds(e.target.value)}
                      className="font-mono text-xs md:text-xs"
                      placeholder={'{"sessions": ["sess_123"]}'}
                      spellCheck={false}
                    />
                  </Field>
                </Disclosure>
              </>
            )}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={!!revoking}
        onClose={() => setRevoking(null)}
        destructive
        title={`Revoke ${revoking?.name?.trim() || "this key"}?`}
        body="Anything still using this key stops working straight away. This cannot be undone."
        confirmLabel="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          await api(`/v1/api_keys/${revoking.id}`, { method: "DELETE" });
          await load();
        }}
      />
    </>
  );

  // A failed read replaces the table: never an empty state for an error.
  if (loadError != null && keys.length === 0) {
    return (
      <Page
        width="wide"
        header={
          <PageHeader
            title="API keys"
            subtitle={SUBTITLE}
            width="wide"
            actions={
              <Button onClick={openCreate} aria-label="+ New API key">
                <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
                New API key
              </Button>
            }
          />
        }
      >
        <ErrorState title="API keys could not be loaded" error={loadError} retry={load} />
        {dialogs}
      </Page>
    );
  }

  return (
    <DataTable<ApiKey>
      title="API keys"
      subtitle={SUBTITLE}
      createLabel="+ New API key"
      onCreate={openCreate}
      // Search first, as on every other list (the endpoint has no text search: lib/useLocalSearch.ts).
      searchPlaceholder="Search keys"
      searchValue={found.search}
      onSearchChange={found.setSearch}
      summary={loading ? undefined : found.searching ? `${found.rows.length.toLocaleString()} of ${plural(keys.length, "key")}` : plural(keys.length, "key")}
      data={found.rows}
      loading={loading}
      getRowId={(k) => k.id}
      emptyTitle={found.searching ? `No keys match “${found.query}”` : "No API keys yet"}
      emptyKind="api_key"
      emptySubtitle={
        found.searching
          ? "Keys are searched by name, prefix and scope."
          : scoped
            ? "Create a key to reach this workspace from the CLI, the SDK or your own services. New keys are read-only and expire in 90 days unless you choose otherwise."
            : "Create a key to reach this workspace from the CLI, the SDK or your own services. A key has full access until it is revoked."
      }
      filtered={found.searching}
      emptyAction={
        found.searching ? (
          <Button variant="outline" onClick={() => found.setSearch("")}>
            Clear search
          </Button>
        ) : (
          <Button onClick={openCreate}>New API key</Button>
        )
      }
      columns={columns}
    >
      {dialogs}
    </DataTable>
  );
}

function PresetRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="mt-2 flex flex-wrap gap-1.5">
      {children}
    </div>
  );
}

/** A quick-fill chip under a field. Pressed state shows which preset is in effect. */
function PresetButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center rounded-full border px-2.5 text-xs font-medium transition-quick",
        active
          ? "border-transparent bg-bg-pressed text-fg"
          : "border-border-strong text-fg-muted hover:border-fg-faint hover:bg-bg-hover hover:text-fg",
      )}
    >
      {children}
    </button>
  );
}
