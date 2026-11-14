import { useCrumbLabel } from "@/components/AppBreadcrumb";
import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { ArrowLeftIcon, CopyIcon, PencilIcon, PlusIcon, UnplugIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import { Chip } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DetailHeader } from "../../components/DetailHeader";
import { EmptyState } from "../../components/EmptyState";
import { EntityRef } from "../../components/EntityRef";
import { Field } from "../../components/Field";
import { TextInput } from "../../components/Input";
import { Modal } from "../../components/Modal";
import { Page } from "../../components/Page";
import { ErrorState } from "../../components/QueryProblem";
import { RelativeTime } from "../../components/RelativeTime";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { SkeletonDetail } from "../../components/Skeleton";
import { copyText } from "../../lib/clipboard";
import { formatDate, plural } from "../../lib/format";
import { PersonaAvatar, type InstallationLike, type PublicationLike } from "./IntegrationList";
import { PROVIDERS, ProviderMark, type ProviderId } from "./providers";
import { toMillis } from "./relativeTime";
import { StatusPill, type PublicationStatus } from "./StatusPill";
import { failureSentence, withReason } from "../../lib/failure-text";

/** A named set of capability ids, as each provider groups them. */
export interface CapabilityGroup {
  label: string;
  caps: string[];
}

export interface WorkspacePublication extends PublicationLike {
  environment_id: string;
  capabilities: string[];
}

// ── Capabilities ────────────────────────────────────────────────────────

/** One chip per group: how much of it is switched on ("Messages 3 of 4"). */
export function CapabilitySummary({ groups, enabled }: { groups: CapabilityGroup[]; enabled: string[] }) {
  const on = new Set(enabled);
  return (
    <div className="flex flex-wrap gap-1.5">
      {groups.map((g) => {
        const n = g.caps.filter((c) => on.has(c)).length;
        const title = g.caps.map((c) => `${on.has(c) ? "✓" : "–"} ${c}`).join("\n");
        if (n === 0) {
          return (
            <Chip key={g.label} tone="outline" title={title} className="text-fg-subtle">
              {g.label} off
            </Chip>
          );
        }
        return (
          <Chip key={g.label} title={title}>
            {g.label}
            {n < g.caps.length ? ` ${n} of ${g.caps.length}` : ""}
          </Chip>
        );
      })}
    </div>
  );
}

/** Grouped checkboxes for what a published agent may do on the other product. */
export function CapabilityPicker({
  groups,
  value,
  onChange,
  disabled,
}: {
  groups: CapabilityGroup[];
  value: Set<string>;
  onChange: (next: Set<string>) => void;
  disabled?: boolean;
}) {
  const all = groups.flatMap((g) => g.caps);
  const enabled = all.filter((c) => value.has(c)).length;
  const setMany = (caps: string[], on: boolean) => {
    const next = new Set(value);
    for (const c of caps) (on ? next.add(c) : next.delete(c));
    onChange(next);
  };
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-fg-subtle">
          {enabled} of {all.length} enabled
        </p>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="xs" disabled={disabled || enabled === all.length} onClick={() => setMany(all, true)}>
            Enable all
          </Button>
          <Button type="button" variant="ghost" size="xs" disabled={disabled || enabled === 0} onClick={() => setMany(all, false)}>
            Clear
          </Button>
        </div>
      </div>
      <div className="mt-2 grid gap-x-6 gap-y-5 rounded-lg border border-border bg-bg-inset p-4 sm:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g.label} disabled={disabled} className="min-w-0">
            <legend className="mb-1.5 text-xs font-medium text-fg-subtle">{g.label}</legend>
            <div className="space-y-0.5">
              {g.caps.map((cap) => (
                <label
                  key={cap}
                  className="-mx-1.5 flex min-h-8 cursor-pointer items-center gap-2.5 rounded-md px-1.5 transition-quick hover:bg-bg-hover has-disabled:cursor-not-allowed"
                >
                  <Checkbox checked={value.has(cap)} onCheckedChange={(c) => setMany([cap], c === true)} />
                  <code className="truncate font-mono text-xs text-fg">{cap}</code>
                </label>
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </div>
  );
}

// ── One published agent ─────────────────────────────────────────────────

/**
 * An agent published into a workspace: who it is over there, which agent
 * and environment are behind it, its state, and what it may do. `children`
 * adds provider-specific sections (Linear's autopilot rules).
 */
export function PublicationCard({
  provider,
  pub,
  groups,
  onEdit,
  onUnpublish,
  unpublishLabel = "Unpublish",
  editLabel = "Edit",
  children,
  style,
  className,
}: {
  provider: ProviderId;
  pub: WorkspacePublication;
  groups: CapabilityGroup[];
  onEdit: () => void;
  onUnpublish: () => void;
  unpublishLabel?: string;
  editLabel?: string;
  children?: ReactNode;
  style?: React.CSSProperties;
  className?: string;
}) {
  const name = pub.persona.name || "Unnamed persona";
  return (
    <article style={style} className={cn("surface overflow-hidden rounded-xl", className)}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-3 p-5">
        <PersonaAvatar persona={pub.persona} agentId={pub.agent_id} size="lg" />
        {/* The basis makes the actions wrap under the identity before the identity is squeezed. */}
        <div className="min-w-0 flex-1 basis-64">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h3 className="truncate text-h3 text-fg" title={name}>
              {name}
            </h3>
            <StatusPill status={pub.status} size="md" />
          </div>
          {/* Two steady lines on every card: who and since when, then where
              it runs. Three facts left to wrap by themselves broke differently
              on each card, so a stack of cards had no rhythm. */}
          <dl className="mt-1.5 space-y-1 text-small">
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
              <div className="flex min-w-0 items-center gap-1.5">
                <dt className="shrink-0 text-fg-subtle">Agent</dt>
                <dd className="min-w-0">
                  <EntityRef kind="agent" id={pub.agent_id} />
                </dd>
              </div>
              <div className="flex items-center gap-1.5">
                <dt className="shrink-0 text-fg-subtle">Published</dt>
                <dd className="text-fg-muted">
                  <RelativeTime value={toMillis(pub.created_at)} fallback="at an unknown time" />
                </dd>
              </div>
            </div>
            <div className="flex min-w-0 items-center gap-1.5">
              <dt className="shrink-0 text-fg-subtle">Runs in</dt>
              <dd className="min-w-0">
                <EntityRef kind="environment" id={pub.environment_id} avatar={false} />
              </dd>
            </div>
          </dl>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button variant="outline" size="sm" onClick={onEdit} aria-label={`${editLabel} ${name}`}>
            <PencilIcon data-icon="inline-start" />
            {editLabel}
          </Button>
          <RowActionsMenu
            label={`More actions for ${name}`}
            actions={[
              { label: "Copy publication id", icon: <CopyIcon />, onSelect: () => void copyText(pub.id) },
              { label: unpublishLabel, icon: <UnplugIcon />, destructive: true, onSelect: onUnpublish },
            ]}
          />
        </div>
      </div>
      <div className="border-t border-border px-5 py-3.5">
        <p className="mb-2 text-xs font-medium text-fg-subtle">
          May use {pub.capabilities.length} of {groups.reduce((n, g) => n + g.caps.length, 0)} {PROVIDERS[provider].name} capabilities
        </p>
        <CapabilitySummary groups={groups} enabled={pub.capabilities} />
      </div>
      {children}
    </article>
  );
}

/** Edit the persona (where the provider allows it) and the capabilities. */
export function EditPublicationDialog({
  provider,
  pub,
  groups,
  editPersona = true,
  onClose,
  onSave,
}: {
  provider: ProviderId;
  /** The publication being edited; null closes the dialog. */
  pub: WorkspacePublication | null;
  groups: CapabilityGroup[];
  /** GitHub fixes the bot's name at registration; only capabilities change. */
  editPersona?: boolean;
  onClose: () => void;
  /** Persist and resolve; throw to keep the dialog open with the message shown. */
  onSave: (patch: { persona?: { name: string; avatarUrl: string | null }; capabilities: string[] }) => Promise<void>;
}) {
  const meta = PROVIDERS[provider];
  const [shown, setShown] = useState<WorkspacePublication | null>(pub);
  const [personaName, setPersonaName] = useState("");
  const [personaAvatar, setPersonaAvatar] = useState("");
  const [caps, setCaps] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the last publication on screen while the dialog animates out.
  useEffect(() => {
    if (!pub) return;
    setShown(pub);
    setPersonaName(pub.persona.name);
    setPersonaAvatar(pub.persona.avatarUrl ?? "");
    setCaps(new Set(pub.capabilities));
    setError(null);
  }, [pub]);

  async function save() {
    if (editPersona && !personaName.trim()) {
      setError("Give the persona a name.");
      return;
    }
    setError(null);
    setWorking(true);
    try {
      await onSave({
        ...(editPersona ? { persona: { name: personaName.trim(), avatarUrl: personaAvatar.trim() || null } } : {}),
        capabilities: [...caps],
      });
      toast.success(`${personaName.trim() || shown?.persona.name || "Agent"} updated`);
      onClose();
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open={!!pub}
      onClose={() => !working && onClose()}
      title={`Edit ${shown?.persona.name || "agent"}`}
      subtitle={
        editPersona
          ? `How this agent appears in ${meta.name} and what it may do there.`
          : `What this agent may do on ${meta.name}. Its bot name was fixed when the app was registered.`
      }
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => void save()} loading={working}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && (
          <Callout tone="danger" title="The changes were not saved">
            {error}
          </Callout>
        )}
        {editPersona && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Persona name" hint={`The name people see in ${meta.name}.`}>
              <TextInput value={personaName} onChange={(e) => setPersonaName(e.target.value)} disabled={working} />
            </Field>
            <Field label="Avatar URL" hint="Optional. A square image works best.">
              <TextInput
                value={personaAvatar}
                onChange={(e) => setPersonaAvatar(e.target.value)}
                placeholder="https://"
                disabled={working}
              />
            </Field>
          </div>
        )}
        <div>
          <p className="text-small-size font-medium text-fg">Capabilities</p>
          <p className="mt-0.5 mb-3 text-xs text-fg-subtle">
            Everything is allowed by default. Untick what this agent should not do.
          </p>
          <CapabilityPicker groups={groups} value={caps} onChange={setCaps} disabled={working} />
        </div>
      </div>
    </Modal>
  );
}

// ── The workspace (installation) page ───────────────────────────────────

/** The most urgent state among a workspace's publications, for the header. */
export function overallStatus(pubs: Array<{ status: PublicationStatus }>): PublicationStatus | null {
  const order: PublicationStatus[] = ["needs_reauth", "awaiting_install", "credentials_filled", "pending_setup", "live", "unpublished"];
  for (const s of order) if (pubs.some((p) => p.status === s)) return s;
  return null;
}

/** How a state reads after a count: "1 of 2 waiting for install", "2 of 3 need reconnecting". */
const AFTER_COUNT: Partial<Record<PublicationStatus, (n: number) => string>> = {
  needs_reauth: (n) => (n === 1 ? "needs reconnecting" : "need reconnecting"),
  awaiting_install: () => "waiting for install",
  credentials_filled: () => "ready to install",
  pending_setup: () => "not set up yet",
};

/**
 * The header's status, in words that are true of the whole workspace. The
 * pill takes the most urgent state's colour; when only some of the agents
 * are in that state it says how many ("1 of 2 waiting for install"), so a
 * workspace with a live agent is not labelled as if nothing were installed.
 * Agents that were unpublished are not counted on either side. Undefined
 * means the vocabulary's own label is right as it is.
 */
export function overallStatusLabel(pubs: Array<{ status: PublicationStatus }>): string | undefined {
  const status = overallStatus(pubs);
  const phrase = status ? AFTER_COUNT[status] : undefined;
  if (!status || !phrase) return undefined;
  const current = pubs.filter((p) => p.status !== "unpublished");
  const n = current.filter((p) => p.status === status).length;
  return n < current.length ? `${n} of ${current.length} ${phrase(n)}` : undefined;
}

/**
 * Frame for a connected workspace's page: loading, error and not-found
 * states, the record header, and the two-column body. Each provider fills
 * `children` (main column) and `aside`.
 */
export function InstallationPage<I extends InstallationLike>({
  provider,
  loading,
  error,
  onRetry,
  installation,
  publications,
  description,
  meta: extraMeta,
  publishHref,
  aside,
  children,
}: {
  provider: ProviderId;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  installation: I | undefined;
  publications: PublicationLike[];
  /** One line under the name: what being published here means. */
  description: string;
  /** Extra chips for the header's meta row. */
  meta?: ReactNode;
  /** Where the header's primary action goes. Defaults to the provider's wizard. */
  publishHref?: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  const meta = PROVIDERS[provider];
  const status = overallStatus(publications);
  // The trail names the workspace, not the word "Workspace".
  useCrumbLabel(installation?.workspace_name);

  if (error && !installation) {
    return (
      <Page width="default">
        <div className="pt-4">
          <ErrorState title={`This ${meta.name} ${meta.workspaceNoun} could not be loaded`} error={new Error(error)} retry={onRetry} />
        </div>
      </Page>
    );
  }
  if (loading && !installation) {
    return (
      <Page width="default">
        <SkeletonDetail />
      </Page>
    );
  }
  if (!installation) {
    return (
      <Page width="default">
        <div className="pt-4">
          <EmptyState
            size="lg"
            heading="h1"
            icon={<meta.icon />}
            title={`This ${meta.name} connection does not exist`}
            body={`It may have been disconnected, or the link is from another workspace. Connected ${meta.workspaceNoun}s are listed on the ${meta.name} page.`}
            action={
              <Button asChild>
                <Link to={meta.listPath}>
                  <ArrowLeftIcon data-icon="inline-start" />
                  Back to {meta.name}
                </Link>
              </Button>
            }
          />
        </div>
      </Page>
    );
  }

  const connected = toMillis(installation.created_at);
  return (
    <Page width="default">
      <DetailHeader
        avatar={<ProviderMark provider={provider} size="xl" />}
        title={installation.workspace_name || `Unnamed ${meta.workspaceNoun}`}
        status={status ? <StatusPill status={status} label={overallStatusLabel(publications)} size="md" /> : undefined}
        description={description}
        meta={
          <>
            <Chip>{publications.length === 0 ? "No agents yet" : plural(publications.length, "agent")}</Chip>
            {connected && <Chip title="When this connection was made">Connected {formatDate(connected)}</Chip>}
            {extraMeta}
          </>
        }
        actions={
          <Button asChild>
            <Link to={publishHref ?? meta.publishPath}>
              <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
              {publications.length === 0 ? meta.publishLabel : `${meta.publishLabel.split(" ")[0]} another`}
            </Link>
          </Button>
        }
      />
      {error && <ErrorState compact title="The latest state could not be loaded" error={new Error(error)} retry={onRetry} className="mb-4" />}
      {/* Two columns from 1280: below that the sidebar leaves the main column too narrow. */}
      <div className="animate-rise-in grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">{children}</div>
        {aside && <aside className="min-w-0 space-y-4">{aside}</aside>}
      </div>
    </Page>
  );
}

/** Empty main column: the workspace is connected but nothing is published in it. */
export function NoPublications({ provider }: { provider: ProviderId }) {
  const meta = PROVIDERS[provider];
  return (
    <EmptyState
      size="md"
      kind="agent"
      title="No agents published here yet"
      body={`The ${meta.workspaceNoun} is connected. Publish an agent to make it a teammate in ${meta.name}.`}
      action={
        <Button variant="outline" asChild>
          <Link to={meta.publishPath}>{meta.publishLabel}</Link>
        </Button>
      }
    />
  );
}

/** Confirmation shared by the three workspace pages. */
export function UnpublishDialog({
  provider,
  pub,
  verb = "Unpublish",
  onClose,
  onConfirm,
}: {
  provider: ProviderId;
  pub: PublicationLike | null;
  verb?: "Unpublish" | "Unbind";
  onClose: () => void;
  onConfirm: (pub: PublicationLike) => Promise<void>;
}) {
  const meta = PROVIDERS[provider];
  return (
    <ConfirmDialog
      open={!!pub}
      onClose={onClose}
      destructive
      title={`${verb} ${pub?.persona.name || "this agent"}?`}
      body={`It stops responding in ${meta.name} straight away. The agent itself, and its sessions, are not affected.`}
      confirmLabel={`${verb} agent`}
      onConfirm={async () => {
        if (!pub) return;
        try {
          await onConfirm(pub);
        } catch (err) {
          toast.error(withReason(`The agent could not be ${verb === "Unbind" ? "unbound" : "unpublished"}`, err));
          throw err;
        }
      }}
    />
  );
}
