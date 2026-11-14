import type { ReactNode } from "react";
import { Link } from "react-router";
import { ArrowUpRightIcon, CircleAlertIcon, CircleHelpIcon, HourglassIcon, MessagesSquareIcon, RotateCwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { plural } from "@/lib/format";
import { SESSION_SOURCE_LABEL } from "@/lib/sessions";
import { cn } from "@/lib/utils";

import { AgentAvatar, EntityAvatar } from "../AgentAvatar";
import { EventCard } from "../EventCard";
import { RelativeTime } from "../RelativeTime";
import { SectionCard } from "../SectionCard";
import type { ToolCall } from "../sessions/model";
import { NEEDS_YOU_CARD } from "../sessions/RequestParts";
import { ProviderResponse, ToolInputPreview, presentTool } from "../sessions/tools";
import { Tip } from "../Tip";
import type { OperationActions } from "./actions";
import {
  readFailure,
  type ApprovalEntry,
  type EndedEntry,
  type FailureEntry,
  type RequestEntry,
  type UnknownEntry,
  type SessionRef,
  type WaitingEntry,
} from "./model";

/**
 * The queue: what is waiting on a person.
 *
 *   <SessionHeading>  which conversation a card is about (agent mark + title)
 *   <ApprovalCard>    a tool call that will not run until someone decides
 *   <RequestList>     sessions whose agent asked for access to an app or for
 *                     a skill; they are answered on the session's own page
 *   <FailureCard>     a turn that failed and blocks the session behind it
 *   <SetAsideList>    failed work the worker stopped retrying
 *   <EndedList>       sessions that stopped on an error, nothing to retry
 *   <WaitingList>     queued work held back by capacity or a budget
 *
 * Approval and failure cards are the session page's own cards (EventCard,
 * the same tool preview), so a call looks the same wherever it is decided.
 */

/** Small count beside a section title or a tab label. */
export function CountPill({
  count,
  tone = "neutral",
  className,
}: {
  count: number;
  tone?: "neutral" | "warning" | "danger" | "info" | "selected";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-micro-size leading-none font-medium",
        tone === "warning" && "bg-warning-subtle text-warning",
        tone === "danger" && "bg-danger-subtle text-danger",
        tone === "info" && "bg-info-subtle text-info",
        tone === "selected" && "bg-bg-pressed text-fg",
        tone === "neutral" && "bg-bg-soft text-fg-subtle",
        className,
      )}
    >
      {count}
    </span>
  );
}

/** The agent's mark, or a neutral session mark when the agent is not known. */
export function SessionMark({ session, size = "sm" }: { session: SessionRef; size?: "sm" | "md" }) {
  return session.agentName ? (
    <AgentAvatar name={session.agentName} id={session.agentId} size={size} />
  ) : (
    <EntityAvatar icon={MessagesSquareIcon} size={size} />
  );
}

/** "Finance Ops Reconciler · via Linear" */
function agentLine(session: SessionRef): string {
  const via = session.source && session.source !== "console" ? `via ${SESSION_SOURCE_LABEL[session.source]}` : null;
  return [session.agentName, via].filter(Boolean).join(" · ");
}

/**
 * The line above a queue card: which conversation it belongs to. The card
 * under it names the agent in words, so here the agent is only its mark.
 */
export function SessionHeading({ session, className }: { session: SessionRef; className?: string }) {
  const line = session.source && session.source !== "console" ? `via ${SESSION_SOURCE_LABEL[session.source]}` : "";
  return (
    <div className={cn("flex min-w-0 items-center gap-2.5", className)}>
      <SessionMark session={session} />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <Link
          to={`/sessions/${session.id}`}
          title={session.title}
          className="min-w-0 truncate rounded-sm text-sm font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
        >
          {session.title}
        </Link>
        {line && <span className="hidden shrink-0 text-xs text-fg-subtle sm:inline">{line}</span>}
      </div>
      <Link
        to={`/sessions/${session.id}`}
        aria-label={`Open session: ${session.title}`}
        className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
      >
        Open session
        <ArrowUpRightIcon className="size-3.5" />
      </Link>
    </div>
  );
}

/** An action on this card did not go through: say so where the person clicked. */
function ActionProblem({ actions, scope }: { actions: OperationActions; scope: string }) {
  if (actions.failure?.scope !== scope) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-md bg-bg-surface px-3 py-2 text-small dark:bg-bg-inset">
      <CircleAlertIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      <p className="min-w-0 flex-1 text-fg">
        <span className="font-medium">This was not completed.</span>{" "}
        <span className="break-words text-fg-muted">{actions.failure.message}</span>
      </p>
      <button
        type="button"
        onClick={actions.dismissFailure}
        aria-label="Dismiss"
        className="-mr-1 inline-flex size-6 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  );
}

function AccessNote({ actions }: { actions: OperationActions }) {
  if (!actions.accessKnown || actions.canOperate) return null;
  return <span className="text-xs text-fg-muted">Operator access is required.</span>;
}

/**
 * A tool call that is waiting on a person: who is asking, the exact input,
 * and the two decisions. The answer applies to this call only.
 */
export function ApprovalCard({ entry, actions }: { entry: ApprovalEntry; actions: OperationActions }) {
  const call: Pick<ToolCall, "name" | "flavor" | "input"> = { name: entry.name, flavor: "tool", input: entry.input };
  const tool = presentTool(call);
  const toolLabel = tool.source ? `${tool.source} · ${tool.title}` : tool.title;
  const allowing = actions.busy === `allow:${entry.key}`;
  const denying = actions.busy === `deny:${entry.key}`;
  const decide = (result: "allow" | "deny") =>
    void actions.run(result, entry.key, `/v1/operations/sessions/${entry.session.id}/approvals`, {
      tool_use_id: entry.toolUseId,
      result,
    });
  return (
    <EventCard
      kind="approval"
      className={NEEDS_YOU_CARD}
      title={`${entry.session.agentName ?? "The agent"} wants to ${tool.verb}`}
      subtitle={
        <span className="block text-pretty">
          <span className="font-mono text-xs">{toolLabel}</span> is set to ask first. Nothing runs until you decide, and your answer
          applies to this call only.
        </span>
      }
      meta={entry.requestedAt ? <RelativeTime value={entry.requestedAt} prefix="Asked" fallback="" /> : undefined}
      actions={
        <>
          <Button size="sm" disabled={actions.locked && !allowing} loading={allowing} onClick={() => decide("allow")}>
            Allow this call
          </Button>
          <Button size="sm" variant="outline" disabled={actions.locked && !denying} loading={denying} onClick={() => decide("deny")}>
            Deny
          </Button>
          <AccessNote actions={actions} />
        </>
      }
    >
      <ToolInputPreview call={call as ToolCall} />
      <ActionProblem actions={actions} scope={entry.key} />
    </EventCard>
  );
}

/**
 * A turn that failed. The failed message blocks the ones queued behind it
 * in the same session until someone retries it or sets it aside.
 */
export function FailureCard({ entry, actions }: { entry: FailureEntry; actions: OperationActions }) {
  const reading = readFailure(entry.error);
  const retrying = actions.busy === `retry:${entry.key}`;
  const discarding = actions.busy === `discard:${entry.key}`;
  const who = entry.session.agentName ?? "The agent";
  return (
    <EventCard
      kind="error"
      title={reading.cause ?? reading.headline}
      subtitle={
        <span className="block text-pretty">
          {who} stopped after {plural(entry.attempts, "attempt")}.{reading.next ? ` ${reading.next}` : ""}
        </span>
      }
      meta={entry.at ? <RelativeTime value={entry.at} prefix="Failed" fallback="" /> : undefined}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={actions.locked && !retrying}
            loading={retrying}
            onClick={() =>
              actions.confirm({
                title: "Retry this work?",
                body: "The agent runs the failed message again. Anything it finished before the failure may be repeated, so review the session first.",
                confirmLabel: "Retry work",
                run: () => actions.run("retry", entry.key, `/v1/operations/work-items/${entry.key}/retry`),
              })
            }
          >
            <RotateCwIcon data-icon="inline-start" />
            Retry work
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={actions.locked && !discarding}
            loading={discarding}
            onClick={() =>
              actions.confirm({
                title: "Discard this failed work?",
                body: "The message that failed is set aside so later messages in this session can run. It stays listed under Set aside, where it can still be retried.",
                confirmLabel: "Discard and continue",
                run: () => actions.run("discard", entry.key, `/v1/operations/work-items/${entry.key}/discard`),
              })
            }
          >
            Discard and continue
          </Button>
          {(reading.auth || reading.quota) && (
            <Button size="sm" variant="ghost" asChild>
              <Link to="/model-cards">Review model keys</Link>
            </Button>
          )}
          <AccessNote actions={actions} />
        </>
      }
    >
      {entry.trigger && (
        <p className="flex min-w-0 items-baseline gap-2 text-small text-fg-muted">
          <span className="shrink-0">While handling</span>
          <q className="min-w-0 truncate text-fg" title={entry.trigger}>
            {entry.trigger}
          </q>
        </p>
      )}
      {reading.raw && <ProviderResponse>{reading.raw}</ProviderResponse>}
      <ActionProblem actions={actions} scope={entry.key} />
    </EventCard>
  );
}

/** One quiet row of the lists below: mark, title, one line, a time, an action. */
function QuietRow({
  session,
  detail,
  detailTone = "muted",
  time,
  trailing,
}: {
  session: SessionRef;
  detail: string;
  detailTone?: "muted" | "danger";
  time?: ReactNode;
  trailing?: ReactNode;
}) {
  const line = agentLine(session);
  return (
    <li className="flex items-center gap-3 px-5 py-3">
      <SessionMark session={session} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <Link
            to={`/sessions/${session.id}`}
            title={session.title}
            className="min-w-0 truncate rounded-sm text-small font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
          >
            {session.title}
          </Link>
          {line && <span className="hidden shrink-0 text-xs text-fg-subtle md:inline">{line}</span>}
        </div>
        <p className={cn("mt-0.5 truncate text-xs", detailTone === "danger" ? "text-danger" : "text-fg-muted")} title={detail}>
          {detail}
        </p>
      </div>
      {time && <span className="hidden shrink-0 text-xs text-fg-subtle sm:block">{time}</span>}
      {trailing}
    </li>
  );
}

function OpenSession({ session }: { session: SessionRef }) {
  return (
    <Tip label="Open session">
      <Link
        to={`/sessions/${session.id}`}
        aria-label={`Open session: ${session.title}`}
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-fg-subtle transition-quick hover:bg-bg-hover hover:text-fg"
      >
        <ArrowUpRightIcon className="size-4" />
      </Link>
    </Tip>
  );
}

/**
 * Sessions whose agent asked for something only a person can give: access
 * to an app, or a skill. A request is answered where it was made (signing
 * in to an app opens a window from the session's own card), so each row
 * says what is asked for and goes to the first request on that page.
 */
export function RequestList({ entries }: { entries: RequestEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <ul className={cn("divide-y divide-[var(--needs-you-border)] rounded-lg border", NEEDS_YOU_CARD)}>
      {entries.map((entry) => {
        const access = entry.requests.filter((r) => r.kind === "access").map((r) => r.name);
        const skills = entry.requests.filter((r) => r.kind === "skill").map((r) => r.name);
        const asks = [
          access.length > 0 ? `access to ${words(access)}` : "",
          skills.length > 0 ? `the ${words(skills)} ${skills.length === 1 ? "skill" : "skills"}` : "",
        ].filter(Boolean);
        return (
          <li key={entry.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
            <SessionMark session={entry.session} size="md" />
            <div className="min-w-0 flex-1 basis-64">
              <Link
                to={`/sessions/${entry.session.id}#needs-you`}
                title={entry.session.title}
                className="block truncate rounded-sm text-sm font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
              >
                {entry.session.title}
              </Link>
              <p className="mt-0.5 text-small text-pretty text-fg-muted">
                {entry.session.agentName ?? "The agent"} asks for {asks.join(" and ")}.
                {entry.at ? (
                  <>
                    {" "}
                    <RelativeTime value={entry.at} prefix="Asked" fallback="" className="text-fg-subtle" />
                  </>
                ) : null}
              </p>
            </div>
            <Button size="sm" asChild>
              <Link to={`/sessions/${entry.session.id}#needs-you`}>
                {entry.requests.length === 1 ? "Answer in the session" : `Answer ${entry.requests.length} in the session`}
                <ArrowUpRightIcon data-icon="inline-end" />
              </Link>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

/** A failure in one line, the way its card and the session's own page say it: the cause first. */
const failureLine = (error: string | null): string => {
  const reading = readFailure(error);
  return reading.cause ?? reading.headline;
};

const words = (names: string[]): string =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;

/** Failed work the worker stopped retrying, or that a person set aside. */
export function SetAsideList({ entries, actions }: { entries: FailureEntry[]; actions: OperationActions }) {
  if (entries.length === 0) return null;
  return (
    <SectionCard
      flush
      title="Set aside"
      description="The worker stopped retrying these, so the rest of each session can run. They can still be retried."
    >
      <ul className="divide-y divide-border">
        {entries.map((entry) => {
          const retrying = actions.busy === `retry:${entry.key}`;
          return (
            <QuietRow
              key={entry.key}
              session={entry.session}
              detail={failureLine(entry.error)}
              time={entry.at ? <RelativeTime value={entry.at} fallback="" /> : undefined}
              trailing={
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actions.locked && !retrying}
                  loading={retrying}
                  onClick={() =>
                    actions.confirm({
                      title: "Retry this work?",
                      body: "The agent runs the message again. Anything it finished before the failure may be repeated, so review the session first.",
                      confirmLabel: "Retry work",
                      run: () => actions.run("retry", entry.key, `/v1/operations/work-items/${entry.key}/retry`),
                    })
                  }
                >
                  Retry work
                </Button>
              }
            />
          );
        })}
      </ul>
    </SectionCard>
  );
}

/** Sessions that stopped on an error and have nothing queued to retry. */
export function EndedList({ entries }: { entries: EndedEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <SectionCard
      flush
      title="Ended on an error"
      description="These sessions stopped on an error and have nothing queued to retry. Open one to see what happened."
    >
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <QuietRow
            key={entry.key}
            session={entry.session}
            detail={failureLine(entry.error)}
            detailTone="danger"
            time={entry.at ? <RelativeTime value={entry.at} fallback="" /> : undefined}
            trailing={<OpenSession session={entry.session} />}
          />
        ))}
      </ul>
    </SectionCard>
  );
}

/**
 * Sessions whose events could not be read, so whether they are waiting on a
 * person is not known. Said here rather than left out of the counts in
 * silence; the reads are tried again on their own, or now.
 */
export function UnknownList({ entries, retry, retrying }: { entries: UnknownEntry[]; retry: () => void; retrying?: boolean }) {
  if (entries.length === 0) return null;
  const unreadable = entries.some((e) => e.reason === "unreadable");
  return (
    <SectionCard
      flush
      title={
        <span className="flex items-center gap-2">
          <CircleHelpIcon className="size-4 text-fg-subtle" />
          Could not be checked
        </span>
      }
      description={
        unreadable
          ? "Their events could not be read, so whether they are waiting on you for access or a skill is not known. They are not in the counts above."
          : "Their history is too long to check here for requests, so they are not in the counts above. Open one to see."
      }
      actions={
        unreadable ? (
          <Button size="sm" variant="outline" onClick={retry} loading={retrying}>
            <RotateCwIcon data-icon="inline-start" />
            Try again
          </Button>
        ) : undefined
      }
    >
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <QuietRow key={entry.key} session={entry.session} detail={entry.detail} trailing={<OpenSession session={entry.session} />} />
        ))}
      </ul>
    </SectionCard>
  );
}

/** Queued work held back by capacity or a budget. The worker retries by itself. */
export function WaitingList({ entries }: { entries: WaitingEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <SectionCard
      flush
      title={
        <span className="flex items-center gap-2">
          <HourglassIcon className="size-4 text-warning" />
          Waiting for capacity
        </span>
      }
      description="Held back by a concurrency or budget limit. The worker admits them on its own as room frees up."
    >
      <ul className="divide-y divide-border">
        {entries.map((entry) => (
          <QuietRow
            key={entry.key}
            session={entry.session}
            detail={entry.reason}
            time={entry.at ? <RelativeTime value={entry.at} prefix="Since" fallback="" /> : undefined}
            trailing={<OpenSession session={entry.session} />}
          />
        ))}
      </ul>
    </SectionCard>
  );
}
