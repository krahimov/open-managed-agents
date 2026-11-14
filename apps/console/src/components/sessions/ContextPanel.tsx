import { useEffect, useRef, useState, type ReactNode } from "react";
import { PanelGroup } from "../PanelGroup";
import { Link } from "react-router";
import { toast } from "sonner";
import {
  BoxIcon,
  BracesIcon,
  CircleAlertIcon,
  DownloadIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  LaptopIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { downloadSessionOutput, refreshSessionOutputs, useSessionOutputs } from "@/lib/session-outputs";
import { formatAbsolute, formatCompact, formatCost } from "@/lib/format";
import { rewardHeadline, type Trajectory } from "@/lib/trajectory";
import { formatBytes as formatSize } from "@/lib/attachments";
import { useQuietQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { standaloneLink } from "@/lib/links";
import type { SessionReading } from "@/lib/session-state";

import { AgentAvatar, EntityAvatar } from "../AgentAvatar";
import { Chip, StatusBadge } from "../Badge";
import { IdChip } from "../IdChip";
import { GitHubIcon, LinearIcon, SlackIcon, VaultIcon } from "../icons";
import { ModelBadge } from "../ModelBadge";
import { RelativeTime } from "../RelativeTime";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import { formatElapsed, type SessionUsage } from "./model";
import type { SessionSourceInfo } from "./SessionHeader";
import { SessionStatus } from "./SessionStatus";
import { githubLink, LINEAR_HOME, slackLink, slackNoun } from "./source";
import { failureSentence, withReason } from "@/lib/failure-text";
import { downloadFile } from "../files/files";

/**
 * The context panel: everything a session is made of and has produced, by
 * name. It replaces the old row of mono chips in the header. Quiet groups
 * on the page canvas with a hairline on the left; it is not a card.
 *
 *   Agent · Environment · Vaults · Source · Files · Usage · Outcome · Details
 */

export type PeekTarget = { kind: "agent" | "environment" | "vault"; id: string };

/** Where the conversation stands right now, as the page reads it off the live event stream. */
export type SessionState = "empty" | "running" | "approval" | "failed" | "settled";

export type { SessionOutputFile } from "@/lib/session-outputs";

interface ScopedFile {
  id: string;
  filename: string;
  media_type?: string;
  size_bytes?: number;
  downloadable?: boolean;
  created_at?: string;
}

/** A label–value line sized for a 320px aside. */
function Fact({ label, children, title }: { label: string; children: ReactNode; title?: string }) {
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 text-small" title={title}>
      <dt className="shrink-0 text-fg-subtle">{label}</dt>
      <dd className="min-w-0 truncate text-right text-fg tabular-nums">{children}</dd>
    </div>
  );
}

/**
 * A failed read inside the 320px panel. The shared compact error row is one
 * line and cut "Outcome could not be l…" here, so this one wraps: what
 * could not be loaded, the server's reason, and a retry of that read alone.
 */
function PanelProblem({ title, error, retry }: { title: string; error: unknown; retry?: () => unknown }) {
  const message = error === null || error === undefined || error === "" ? "" : failureSentence(error);
  return (
    <div role="alert" className="flex items-start gap-2.5 rounded-lg bg-danger-subtle py-2 pr-1.5 pl-3 text-small">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="min-w-0 flex-1 py-px">
        <p className="font-medium text-pretty text-fg">{title}</p>
        {message && <p className="mt-0.5 line-clamp-2 text-xs break-words text-fg-muted">{message}</p>}
      </div>
      {retry && (
        <Button variant="ghost" size="xs" className="shrink-0" onClick={() => void retry()}>
          Try again
        </Button>
      )}
    </div>
  );
}

function PeekButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-7 shrink-0 items-center justify-center rounded-full text-fg-subtle opacity-0 transition-quick group-focus-within/row:opacity-100 group-hover/row:opacity-100 hover:bg-bg-hover hover:text-fg focus-visible:opacity-100"
      >
        <BracesIcon className="size-3.5" />
      </button>
    </Tip>
  );
}

const rowLink =
  "flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-1 pr-1 -ml-1.5 pl-1.5 transition-quick hover:bg-bg-hover";

export function ContextPanel({
  sessionId,
  agent,
  environmentId,
  environmentName,
  environmentProblem,
  onRetryEnvironment,
  vaults,
  vaultsResolved,
  onRetryVaults,
  source,
  usage,
  trajectory,
  trajectoryFault,
  onRetryTrajectory,
  startedAt,
  lastActivityAt,
  onPeek,
  filesNonce,
  state = "settled",
  reading,
  className,
}: {
  sessionId: string;
  agent: { id?: string; name?: string; model?: string | { id: string; speed?: string }; version?: number; description?: string };
  environmentId?: string;
  environmentName?: string;
  /** The name lookup came back without a record: it is gone, or the read failed. */
  environmentProblem?: "missing" | "failed";
  onRetryEnvironment?: () => void;
  vaults: Array<{ id: string; name?: string; problem?: "missing" | "failed" }>;
  /** False while vault names are still being looked up. */
  vaultsResolved: boolean;
  onRetryVaults?: () => void;
  source: SessionSourceInfo;
  usage: SessionUsage;
  trajectory: Trajectory | "loading" | "error" | undefined;
  /** Set when `trajectory` is "error" because the read failed (not because it has not been built yet). */
  trajectoryFault?: Error | null;
  onRetryTrajectory?: () => void;
  startedAt?: string | number | null;
  lastActivityAt?: string | number | null;
  onPeek: (target: PeekTarget) => void;
  /** Bump to scroll the Files group into view (header menu → Files). */
  filesNonce?: number;
  /** The live state of the conversation; it outranks the stored outcome. */
  state?: SessionState;
  /** The one reading of the session: what it is waiting on a person for, in words. */
  reading?: SessionReading;
  className?: string;
}) {
  const ready = trajectory && trajectory !== "loading" && trajectory !== "error" ? trajectory : null;
  const tokens = ready?.summary?.token_usage;
  // The trajectory is read once when the page opens, so a live session's own
  // log (`usage`) is newer; each figure takes whichever has counted more.
  // The trajectory's input_tokens is the total input, cache included; `input`
  // here is the uncached part, as in SessionUsage.
  const trajCached = tokens?.cache_read_input_tokens ?? 0;
  const trajWrite = tokens?.cache_creation_input_tokens ?? 0;
  const output = Math.max(tokens?.output_tokens ?? 0, usage.outputTokens);
  const cached = Math.max(trajCached, usage.cacheReadTokens);
  const cacheWrite = Math.max(trajWrite, usage.cacheWriteTokens);
  const input = Math.max(tokens ? Math.max(0, (tokens.input_tokens ?? 0) - trajCached - trajWrite) : 0, usage.inputTokens);
  const totalTokens = input + output + cached + cacheWrite;
  const cost = ready?.trace_facts?.est_cost_usd;
  const localRuntime = environmentId === "env_local_runtime";

  const filesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (filesNonce) filesRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [filesNonce]);

  return (
    <aside
      aria-label="Session details"
      className={cn("no-scrollbar min-h-0 w-[320px] shrink-0 overflow-y-auto border-l border-border bg-bg", className)}
    >
      <div className="space-y-6 px-5 pt-5 pb-10">
        <PanelGroup label="Agent">
          {agent.id ? (
            <div className="group/row flex items-center gap-1">
              <Link to={`/agents/${agent.id}`} className={rowLink}>
                <AgentAvatar name={agent.name} id={agent.id} size="md" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-small font-medium text-fg">{agent.name ?? "Agent"}</span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <ModelBadge model={agent.model} variant="plain" className="text-xs" />
                    {agent.version != null && <span className="text-xs text-fg-subtle">· v{agent.version}</span>}
                  </span>
                </span>
              </Link>
              <PeekButton label="View the agent's configuration" onClick={() => onPeek({ kind: "agent", id: agent.id! })} />
            </div>
          ) : (
            <p className="text-small text-fg-subtle">Unknown agent</p>
          )}
        </PanelGroup>

        <PanelGroup label="Environment">
          {!environmentId ? (
            <p className="text-small text-fg-subtle">None</p>
          ) : localRuntime ? (
            <div className="flex items-center gap-2.5">
              <EntityAvatar icon={LaptopIcon} size="md" />
              <span className="min-w-0">
                <span className="block truncate text-small font-medium text-fg">Local runtime</span>
                <span className="block truncate text-xs text-fg-subtle">Runs on a connected machine</span>
              </span>
            </div>
          ) : (
            <div className="group/row flex items-center gap-1">
              <Link to={`/environments/${environmentId}`} className={rowLink}>
                <EntityAvatar icon={BoxIcon} size="md" />
                <span className="min-w-0 flex-1">
                  {environmentName ? (
                    <span className="line-clamp-2 text-small leading-snug font-medium text-fg" title={environmentName}>
                      {environmentName}
                    </span>
                  ) : environmentProblem === "missing" ? (
                    <span className="block truncate text-small text-fg-subtle italic">Deleted environment</span>
                  ) : environmentProblem === "failed" ? (
                    <span className="block truncate text-small text-fg-muted">Name could not be loaded</span>
                  ) : (
                    <Skeleton className="h-3.5 w-36" rounded="sm" />
                  )}
                  <span className="block truncate text-xs text-fg-subtle">Sandbox the agent works in</span>
                </span>
              </Link>
              {environmentProblem === "failed" && onRetryEnvironment ? (
                <RetryInline label="Load the environment's name again" onClick={onRetryEnvironment} />
              ) : (
                <PeekButton label="View the environment's configuration" onClick={() => onPeek({ kind: "environment", id: environmentId })} />
              )}
            </div>
          )}
        </PanelGroup>

        <PanelGroup label="Vaults">
          {vaults.length === 0 ? (
            <p className="text-small text-fg-subtle">None attached</p>
          ) : (
            <ul className="space-y-0.5">
              {vaults.map((v) => (
                <VaultRow key={v.id} id={v.id} name={v.name} problem={v.problem} resolved={vaultsResolved} onPeek={onPeek} onRetry={onRetryVaults} />
              ))}
            </ul>
          )}
        </PanelGroup>

        <SourceGroup source={source} />

        <div ref={filesRef} className="scroll-mt-5">
          <FilesGroup sessionId={sessionId} />
        </div>

        <PanelGroup label="Usage">
          {totalTokens === 0 && usage.modelCalls === 0 ? (
            <p className="text-small text-fg-subtle">No model calls yet</p>
          ) : (
            <>
              {totalTokens > 0 && <TokenMix input={input} cached={cached} cacheWrite={cacheWrite} output={output} />}
              <dl className="mt-2">
                {totalTokens > 0 && <Fact label="Tokens">{formatCompact(totalTokens)}</Fact>}
                {cost != null && (
                  <Fact label="Estimated cost" title="API-price estimate">
                    {formatCost(cost)}
                  </Fact>
                )}
                {usage.modelCalls > 0 && <Fact label="Model calls">{usage.modelCalls.toLocaleString()}</Fact>}
                <Fact label="Tool calls">
                  {(ready?.summary?.num_tool_calls ?? usage.toolCalls).toLocaleString()}
                  {(ready?.summary?.num_tool_errors ?? usage.toolErrors) > 0 && (
                    <span className="text-danger"> · {ready?.summary?.num_tool_errors ?? usage.toolErrors} failed</span>
                  )}
                </Fact>
              </dl>
            </>
          )}
        </PanelGroup>

        <OutcomeGroup trajectory={trajectory} state={state} reading={reading} fault={trajectoryFault} onRetry={onRetryTrajectory} />

        <PanelGroup label="Details">
          <dl>
            <Fact label="Started">{startedAt ? formatAbsolute(startedAt).replace(/^\w+, /, "") : <span className="text-fg-subtle">Not recorded</span>}</Fact>
            <Fact label="Last activity">
              {lastActivityAt ? <RelativeTime value={lastActivityAt} /> : <span className="text-fg-subtle">None yet</span>}
            </Fact>
            {(ready?.summary?.duration_ms ?? usage.durationMs ?? 0) >= 1 && (
              <Fact label="Duration">{formatElapsed(ready?.summary?.duration_ms ?? usage.durationMs)}</Fact>
            )}
            <Fact label="Turns">{Math.max(ready?.summary?.num_turns ?? 0, usage.turns).toLocaleString()}</Fact>
          </dl>
          <div className="mt-2.5">
            <IdChip id={sessionId} full label="Copy session id" />
          </div>
        </PanelGroup>
      </div>
    </aside>
  );
}

/** "Retry" for one failed lookup in a row: small, where the peek button would be. */
function RetryInline({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex h-8 shrink-0 items-center rounded-full px-2.5 text-xs font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
      >
        Retry
      </button>
    </Tip>
  );
}

function VaultRow({
  id,
  name,
  problem,
  resolved,
  onPeek,
  onRetry,
}: {
  id: string;
  name?: string;
  /** `missing`: the vault no longer exists. `failed`: its name could not be read. */
  problem?: "missing" | "failed";
  resolved: boolean;
  onPeek: (target: PeekTarget) => void;
  onRetry?: () => void;
}) {
  const isLoading = !resolved;
  return (
    <li className="group/row flex items-center gap-1">
      <Link to={`/vaults/${id}`} className={rowLink}>
        <EntityAvatar icon={VaultIcon} size="sm" />
        {name ? (
          <span className="min-w-0 flex-1 truncate text-small font-medium text-fg" title={name}>
            {name}
          </span>
        ) : isLoading ? (
          <Skeleton className="h-3.5 w-32" rounded="sm" />
        ) : problem === "failed" ? (
          <span className="min-w-0 flex-1 truncate text-small text-fg-muted">Name could not be loaded</span>
        ) : problem === "missing" ? (
          <span className="min-w-0 flex-1 truncate text-small text-fg-subtle italic">Deleted vault</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-small text-fg-muted">Unnamed vault</span>
        )}
      </Link>
      {problem === "failed" && onRetry ? (
        <RetryInline label="Load the vault's name again" onClick={onRetry} />
      ) : (
        <PeekButton label="View the vault's details" onClick={() => onPeek({ kind: "vault", id })} />
      )}
    </li>
  );
}

/**
 * Where the session came from. A link here is labelled with what it opens:
 * a Slack thread can be addressed from what the session records, so it is
 * "Open thread"; a GitHub pull request likewise. A Linear issue is "Open
 * issue in Linear" when its address can be found (see source.ts), and
 * otherwise "Open Linear" with the issue's id beside it, ready to copy.
 */
function SourceGroup({ source }: { source: SessionSourceInfo }) {
  const { linear, slack } = source;
  const link = cn(standaloneLink, "text-small");
  if (linear && (linear.issueIdentifier || linear.issueId)) {
    const ident = linear.issueIdentifier ?? linear.issueId ?? "";
    return (
      <PanelGroup label="Started from">
        <div className="flex items-start gap-2.5">
          <EntityAvatar size="md">
            <LinearIcon className="size-4" />
          </EntityAvatar>
          <div className="min-w-0 flex-1">
            <p className="flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 text-small font-medium text-fg">
              Linear issue
              <IdChip id={ident} full={!!linear.issueIdentifier} label="Copy issue id" />
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {source.linearUrl ? (
                <a href={source.linearUrl} target="_blank" rel="noreferrer" className={link}>
                  Open issue in Linear <ExternalLinkIcon className="size-3.5" />
                </a>
              ) : (
                <a href={LINEAR_HOME} target="_blank" rel="noreferrer" className={link}>
                  Open Linear <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
              {linear.publicationId && (
                <Link to={`/integrations/linear/publish?pub=${encodeURIComponent(linear.publicationId)}`} className={link}>
                  Publication
                </Link>
              )}
            </p>
            {!source.linearUrl && (
              <p className="mt-1 text-xs text-pretty text-fg-subtle">
                This session does not say which Linear workspace the issue is in, so there is no direct link. Paste its id into
                Linear&rsquo;s search.
              </p>
            )}
          </div>
        </div>
      </PanelGroup>
    );
  }
  const gh = githubLink(source.github);
  if (source.github && gh) {
    const noun = gh.opens === "pull request" ? "Pull request" : gh.opens === "issue" ? "Issue" : "Repository";
    return (
      <PanelGroup label="Started from">
        <div className="flex items-start gap-2.5">
          <EntityAvatar size="md">
            <GitHubIcon className="size-4" />
          </EntityAvatar>
          <div className="min-w-0 flex-1">
            <p className="flex min-h-8 items-center text-small font-medium text-fg">
              <span className="min-w-0 break-words">
                {noun}
                {gh.label !== "GitHub" && <span className="font-normal text-fg-muted"> · {gh.label}</span>}
              </span>
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              <a href={gh.href} target="_blank" rel="noreferrer" className={link}>
                Open {gh.opens} <ExternalLinkIcon className="size-3.5" />
              </a>
            </p>
          </div>
        </div>
      </PanelGroup>
    );
  }
  if (slack && (slack.channelId || slack.threadTs)) {
    const to = slackLink(slack);
    return (
      <PanelGroup label="Started from">
        <div className="flex items-start gap-2.5">
          <EntityAvatar size="md">
            <SlackIcon className="size-4" />
          </EntityAvatar>
          <div className="min-w-0 flex-1">
            <p className="flex min-h-8 items-center text-small font-medium text-fg">
              <span className="truncate">
                {slackNoun(slack)}
                {slack.eventKind && <span className="font-normal text-fg-subtle"> · {slack.eventKind.replace(/_/g, " ")}</span>}
              </span>
            </p>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
              {to && (
                <a href={to.href} target="_blank" rel="noreferrer" className={link}>
                  {to.opens === "thread" ? "Open thread" : "Open channel"} <ExternalLinkIcon className="size-3.5" />
                </a>
              )}
              {slack.publicationId && (
                <Link to={`/integrations/slack/publish?pub=${encodeURIComponent(slack.publicationId)}`} className={link}>
                  Publication
                </Link>
              )}
            </p>
            {/* What Slack calls this place, to copy when the link above is
                not enough (or could not be built at all). */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {(!to || to.opens !== "thread") && slack.channelId && <IdChip id={slack.channelId} full label="Copy channel id" />}
              {slack.threadTs && <IdChip id={slack.threadTs} full label="Copy thread timestamp" />}
            </div>
            {!to && (
              <p className="mt-1 text-xs text-pretty text-fg-subtle">The session does not record the Slack workspace, so there is no link to open.</p>
            )}
          </div>
        </div>
      </PanelGroup>
    );
  }
  return null;
}

// ── usage ───────────────────────────────────────────────────────────────

/**
 * Where the tokens went, as one proportion bar. Tokens are an amount, not a
 * set of things, so the bar is one ink ramp (index.css --mix-*), ordered and
 * shaded by what a token costs: cached input least, output most. It shares
 * no hue with a provider (apricot, teal) or with the timeline's kinds of
 * work, and the Usage page's token mix uses the same steps.
 */
function TokenMix({ input, cached, cacheWrite, output }: { input: number; cached: number; cacheWrite: number; output: number }) {
  const parts = [
    { label: "Cached input", value: cached, color: "var(--mix-cached)" },
    { label: "New input", value: input + cacheWrite, color: "var(--mix-input)" },
    { label: "Output", value: output, color: "var(--mix-output)" },
  ].filter((p) => p.value > 0);
  const total = parts.reduce((n, p) => n + p.value, 0) || 1;
  return (
    <div>
      <div
        className="flex h-2 gap-0.5 overflow-hidden rounded-full"
        role="img"
        title="Shaded by what a token costs: cached input least, output most"
        aria-label={parts.map((p) => `${p.label} ${Math.round((100 * p.value) / total)}%`).join(", ")}
      >
        {parts.map((p) => (
          <span
            key={p.label}
            className="h-full min-w-1 rounded-full"
            style={{ width: `${(100 * p.value) / total}%`, backgroundColor: p.color }}
          />
        ))}
      </div>
      <ul className="mt-2 space-y-0.5">
        {parts.map((p) => (
          <li key={p.label} className="flex min-h-6 items-center gap-2 text-small">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: p.color }} />
            <span className="flex-1 text-fg-muted">{p.label}</span>
            <span className="text-fg tabular-nums">{formatCompact(p.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const OUTCOME: Record<string, { status: string; label: string; blurb: string }> = {
  success: { status: "completed", label: "Succeeded", blurb: "The last turn finished cleanly." },
  failure: { status: "errored", label: "Failed", blurb: "The run ended on an error." },
  timeout: { status: "errored", label: "Timed out", blurb: "The run hit its time limit." },
  interrupted: { status: "terminated", label: "Interrupted", blurb: "The run was stopped before it finished." },
};

function OutcomeGroup({
  trajectory,
  state,
  reading,
  fault,
  onRetry,
}: {
  trajectory: Trajectory | "loading" | "error" | undefined;
  state: SessionState;
  reading?: SessionReading;
  /** The outcome's read failed (as opposed to: there is no outcome yet). */
  fault?: Error | null;
  onRetry?: () => void;
}) {
  // What is happening now outranks the stored record: a session waiting on
  // a person has not "succeeded", and one that never ran has no outcome.
  if (state === "approval") {
    // The same words as the header and the composer: what the agent asked
    // for, whether that is an approval, access to an app or a skill.
    return (
      <PanelGroup label="Outcome">
        {reading ? <SessionStatus reading={reading} variant="soft" tip={false} /> : <StatusBadge status="approval" label="Waiting on you" variant="soft" />}
        <p className="mt-2 text-small text-fg-muted">
          {reading?.detail ? `${reading.detail}. ` : ""}The outcome is decided once you answer.
        </p>
      </PanelGroup>
    );
  }
  if (state === "running") {
    return (
      <PanelGroup label="Outcome">
        <p className="text-small text-fg-subtle">Decided when the run finishes.</p>
      </PanelGroup>
    );
  }
  if (state === "empty") {
    return (
      <PanelGroup label="Outcome">
        <p className="text-small text-fg-subtle">Nothing has run yet.</p>
      </PanelGroup>
    );
  }
  if (trajectory === undefined || trajectory === "loading") {
    return (
      <PanelGroup label="Outcome">
        <Skeleton className="h-[22px] w-24" rounded="full" />
      </PanelGroup>
    );
  }
  // The cause in the error card's words when the reading has it, as the
  // header, the lists and Operations say it.
  const cause = reading?.status === "errored" && reading.detail && reading.detail !== "The last turn failed" ? reading.detail : null;
  const failedNow = { status: "errored", label: "Failed", blurb: cause ? `${cause.replace(/\.$/, "")}.` : "The last turn ended on an error." };
  if (trajectory === "error") {
    return (
      <PanelGroup label="Outcome">
        {state === "failed" ? (
          <>
            <StatusBadge status={failedNow.status} label={failedNow.label} variant="soft" />
            <p className="mt-2 text-small text-fg-muted">{failedNow.blurb}</p>
          </>
        ) : fault ? (
          <PanelProblem title="Outcome could not be loaded" error={fault} retry={onRetry} />
        ) : (
          <p className="text-small text-fg-subtle">Not available for this session yet.</p>
        )}
      </PanelGroup>
    );
  }
  if (trajectory.outcome === "running" && state !== "failed") {
    return (
      <PanelGroup label="Outcome">
        <p className="text-small text-fg-subtle">Decided when the run finishes.</p>
      </PanelGroup>
    );
  }
  const o =
    state === "failed" && trajectory.outcome !== "timeout"
      ? failedNow
      : (OUTCOME[trajectory.outcome] ?? { status: "neutral", label: trajectory.outcome, blurb: "" });
  const reward = trajectory.reward;
  const verdict = reward?.metadata?.verdict;
  return (
    <PanelGroup label="Outcome">
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusBadge status={o.status} label={o.label} variant="soft" />
        {reward && (
          <Tip
            label={
              <span>
                Reward {reward.final_reward.toFixed(4)}
                {reward.verifier_id ? ` · ${reward.verifier_id}` : ""}
                {reward.computed_at ? ` · ${formatAbsolute(reward.computed_at)}` : ""}
              </span>
            }
          >
            <span>
              <Chip tone={reward.final_reward >= 0.99 ? "success" : reward.final_reward <= 0 ? "danger" : "neutral"}>
                Reward {rewardHeadline(reward) === "PASS" ? "pass" : rewardHeadline(reward) === "FAIL" ? "fail" : rewardHeadline(reward)}
              </Chip>
            </span>
          </Tip>
        )}
      </div>
      <p className="mt-2 text-small text-fg-muted">{verdict?.summary || reward?.metadata?.reason || o.blurb}</p>
    </PanelGroup>
  );
}

// ── files ───────────────────────────────────────────────────────────────

export function formatBytes(n: number | undefined): string {
  return n == null || !Number.isFinite(n) ? "" : formatSize(n);
}

function fileIcon(name: string, mediaType?: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mediaType?.startsWith("image/")) return FileImageIcon;
  if (["csv", "tsv", "xlsx", "xls"].includes(ext)) return FileSpreadsheetIcon;
  if (["md", "txt", "pdf", "doc", "docx", "log"].includes(ext)) return FileTextIcon;
  if (["json", "xml", "yaml", "yml", "sql", "py", "ts", "js", "sh", "html", "css"].includes(ext)) return FileCodeIcon;
  return FileIcon;
}

/** The query that lists the files attached to a session (its uploads), so a send can refresh it. */
export const sessionUploadsPath = (sessionId: string) => `/v1/files?scope_id=${encodeURIComponent(sessionId)}&limit=50`;

/**
 * Files of this session: what the agent wrote to its outputs folder, plus
 * files attached to the session. One list; every row downloads, with the
 * console's sign-in (lib/session-outputs, components/files/files), never a
 * bare link that would go without it.
 *
 * The outputs listing is shared with the links in the replies and the
 * per-turn Files rows, and is read again whenever a turn ends.
 */
function FilesGroup({ sessionId }: { sessionId: string }) {
  const { outputs, error: outputsError } = useSessionOutputs(sessionId);
  // A listing that failed after one that worked keeps showing the files it had.
  const error = outputs === null && outputsError ? new Error(outputsError) : null;
  // Two reads feed this list. Each is drawn in place when it fails (no
  // toast), and a failure of one never hides what the other returned or
  // passes for "no files".
  const scoped = useQuietQuery<{ data: ScopedFile[] }>(sessionUploadsPath(sessionId));

  const downloadScoped = async (f: ScopedFile) => {
    try {
      await downloadFile({ id: f.id, filename: f.filename });
    } catch (e) {
      toast.error(withReason(`${f.filename} could not be downloaded`, e));
    }
  };

  // A Cloudflare server folds the outputs into this listing too, as `out:` ids: they are listed above already.
  const attached = (scoped.data?.data ?? []).filter((f) => !f.id.startsWith("out:"));
  const outputsLoading = outputs === null && !error;
  // A server without the files endpoint (404 / 501) has no attached files to show; that is not a failure.
  const attachedFailed = !!scoped.error && !scoped.data && !scoped.missing;
  const count = (outputs?.length ?? 0) + attached.length;
  const stillLoading = outputsLoading || scoped.isLoading;
  const retryOutputs = () => void refreshSessionOutputs(sessionId);

  return (
    <PanelGroup label={count > 0 ? `Files · ${count}` : "Files"}>
      {count === 0 && stillLoading && !error && !attachedFailed ? (
        <div className="space-y-2.5" aria-hidden="true">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="size-6" rounded="md" />
              <Skeleton className="h-3.5 flex-1" rounded="sm" style={{ maxWidth: i ? "55%" : "75%" }} />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {count > 0 && (
            <ul className="space-y-0.5">
              {(outputs ?? []).map((f) => (
                <FileRow
                  key={`out-${f.filename}`}
                  name={f.filename}
                  meta={[formatBytes(f.size_bytes), "written by the agent"].filter(Boolean).join(" · ")}
                  mediaType={f.media_type}
                  at={f.uploaded_at}
                  onDownload={() => void downloadSessionOutput(sessionId, f.filename)}
                />
              ))}
              {attached.map((f) => (
                <FileRow
                  key={f.id}
                  name={f.filename}
                  meta={formatBytes(f.size_bytes)}
                  mediaType={f.media_type}
                  at={f.created_at}
                  onDownload={f.downloadable === false ? undefined : () => void downloadScoped(f)}
                />
              ))}
            </ul>
          )}
          {error && attachedFailed ? (
            <PanelProblem
              title="Files could not be loaded"
              error={error}
              retry={() => {
                retryOutputs();
                void scoped.refetch();
              }}
            />
          ) : error ? (
            <PanelProblem title="Files the agent wrote could not be loaded" error={error} retry={retryOutputs} />
          ) : attachedFailed ? (
            <PanelProblem title="Attached files could not be loaded" error={scoped.error} retry={() => scoped.refetch()} />
          ) : null}
          {count === 0 && !error && !attachedFailed && (
            <p className="text-small text-fg-subtle">
              No files yet. Anything the agent writes to <code className="font-mono text-xs">/mnt/session/outputs/</code> appears here.
            </p>
          )}
        </div>
      )}
    </PanelGroup>
  );
}

function FileRow({
  name,
  meta,
  mediaType,
  at,
  onDownload,
}: {
  name: string;
  meta: string;
  mediaType?: string;
  at?: string;
  onDownload?: () => void;
}) {
  const Icon = fileIcon(name, mediaType);
  const body = (
    <>
      <EntityAvatar icon={Icon} size="sm" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-small font-medium text-fg">{name}</span>
        <span className="block truncate text-xs text-fg-subtle">
          {meta}
          {meta && at ? " · " : ""}
          {at ? <RelativeTime value={at} /> : null}
        </span>
      </span>
      {onDownload && (
        <DownloadIcon className="size-3.5 shrink-0 text-fg-faint transition-quick group-hover/file:text-fg" aria-hidden="true" />
      )}
    </>
  );
  const cls = "group/file -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-2.5 rounded-md px-1.5 py-1.5 text-left transition-quick";
  return (
    <li title={name}>
      {onDownload ? (
        <button type="button" onClick={onDownload} aria-label={`Download ${name}`} className={cn(cls, "hover:bg-bg-hover")}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}
