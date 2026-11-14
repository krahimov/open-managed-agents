import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRightIcon, BoxIcon, KeyRoundIcon } from "lucide-react";

import { VaultIcon } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";

import { useApi } from "../../lib/api";
import { AgentAvatar, EntityAvatar } from "../../components/AgentAvatar";
import { Chip } from "../../components/Badge";
import { Disclosure } from "../../components/Disclosure";
import { CodeWell } from "../../components/EventCard";
import { CopyButton, IdChip } from "../../components/IdChip";
import { ModelBadge } from "../../components/ModelBadge";
import { Property, PropertyList } from "../../components/PropertyList";
import { QueryProblem } from "../../components/QueryProblem";
import { RelativeTime } from "../../components/RelativeTime";
import { Skeleton, SkeletonText } from "../../components/Skeleton";
import type { PeekTarget } from "../../components/sessions/ContextPanel";

/**
 * Peek at a resource a session uses (its agent, environment or a vault)
 * without leaving the session. The context panel names each resource and
 * links to its page; this sheet is the quick look in between: the facts
 * that matter, the full configuration on request, and a way through to the
 * record.
 */

const NOUN: Record<PeekTarget["kind"], string> = { agent: "Agent", environment: "Environment", vault: "Vault" };
const ROUTE: Record<PeekTarget["kind"], string> = { agent: "/agents", environment: "/environments", vault: "/vaults" };
const ENDPOINT: Record<PeekTarget["kind"], string> = { agent: "/v1/agents", environment: "/v1/environments", vault: "/v1/vaults" };

type Json = Record<string, unknown>;
const rec = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

export function ResourceSheet({ target, onClose }: { target: PeekTarget | null; onClose: () => void }) {
  const { api } = useApi();
  const [data, setData] = useState<Json | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Keep the last target while the sheet animates out.
  const [shown, setShown] = useState<PeekTarget | null>(target);
  useEffect(() => {
    if (target) setShown(target);
  }, [target]);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    setData(null);
    setError(null);
    api<Json>(`${ENDPOINT[target.kind]}/${target.id}`, { silentErrors: true })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      cancelled = true;
    };
  }, [api, target?.kind, target?.id, attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  // A vault is its credentials: list them by name (never their secrets).
  // A list that could not be read is said to be unavailable, with its own
  // retry; "holds no credentials yet" is only ever said of a list that
  // was read and is empty.
  const [credentials, setCredentials] = useState<VaultCredential[] | null>(null);
  const [credentialsError, setCredentialsError] = useState<Error | null>(null);
  const [credentialsAttempt, setCredentialsAttempt] = useState(0);
  useEffect(() => {
    setCredentials(null);
    setCredentialsError(null);
    if (!target || target.kind !== "vault") return;
    let cancelled = false;
    api<{ data: VaultCredential[] }>(`/v1/vaults/${target.id}/credentials`, { silentErrors: true })
      .then((d) => !cancelled && setCredentials((d.data ?? []).filter((c) => !c.archived_at)))
      .catch((e) => !cancelled && setCredentialsError(e instanceof Error ? e : new Error(String(e))));
    return () => {
      cancelled = true;
    };
  }, [api, target?.kind, target?.id, attempt, credentialsAttempt]); // eslint-disable-line react-hooks/exhaustive-deps

  const kind = shown?.kind ?? "agent";
  const name = str(data?.name) ?? str(data?.display_name);
  const description = str(data?.description);
  const json = data ? JSON.stringify(data, null, 2) : "";

  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 sm:max-w-[440px]">
        <SheetHeader className="gap-3 pb-4">
          <div className="flex items-center gap-3">
            {kind === "agent" ? (
              <AgentAvatar name={name} id={shown?.id} size="lg" />
            ) : (
              <EntityAvatar icon={kind === "environment" ? BoxIcon : VaultIcon} size="lg" />
            )}
            <div className="min-w-0">
              <p className="text-xs font-medium text-fg-subtle">{NOUN[kind]}</p>
              <SheetTitle className="truncate">{name ?? (error ? `${NOUN[kind]} unavailable` : <Skeleton className="mt-1 h-5 w-44" rounded="sm" />)}</SheetTitle>
            </div>
          </div>
          <SheetDescription className={description ? "line-clamp-3" : "sr-only"}>
            {description ?? `Details of this ${NOUN[kind].toLowerCase()}.`}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
          {error ? (
            <QueryProblem compact title={`This ${NOUN[kind].toLowerCase()} could not be loaded`} error={error} retry={() => setAttempt((n) => n + 1)} />
          ) : !data ? (
            <div className="space-y-4" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="flex gap-6">
                  <Skeleton className="h-3.5 w-20" rounded="sm" />
                  <Skeleton className="h-3.5 flex-1" rounded="sm" style={{ maxWidth: `${60 - i * 8}%` }} />
                </div>
              ))}
              <SkeletonText lines={4} className="pt-3" />
            </div>
          ) : (
            <>
              <PropertyList>
                <Facts kind={kind} data={data} />
                {(str(data.updated_at) || str(data.created_at)) && (
                  <Property label={str(data.updated_at) ? "Updated" : "Created"}>
                    <RelativeTime value={str(data.updated_at) ?? str(data.created_at)} />
                  </Property>
                )}
                <Property label={`${NOUN[kind]} id`}>
                  <IdChip id={String(data.id ?? shown?.id ?? "")} full />
                </Property>
              </PropertyList>
              {kind === "agent" && str(data.system) && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-fg-subtle">Instructions</p>
                  <p className="line-clamp-[9] text-small leading-relaxed whitespace-pre-line text-fg-muted">{str(data.system)}</p>
                </div>
              )}
              {kind === "vault" && (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-fg-subtle">
                    {credentials && credentials.length > 0 ? `Credentials · ${credentials.length}` : "Credentials"}
                  </p>
                  {credentialsError ? (
                    <QueryProblem
                      compact
                      title="Credentials could not be loaded"
                      error={credentialsError}
                      retry={() => setCredentialsAttempt((n) => n + 1)}
                    />
                  ) : credentials === null ? (
                    <div className="space-y-2.5" aria-hidden="true">
                      {[0, 1, 2].map((i) => (
                        <div key={i} className="flex items-center gap-2.5">
                          <Skeleton className="size-6" rounded="md" />
                          <Skeleton className="h-3.5" rounded="sm" style={{ width: `${58 - i * 10}%` }} />
                        </div>
                      ))}
                    </div>
                  ) : credentials.length === 0 ? (
                    <p className="text-small text-fg-subtle">This vault holds no credentials yet.</p>
                  ) : (
                    <ul className="space-y-0.5">
                      {credentials.map((c) => (
                        <li key={c.id} className="flex min-h-10 items-center gap-2.5 py-1">
                          <EntityAvatar icon={KeyRoundIcon} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-small font-medium text-fg" title={c.display_name}>
                              {c.display_name || "Unnamed credential"}
                            </span>
                            {hostOf(c.auth?.mcp_server_url) && (
                              <span className="block truncate text-xs text-fg-subtle">{hostOf(c.auth?.mcp_server_url)}</span>
                            )}
                          </span>
                          <Chip>{CREDENTIAL_KIND[c.auth?.type ?? ""] ?? "Credential"}</Chip>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <Disclosure title="Full configuration" meta="JSON" variant="bare" className="-mx-3.5">
                <div className="relative">
                  <CodeWell className="max-h-[22rem] pr-10">{json}</CodeWell>
                  <CopyButton value={json} label="Copy JSON" className="absolute top-1.5 right-1.5" />
                </div>
              </Disclosure>
            </>
          )}
        </div>

        {shown && (
          <div className="flex justify-end gap-2 border-t border-border px-6 py-4">
            <Button variant="outline" asChild>
              <Link to={`${ROUTE[kind]}/${shown.id}`}>
                Open {NOUN[kind].toLowerCase()}
                <ArrowUpRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

interface VaultCredential {
  id: string;
  display_name?: string;
  archived_at?: string | null;
  auth?: { type?: string; mcp_server_url?: string };
}

/** How a credential authenticates, in words. */
const CREDENTIAL_KIND: Record<string, string> = {
  mcp_oauth: "Sign-in",
  static_bearer: "API key",
  composio_account: "Connected app",
  cap_cli: "CLI login",
};

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function ChipList({ items, empty }: { items: string[]; empty: string }): ReactNode {
  if (items.length === 0) return <span className="text-fg-subtle">{empty}</span>;
  return (
    <span className="flex flex-wrap gap-1.5">
      {items.map((s) => (
        <Chip key={s}>{s}</Chip>
      ))}
    </span>
  );
}

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());

/** The handful of facts worth a glance, per kind. Everything else is in the JSON. */
function Facts({ kind, data }: { kind: PeekTarget["kind"]; data: Json }) {
  if (kind === "agent") {
    const servers = (Array.isArray(data.mcp_servers) ? data.mcp_servers : [])
      .map((s) => str(rec(s)?.name))
      .filter((s): s is string => !!s)
      .map(titleCase);
    const skills = Array.isArray(data.skills) ? data.skills.length : 0;
    const memory = str(rec(data.memory)?.mode);
    return (
      <>
        <Property label="Model">
          <ModelBadge model={data.model as string | { id: string }} variant="plain" />
        </Property>
        {data.version != null && <Property label="Version">v{String(data.version)}</Property>}
        {str(data.reasoning_level) && <Property label="Reasoning">{titleCase(str(data.reasoning_level)!)}</Property>}
        <Property label="Apps" align="start">
          {ChipList({ items: servers, empty: "None connected" })}
        </Property>
        <Property label="Skills">{skills > 0 ? `${skills} attached` : <span className="text-fg-subtle">None</span>}</Property>
        {memory && <Property label="Memory">{titleCase(memory)}</Property>}
      </>
    );
  }
  if (kind === "environment") {
    const config = rec(data.config) ?? {};
    const sandbox = rec(config.sandbox);
    const networking = rec(config.networking);
    const packages = rec(config.packages) ?? {};
    const pkgCount = Object.values(packages).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
    return (
      <>
        <Property label="Type">{titleCase(str(config.type) ?? "cloud")}</Property>
        {str(sandbox?.provider) && <Property label="Provider">{titleCase(str(sandbox?.provider)!)}</Property>}
        {str(sandbox?.image) && (
          <Property label="Image">
            <span className="font-mono text-xs break-all">{str(sandbox?.image)}</span>
          </Property>
        )}
        {str(networking?.type) && <Property label="Network">{titleCase(str(networking?.type)!)}</Property>}
        <Property label="Packages">{pkgCount > 0 ? `${pkgCount} preinstalled` : <span className="text-fg-subtle">None</span>}</Property>
      </>
    );
  }
  const count = typeof data.credential_count === "number" ? data.credential_count : undefined;
  return <>{count != null && <Property label="Credentials">{count.toLocaleString()}</Property>}</>;
}
