import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { ArrowRightIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import { AgentAvatar } from "../../components/AgentAvatar";
import { Avatar } from "../../components/Avatar";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EmptyState } from "../../components/EmptyState";
import { EntityRef } from "../../components/EntityRef";
import { Page } from "../../components/Page";
import { PageHeader } from "../../components/PageHeader";
import { ErrorState } from "../../components/QueryProblem";
import { RelativeTime } from "../../components/RelativeTime";
import { Section } from "../../components/SectionCard";
import { Skeleton } from "../../components/Skeleton";
import { useAgents } from "../../lib/directory";
import { plural } from "../../lib/format";
import { InstallResult } from "./InstallResult";
import { PROVIDERS, ProviderMark, type ProviderId } from "./providers";
import { toMillis } from "./relativeTime";
import { StatusPill, type PublicationStatus } from "./StatusPill";
import { withReason } from "../../lib/failure-text";

/** What the list pages need from a publication, whichever provider it is. */
export interface PublicationLike {
  id: string;
  agent_id: string;
  status: PublicationStatus;
  persona: { name: string; avatarUrl: string | null };
  created_at: number;
}

export interface InstallationLike {
  id: string;
  workspace_name: string;
  created_at: number;
}

/**
 * How an agent looks on the other product: its persona image when it has
 * one, otherwise the agent's own tinted squircle (same tint as everywhere
 * else in the console, so the agent is recognisable across pages).
 */
export function PersonaAvatar({
  persona,
  agentId,
  size = "md",
  className,
}: {
  persona: { name: string; avatarUrl: string | null };
  agentId?: string;
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const box = { sm: "size-6 rounded-[7px]", md: "size-8 rounded-[10px]", lg: "size-10 rounded-[12px]", xl: "size-14 rounded-[16px]" }[size];
  const [broken, setBroken] = useState(false);
  if (persona.avatarUrl && !broken) {
    return (
      <img
        src={persona.avatarUrl}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setBroken(true)}
        className={cn("shrink-0 border border-border bg-bg-soft object-cover", box, className)}
      />
    );
  }
  return <AgentAvatar name={persona.name || "?"} id={agentId} size={size} className={className} />;
}

/** Page title with the provider's mark beside it. */
export function ProviderTitle({ provider, children }: { provider: ProviderId; children?: ReactNode }) {
  return (
    <span className="flex items-center gap-3">
      <ProviderMark provider={provider} size="md" />
      <span className="truncate">{children ?? PROVIDERS[provider].name}</span>
    </span>
  );
}

/** Three numbered points: what publishing an agent involves. */
export function HowItWorks({ provider, className }: { provider: ProviderId; className?: string }) {
  const meta = PROVIDERS[provider];
  return (
    <section aria-label={`How publishing to ${meta.name} works`} className={cn("surface rounded-xl px-6 py-5", className)}>
      <h2 className="text-h3 text-fg">How it works</h2>
      <ol className="mt-4 grid gap-6 md:grid-cols-3">
        {meta.steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden="true"
              className="flex size-6 shrink-0 items-center justify-center rounded-full bg-bg-soft text-micro-size font-semibold text-fg"
            >
              {i + 1}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-medium text-fg">{step.title}</p>
              <p className="mt-1 text-small text-fg-muted">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

interface IntegrationListPageProps<I extends InstallationLike, P extends PublicationLike> {
  provider: ProviderId;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  items: Array<{ installation: I; publications: P[] }>;
  pending: P[];
  /** Remove a half-finished publication. Throws on failure. */
  onDiscard: (pub: P) => Promise<void>;
  /** A second line of identity for an installation (GitHub: the bot login). */
  installationCaption?: (installation: I) => ReactNode;
  /** Secondary header actions, left of the primary one (outline buttons). */
  headerActions?: ReactNode;
  /** A quiet second action in the first-run state. */
  emptySecondaryAction?: ReactNode;
}

/**
 * The list page shared by Slack, GitHub and Linear: unfinished installs
 * first (they need a person), then one card per connected workspace with
 * the agents published into it. First run explains the three steps.
 */
export function IntegrationListPage<I extends InstallationLike, P extends PublicationLike>({
  provider,
  loading,
  error,
  onRetry,
  items,
  pending,
  onDiscard,
  installationCaption,
  headerActions,
  emptySecondaryAction,
}: IntegrationListPageProps<I, P>) {
  const meta = PROVIDERS[provider];
  const { byId: agentsById } = useAgents();
  // The provider's install redirect lands here with `?install=ok`.
  const [searchParams] = useSearchParams();
  const installed = searchParams.get("install") === "ok";
  const [discarding, setDiscarding] = useState<P | null>(null);
  const empty = items.length === 0 && pending.length === 0;
  const plusLabel = (
    <>
      <PlusIcon data-icon="inline-start" className="stroke-[2.25]" />
      {meta.publishLabel}
    </>
  );

  return (
    <Page
      width="wide"
      header={
        <PageHeader
          width="wide"
          title={<ProviderTitle provider={provider} />}
          subtitle={meta.tagline}
          actions={
            <>
              {headerActions}
              {/* One ink button per view: with nothing connected it is the
                  empty state's, and this one steps back to outline. */}
              <Button asChild variant={empty && !loading && !error ? "outline" : "default"}>
                <Link to={meta.publishPath}>{plusLabel}</Link>
              </Button>
            </>
          }
        />
      }
    >
      {installed && (
        <div className="mb-6">
          <InstallResult provider={provider} params={searchParams} />
        </div>
      )}
      {error ? (
        <ErrorState title={`${meta.name} connections could not be loaded`} error={new Error(error)} retry={onRetry} />
      ) : loading ? (
        <ListSkeleton />
      ) : empty ? (
        <div className="animate-rise-in space-y-4">
          <EmptyState
            size="lg"
            icon={<meta.icon />}
            title={`No ${meta.name} ${meta.workspaceNoun}s connected yet`}
            body={`Publishing an agent connects its ${meta.workspaceNoun} here. It takes about three minutes and needs a ${meta.name} admin.`}
            action={
              <>
                <Button asChild>
                  <Link to={meta.publishPath}>{meta.publishLabel}</Link>
                </Button>
                {emptySecondaryAction}
              </>
            }
          />
          <HowItWorks provider={provider} />
        </div>
      ) : (
        <div className="animate-rise-in space-y-10">
          {pending.length > 0 && (
            <Section
              title="Finish setting up"
              description="These installs were started but not completed. Pick one up where it stopped, or discard it."
            >
              <ul className="surface overflow-hidden rounded-xl">
                {pending.map((p) => (
                  <li key={p.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border px-5 py-3.5 first:border-t-0">
                    <PersonaAvatar persona={p.persona} agentId={p.agent_id} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-small-size font-medium text-fg" title={p.persona.name}>
                        {p.persona.name || "Unnamed persona"}
                      </p>
                      <p className="truncate text-xs text-fg-subtle">
                        {meta.nextStep(p.status)} · started <RelativeTime value={toMillis(p.created_at)} fallback="at an unknown time" />
                      </p>
                    </div>
                    <StatusPill status={p.status} />
                    <div className="flex shrink-0 items-center gap-1.5 pl-2">
                      <Button variant="ghost" size="sm" onClick={() => setDiscarding(p)}>
                        Discard
                      </Button>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`${meta.publishPath}?pub=${encodeURIComponent(p.id)}`}>
                          Resume
                          <ArrowRightIcon data-icon="inline-end" />
                        </Link>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {items.length > 0 && (
            <Section
              title={`Connected ${meta.workspaceNoun}s`}
              description={`${plural(items.length, meta.workspaceNoun)}, ${plural(
                items.reduce((n, it) => n + it.publications.length, 0),
                "agent",
              )} published.`}
            >
              <div className={cn("grid gap-4", items.length > 1 && "xl:grid-cols-2")}>
                {items.map(({ installation, publications }, i) => {
                  const live = publications.filter((p) => p.status === "live").length;
                  const href = meta.installationPath(installation.id);
                  return (
                    <article
                      key={installation.id}
                      className="stagger surface animate-rise-in flex flex-col overflow-hidden rounded-xl"
                      style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
                    >
                      <Link
                        to={href}
                        className="group/ws flex items-center gap-3.5 px-5 py-4 transition-quick hover:bg-bg-hover"
                        aria-label={`Manage ${installation.workspace_name}`}
                      >
                        <Avatar name={installation.workspace_name} size="lg" squared />
                        <div className="min-w-0 flex-1">
                          <h3 className="truncate text-h3 text-fg" title={installation.workspace_name}>
                            {installation.workspace_name || `Unnamed ${meta.workspaceNoun}`}
                          </h3>
                          <p className="truncate text-xs text-fg-subtle">
                            {publications.length === 0
                              ? "No agents yet"
                              : `${plural(publications.length, "agent")}${live < publications.length ? `, ${live} live` : ""}`}{" "}
                            · connected <RelativeTime value={toMillis(installation.created_at)} fallback="at an unknown time" />
                            {installationCaption && <> · {installationCaption(installation)}</>}
                          </p>
                        </div>
                        <span className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full px-2.5 text-small-size font-medium text-fg-muted transition-quick group-hover/ws:text-fg">
                          Manage
                          <ArrowRightIcon className="size-3.5 transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)] group-hover/ws:translate-x-0.5" />
                        </span>
                      </Link>
                      {publications.length > 0 ? (
                        <ul className="border-t border-border">
                          {publications.map((p) => {
                            const agentName = agentsById.get(p.agent_id)?.name;
                            return (
                              <li key={p.id} className="flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 first:border-t-0">
                                <PersonaAvatar persona={p.persona} agentId={p.agent_id} />
                                <div className="min-w-0 flex-1">
                                  <p className="truncate text-small-size font-medium text-fg" title={p.persona.name}>
                                    {p.persona.name || "Unnamed persona"}
                                  </p>
                                  <div className="flex items-center gap-1 truncate text-xs text-fg-subtle">
                                    Agent
                                    <EntityRef
                                      kind="agent"
                                      id={p.agent_id}
                                      name={agentName}
                                      avatar={false}
                                      className="text-xs font-normal text-fg-muted"
                                    />
                                  </div>
                                </div>
                                <StatusPill status={p.status} />
                              </li>
                            );
                          })}
                        </ul>
                      ) : (
                        <p className="border-t border-border px-5 py-3 text-small text-fg-muted">
                          Connected, with no agents published.{" "}
                          <Link
                            to={meta.publishPath}
                            className={inlineLink}
                          >
                            {meta.publishLabel}
                          </Link>
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </Section>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!discarding}
        onClose={() => setDiscarding(null)}
        destructive
        title={`Discard the install for ${discarding?.persona.name || "this agent"}?`}
        body={`The unfinished ${meta.name} app is abandoned and this entry is removed. You can publish the agent again at any time.`}
        confirmLabel="Discard install"
        onConfirm={async () => {
          if (!discarding) return;
          try {
            await onDiscard(discarding);
          } catch (err) {
            toast.error(withReason("The install could not be discarded", err));
            throw err;
          }
        }}
      />
    </Page>
  );
}

function ListSkeleton() {
  return (
    <div className="space-y-4" aria-hidden="true">
      <Skeleton className="h-5 w-48" rounded="sm" />
      <div className="grid gap-4 xl:grid-cols-2">
        {[3, 2].map((rows, i) => (
          <div key={i} className="surface rounded-xl">
            <div className="flex items-center gap-3.5 px-5 py-4">
              <Skeleton className="size-9" rounded="lg" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" rounded="sm" />
                <Skeleton className="h-3 w-56 max-w-full" rounded="sm" />
              </div>
            </div>
            {Array.from({ length: rows }).map((_, r) => (
              <div key={r} className="flex items-center gap-3 border-t border-border px-5 py-3">
                <Skeleton className="size-6" rounded="md" />
                <Skeleton className="h-3.5 w-36" rounded="sm" />
                <div className="flex-1" />
                <Skeleton className="h-3.5 w-20" rounded="sm" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
