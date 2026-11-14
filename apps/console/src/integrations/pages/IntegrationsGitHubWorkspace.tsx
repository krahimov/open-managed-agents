import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { ExternalLinkIcon } from "lucide-react";

import { IntegrationsApi } from "../api/client";
import type { GitHubInstallation, GitHubPublication, GitHubSessionMetadata, SessionSummary } from "../api/types";
import {
  EditPublicationDialog,
  InstallationPage,
  NoPublications,
  PublicationCard,
  UnpublishDialog,
  type CapabilityGroup,
} from "../components/Publication";
import { toMillis } from "../components/relativeTime";
import { Chip } from "../../components/Badge";
import { EmptyState } from "../../components/EmptyState";
import { EntityRef } from "../../components/EntityRef";
import { IdChip } from "../../components/IdChip";
import { PropertyList, Property } from "../../components/PropertyList";
import { ErrorState } from "../../components/QueryProblem";
import { RelativeTime } from "../../components/RelativeTime";
import { SectionCard } from "../../components/SectionCard";
import { Skeleton } from "../../components/Skeleton";
import { Tip } from "../../components/Tip";
import { plural } from "../../lib/format";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

// GitHub-flavoured capability set, mirroring what packages/github exports.
// Sandbox-side `gh` and `git` are not gated by these (they inherit the
// App's per-install GitHub permissions); these express intent for typed
// tools and for audit.
const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { label: "Issues", caps: ["issue.read", "issue.create", "issue.update", "issue.delete"] },
  { label: "Pull requests", caps: ["pr.read", "pr.create", "pr.update", "pr.review.write", "pr.review.comment", "pr.close", "pr.merge"] },
  { label: "Comments", caps: ["comment.write", "comment.delete"] },
  { label: "Labels", caps: ["label.add", "label.remove"] },
  { label: "Assignment", caps: ["assignee.set", "assignee.set_other"] },
  { label: "Repository", caps: ["repo.read", "repo.write", "repo.branch.create", "repo.branch.delete"] },
  { label: "Workflows and releases", caps: ["workflow.read", "workflow.dispatch", "release.read", "release.create"] },
  { label: "Statuses, mentions and search", caps: ["status.set", "user.mention", "search.read"] },
];

// The default wake-up matrix, from packages/github/src/webhook/parse.ts:
// assigned to the bot, review requested of the bot, and @mentions.
const WAKEUP_EVENTS: Array<{ kind: string; description: string }> = [
  { kind: "issue_assigned", description: "An issue is assigned to the bot" },
  { kind: "pr_assigned", description: "A pull request is assigned to the bot" },
  { kind: "pr_review_requested", description: "The bot's review is requested" },
  { kind: "issue_mentioned", description: "The bot is mentioned in an issue comment" },
  { kind: "pr_mentioned", description: "The bot is mentioned in a pull request comment or review" },
  { kind: "pr_review_submitted", description: "A review lands on a pull request the bot is reviewing" },
];

const EVENT_LABEL: Record<string, string> = {
  issue_assigned: "Issue assigned",
  pr_assigned: "Pull request assigned",
  pr_review_requested: "Review requested",
  issue_mentioned: "Mentioned in an issue",
  pr_mentioned: "Mentioned in a pull request",
  pr_review_submitted: "Review submitted",
};

/** One GitHub organization with the app installed: bound agents, what wakes them, and recent activity. */
export function IntegrationsGitHubWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [publications, setPublications] = useState<GitHubPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<GitHubPublication | null>(null);
  const [removing, setRemoving] = useState<GitHubPublication | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Settled separately: an id that is not connected makes the publications
      // read fail, and that case is "not found", not an error.
      const [insts, pubs] = await Promise.allSettled([api.github.listInstallations(), api.github.listPublications(id)]);
      if (insts.status === "rejected") throw insts.reason;
      setInstallations(insts.value);
      if (pubs.status === "fulfilled") setPublications(pubs.value);
      else if (insts.value.some((i) => i.id === id)) throw pubs.reason;
      else setPublications([]);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const installation = installations.find((i) => i.id === id);
  // GitHub bot logins are always `<slug>[bot]`: the slug is the identity,
  // the suffix is GitHub's bookkeeping.
  const login = installation?.bot_login ?? "";
  const slug = login.endsWith("[bot]") ? login.slice(0, -"[bot]".length) : login;

  return (
    <InstallationPage
      provider="github"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      installation={installation}
      publications={publications}
      description="Agents bound here act through a GitHub App with its own bot identity."
      meta={
        slug ? (
          <Chip mono title={`Acts as ${login}`}>
            @{slug}
          </Chip>
        ) : undefined
      }
      aside={
        installation && (
          <>
            <SectionCard title="Details">
              <PropertyList labelWidth="narrow">
                <Property label="Acts as" empty="Not reported">
                  {login ? (
                    <span className="block font-mono text-xs leading-snug break-all" title={`@${login}`}>
                      @{slug}
                      {login !== slug && <span className="text-fg-subtle">[bot]</span>}
                    </span>
                  ) : null}
                </Property>
                <Property label="Connected">
                  <RelativeTime value={toMillis(installation.created_at)} fallback="Not recorded" />
                </Property>
                <Property label="Credentials" empty="No vault">
                  {installation.vault_id ? <EntityRef kind="vault" id={installation.vault_id} /> : null}
                </Property>
                <Property label="Installation" empty="Not reported">
                  {installation.workspace_id ? (
                    <IdChip id={installation.workspace_id} label="Copy GitHub installation id" />
                  ) : null}
                </Property>
                <Property label="Connection id">
                  <IdChip id={installation.id} label="Copy connection id" />
                </Property>
              </PropertyList>
            </SectionCard>

            <SectionCard title="Wakes up on" description="What starts a session for a bound agent.">
              <ul className="space-y-3">
                {WAKEUP_EVENTS.map((e) => (
                  <li key={e.kind}>
                    <p className="text-small text-fg">{e.description}</p>
                    <code className="font-mono text-xs text-fg-subtle">{e.kind}</code>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-border pt-3 text-xs text-fg-subtle">
                The bot's own mentions, events sent by the bot, and comments that do not mention it never wake it.
              </p>
            </SectionCard>
          </>
        )
      }
    >
      {publications.length === 0 ? (
        <NoPublications provider="github" />
      ) : (
        publications.map((p, i) => (
          <PublicationCard
            key={p.id}
            provider="github"
            pub={p}
            groups={CAPABILITY_GROUPS}
            editLabel="Edit capabilities"
            unpublishLabel="Unbind"
            onEdit={() => setEditing(p)}
            onUnpublish={() => setRemoving(p)}
            className="stagger animate-rise-in"
            style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
          />
        ))
      )}

      {installation && <ActivitySection installation={installation} />}

      <EditPublicationDialog
        provider="github"
        pub={editing}
        groups={CAPABILITY_GROUPS}
        editPersona={false}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (!editing) return;
          await api.github.updatePublication(editing.id, { capabilities: patch.capabilities });
          await load();
        }}
      />
      <UnpublishDialog
        provider="github"
        pub={removing}
        verb="Unbind"
        onClose={() => setRemoving(null)}
        onConfirm={async (pub) => {
          await api.github.unpublish(pub.id);
          await load();
        }}
      />
    </InstallationPage>
  );
}

/**
 * Sessions GitHub started for this installation. /v1/sessions has no
 * server-side metadata filter yet, so the latest 50 are narrowed here to
 * those stamped with this installation id.
 */
function ActivitySection({ installation }: { installation: GitHubInstallation }) {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    setErr(null);
    api
      .listSessions({ limit: 50 })
      .then((data) => {
        if (!alive) return;
        setSessions(
          data.filter((s) => {
            const meta = (s.metadata?.github as GitHubSessionMetadata | undefined) ?? null;
            return meta?.installationId === installation.workspace_id;
          }),
        );
      })
      .catch((e) => {
        if (alive) setErr(failureSentence(e));
      });
    return () => {
      alive = false;
    };
  }, [installation.workspace_id, attempt]);

  return (
    <SectionCard
      title="Recent activity"
      description={
        sessions && sessions.length > 0
          ? `${plural(sessions.length, "session")} started from GitHub, newest first.`
          : "Sessions GitHub events have started for this installation."
      }
      flush
    >
      {err ? (
        <div className="p-5">
          <ErrorState compact title="Activity could not be loaded" error={new Error(err)} retry={() => setAttempt((n) => n + 1)} />
        </div>
      ) : sessions === null ? (
        <div aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-3 border-t border-border px-5 py-3.5 first:border-t-0">
              <Skeleton className="h-[22px] w-32" rounded="full" />
              <Skeleton className="h-3.5 w-48" rounded="sm" />
              <div className="flex-1" />
              <Skeleton className="h-3.5 w-14" rounded="sm" />
            </div>
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <EmptyState
          size="sm"
          variant="plain"
          kind="session"
          title="Nothing has woken the bot yet"
          body={
            <>
              Assign an issue to <code className="font-mono text-xs text-fg">@{installation.bot_login}</code> or mention it in a
              comment to start its first session.
            </>
          }
        />
      ) : (
        <ul>
          {sessions.map((s) => (
            <ActivityRow key={s.id} session={s} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}

function ActivityRow({ session }: { session: SessionSummary }) {
  const meta = (session.metadata?.github as GitHubSessionMetadata | undefined) ?? null;
  const kind = meta?.eventKind ?? meta?.eventType ?? "";
  const where = meta?.repository ? `${meta.repository}${meta.itemNumber != null ? `#${meta.itemNumber}` : ""}` : null;
  return (
    <li className="group/row relative flex min-h-[52px] items-center gap-3 border-t border-border px-5 py-2 transition-colors duration-100 first:border-t-0 hover:bg-bg-hover">
      <div className="min-w-0 flex-1">
        <Link
          to={`/sessions/${session.id}`}
          className="block truncate text-small-size font-medium text-fg after:absolute after:inset-0"
          title={session.title || undefined}
        >
          {where ? <span className="font-mono text-xs font-normal">{where}</span> : session.title?.trim() || "Session from GitHub"}
        </Link>
        <p className="truncate text-xs text-fg-subtle">
          {EVENT_LABEL[kind] ?? (kind ? kind.replace(/_/g, " ") : "GitHub event")}
          {meta?.actorLogin && <> by @{meta.actorLogin}</>}
        </p>
      </div>
      <RelativeTime value={session.created_at} className="text-small-size text-fg-muted" />
      {meta?.htmlUrl ? (
        <Tip label="Open on GitHub">
          <a
            href={meta.htmlUrl}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open ${where ?? "this item"} on GitHub`}
            className="relative inline-flex size-8 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-pressed hover:text-fg"
          >
            <ExternalLinkIcon className="size-4" />
          </a>
        </Tip>
      ) : (
        <span className="size-8 shrink-0" aria-hidden="true" />
      )}
    </li>
  );
}
