import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  BoxIcon,
  CalendarClockIcon,
  FileXIcon,
  FilePlusIcon,
  HistoryIcon,
  PencilLineIcon,
  SparkleIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Collapsible } from "@/components/ui/collapsible";
import { useApi } from "@/lib/api";
import { buildUserMessageEvent } from "@/lib/attachments";
import { plural } from "@/lib/format";
import { useAgentActivity, useAgents, useEntityName, useRecentSessions } from "@/lib/directory";
import { useQuietQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";
import { useAsyncAction } from "@/hooks/useAsyncAction";

import { AgentPicker } from "../AgentPicker";
import { Composer, ComposerNotice, type ComposerHandle } from "../Composer";
import { Kbd } from "../Kbd";
import { QueryProblem } from "../QueryProblem";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";
import {
  blankDraft,
  draftHasContent,
  draftPreview,
  draftStore,
  type Draft,
  type DraftProblem,
  type DraftStart,
} from "./draft";
import { defaultAgent, rememberedDefault } from "./default-agent";
import { SessionOptionsPanel, SessionOptionsTrigger } from "./SessionOptions";
import { useSessionOptions } from "./session-options";
import { buildStarters, type Starter, type StarterKind, type StarterRule } from "./starters";
import { attachToSession, newAttachmentCache, type AttachmentCache } from "../files/attach";
import { refusalText, refusalTitle, screenAttachments, type Refusal } from "../files/refusal";
import { failureSentence } from "@/lib/failure-text";

/**
 * The session starter: the one way to start a session.
 *
 *   message box · agent picker · attachments · Options (environment,
 *   vaults, resources, title) · three or four things to ask
 *
 * Home shows it inline. Everywhere else it opens in a dialog
 * (<NewSessionDialog>), with the agent or the environment already chosen.
 * It is the same component in both places, so a session starts the same
 * way wherever a person is.
 *
 * Sending creates the session (POST /v1/sessions with the agent, the
 * options and a title cut from the first line), attaches any files to it,
 * sends the first `user.message`, then opens the session. If a step fails
 * the words and the attachments stay in the box under a notice that says
 * which step failed; trying again continues with the session that was
 * already created instead of making a second one.
 *
 * Attachments can be any kind of file, picked, pasted or dropped anywhere
 * on the page (up to 10, 25 MB each): an image reaches the model as a
 * picture, any other file is saved in the agent's sandbox and the message
 * says where (../files/attach). A file over the limits is refused in a
 * notice that names it. Nothing is dropped silently.
 *
 * A server that asks for payment before a session can start (402) is said
 * in the same notice as any other refusal to start: the words stay in the
 * box, and the starter does not leave for a page this console has not got.
 *
 * The draft (words, agent, files, options, and a start that failed part
 * way) is kept per agent in ./draft: closing the dialog, leaving Home or
 * reloading the page brings all of it back, and a starter opened for one
 * agent never takes over a draft written for another.
 */

type Problem = DraftProblem;

/** Another agent's draft that the starter is telling the person about. */
type Offer = {
  agentId: string;
  /** `opened`: the starter was opened for this agent while that draft existed.
   *  `switched`: the picker went to an agent that already had a draft of its own. */
  reason: "opened" | "switched";
};

/** “a.csv”, “a.csv” and “b.pdf”, “a.csv”, “b.pdf” and 2 more */
function nameList(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  if (q.length <= 1) return q[0] ?? "";
  if (q.length === 2) return `${q[0]} and ${q[1]}`;
  if (q.length === 3) return `${q[0]}, ${q[1]} and ${q[2]}`;
  return `${q[0]}, ${q[1]} and ${q.length - 2} more`;
}

const reasonOf = (err: unknown) => (err instanceof Error && err.message ? failureSentence(err) : "The server did not say why.");

const STARTER_ICON: Record<StarterKind, typeof SparkleIcon> = {
  job: SparkleIcon,
  trigger: CalendarClockIcon,
  recent: HistoryIcon,
};

export function SessionStarter({
  variant = "home",
  initialAgentId,
  initialEnvironmentId,
  focusSignal,
  autoFocus,
  onNavigate,
  onBusyChange,
  quietFailure,
  className,
}: {
  /** `home`: centred under the greeting. `dialog`: inside <NewSessionDialog>. */
  variant?: "home" | "dialog";
  /** Open for this agent: its own draft is shown, never another agent's. */
  initialAgentId?: string;
  /** Start in this environment, whichever agent is chosen. */
  initialEnvironmentId?: string;
  /** Changes when something asks for the box to take focus (a "New session" click). */
  focusSignal?: number;
  autoFocus?: boolean;
  /** The starter is about to leave for another page (the new session, Billing,
   *  the agent gallery): a dialog that holds it closes. */
  onNavigate?: () => void;
  onBusyChange?: (busy: boolean) => void;
  /** The page already says the workspace could not be reached (and retries
   *  the agents): the starter keeps its own failure notice out of the way. */
  quietFailure?: boolean;
  className?: string;
}) {
  const nav = useNavigate();
  const { api } = useApi();
  const queryClient = useQueryClient();
  const { agents, byId, isLoading: agentsLoading, error: agentsError, refetch: refetchAgents } = useAgents();
  const { sessions, data: sessionsRead } = useRecentSessions();
  const { byAgent } = useAgentActivity();
  const pinned = initialEnvironmentId;

  // ── the draft this starter opens with ─────────────────────────────────
  // Asked for an agent: that agent's draft. Otherwise the draft worked on
  // last, with its agent; failing that the agent chosen last.
  const [boot] = useState(() => {
    const draft = initialAgentId ? draftStore.get(initialAgentId) : draftStore.latest();
    const other =
      initialAgentId && !draftHasContent(draft, pinned) ? draftStore.latest({ except: initialAgentId, withContent: true }) : null;
    return {
      draft,
      agentId: initialAgentId ?? (draft?.agentId || draftStore.recipient || null),
      offer: other ? ({ agentId: other.agentId, reason: "opened" } satisfies Offer) : null,
    };
  });
  /** Tells the store's other listeners that a change came from this starter. */
  const me = useRef({}).current;
  /** The agent the box's content is stored under. */
  const keyRef = useRef(boot.draft?.agentId ?? boot.agentId ?? "");
  /** The session started: the draft is gone and must not be written again. */
  const leaving = useRef(false);

  const composerRef = useRef<ComposerHandle>(null);
  const [text, setText] = useState(boot.draft?.text ?? "");
  const [files, setFiles] = useState<File[]>(boot.draft?.files ?? []);
  /** The starter chip whose text is in the box untouched, so another can replace it. */
  const [filledBy, setFilledBy] = useState<string | null>(boot.draft?.filledBy ?? null);
  const [problem, setProblem] = useState<Problem | null>(boot.draft?.problem ?? null);
  /** Images the draft held before a reload that could not be read back. */
  const [lost, setLost] = useState<string[]>(boot.draft?.lostFiles ?? []);
  /** Secrets a reload dropped from the resources (they are never stored). */
  const [secretsDropped, setSecretsDropped] = useState(boot.draft?.secretsDropped ?? 0);
  const [offer, setOffer] = useState<Offer | null>(boot.offer);
  const [refused, setRefused] = useState<Refusal[]>([]);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  // What was already done for the session being started, so "Try again"
  // picks up where it stopped: the session itself, and each attached file.
  const made = useRef<DraftStart | null>(boot.draft?.made ?? null);
  /** Files already uploaded (and attached) to each session started here, by session id. */
  const attachedTo = useRef(new Map<string, AttachmentCache>());

  // ── which agent ───────────────────────────────────────────────────────
  const activeAgents = useMemo(() => agents.filter((a) => !a.archived_at), [agents]);
  // The most used agent, once the sessions say which it is. Until they do
  // (loading, or the read failed) the one they said last time stands in,
  // never "whichever was created last" (default-agent.ts).
  const usageKnown = !!sessionsRead;
  const mostUsed = useMemo(
    () =>
      defaultAgent({
        agents,
        usage: usageKnown ? new Map([...byAgent].map(([id, a]) => [id, a.sessions])) : null,
        remembered: rememberedDefault.get(),
      }),
    [agents, byAgent, usageKnown],
  );
  useEffect(() => {
    if (usageKnown && mostUsed) rememberedDefault.set(mostUsed.id);
  }, [usageKnown, mostUsed]);

  // With nothing asked for and nothing kept, start on the most used agent.
  // Activity arrives after the agent list, so keep following it, but only
  // until the person chooses or puts something in the box: after that the
  // agent never changes under them.
  const [agentId, setAgentId] = useState<string | null>(boot.agentId);
  const chosen = useRef(!!boot.agentId);
  useEffect(() => {
    if (mostUsed && (agentId === null || !chosen.current)) setAgentId(mostUsed.id);
  }, [mostUsed]); // eslint-disable-line react-hooks/exhaustive-deps
  // An agent that was asked for but cannot start a session (archived, gone)
  // gives way to the default once the directory has loaded.
  const asked = agentId ? byId.get(agentId) : undefined;
  const agent = asked && !asked.archived_at ? asked : !agentsLoading && agentId && mostUsed ? mostUsed : undefined;

  const options = useSessionOptions(agent, pinned, boot.draft?.options);
  const pinnedEnvironment = useEntityName("environment", pinned);

  // ── keeping the draft ─────────────────────────────────────────────────
  const optionsNow = options.snapshot();
  const optionsKey = JSON.stringify(optionsNow);
  const optionsRef = useRef(optionsNow);
  optionsRef.current = optionsNow;
  const current = (): Draft => ({
    agentId: keyRef.current,
    text,
    filledBy,
    files,
    options: optionsRef.current,
    made: made.current,
    problem,
    lostFiles: lost,
    secretsDropped,
    touchedAt: 0,
  });
  const hasOwnContent = draftHasContent(current(), pinned);
  if (hasOwnContent) chosen.current = true;

  // Everything in the box is written to the draft store as it changes.
  useEffect(() => {
    if (leaving.current) return;
    const key = agent?.id ?? agentId ?? "";
    // The agent resolved or gave way without the person choosing (the first
    // agent arrived, an archived one fell back): the draft goes with it.
    if (keyRef.current !== key) {
      draftStore.remove(keyRef.current, me);
      keyRef.current = key;
    }
    draftStore.save({ ...current(), agentId: key }, { source: me, pinnedEnvironmentId: pinned });
  }, [agent?.id, agentId, text, filledBy, files, problem, lost, secretsDropped, optionsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Put a draft in the box, whole. */
  const show = (draft: Draft) => {
    setText(draft.text);
    setFilledBy(draft.filledBy);
    setFiles(draft.files);
    setProblem(draft.problem);
    setLost(draft.lostFiles);
    setSecretsDropped(draft.secretsDropped);
    made.current = draft.made;
    options.load(draft.options);
    setRefused([]);
  };
  const showRef = useRef(show);
  showRef.current = show;

  // The draft changed somewhere else: its images were read back after a
  // reload, or another starter on the page edited it.
  useEffect(
    () =>
      draftStore.subscribe((key, source) => {
        if (source === me || leaving.current || key !== keyRef.current) return;
        showRef.current(draftStore.get(key) ?? blankDraft(key));
      }),
    [me],
  );

  // Once the rows are whole again the reload's missing secrets are settled.
  useEffect(() => {
    if (secretsDropped > 0 && !options.resourcesInvalid) setSecretsDropped(0);
  }, [secretsDropped, options.resourcesInvalid]);

  /** Show this agent with its own draft (or an empty box). */
  const turnTo = (id: string, theirs: Draft | null) => {
    keyRef.current = id;
    setAgentId(id);
    show(theirs ?? blankDraft(id));
  };

  /** The person chose an agent in the picker. */
  const pickAgent = (id: string) => {
    chosen.current = true;
    draftStore.setRecipient(id);
    if (id !== agent?.id) {
      const mine = current();
      const theirs = draftStore.get(id);
      if (!draftHasContent(mine, pinned)) {
        // Nothing of the person's own is in the box (a starter chip sitting
        // there untouched was written for the agent being left and goes
        // with it): show what the chosen agent has.
        draftStore.remove(mine.agentId, me);
        turnTo(id, theirs);
        setOffer(null);
      } else if (!draftHasContent(theirs)) {
        // What is written comes along. The environment and the vaults go
        // back to the new agent's own; resources, title and images stay.
        draftStore.remove(mine.agentId, me);
        keyRef.current = id;
        setAgentId(id);
        options.followAgent();
        if (filledBy) {
          setText("");
          setFilledBy(null);
        }
        setProblem(null);
        setOffer(null);
      } else {
        // Both agents have a draft. Neither is poured into the other: the
        // chosen agent's is shown, and the one being left stays with its agent.
        draftStore.save(mine, { source: me, pinnedEnvironmentId: pinned });
        turnTo(id, theirs);
        setOffer({ agentId: mine.agentId, reason: "switched" });
      }
    }
    composerRef.current?.focus({ end: true });
  };

  // ── focus, and being asked for an agent while already on the page ─────
  const openFor = (id: string) => {
    chosen.current = true;
    draftStore.setRecipient(id);
    if (id === (agent?.id ?? agentId)) return;
    const mine = current();
    const theirs = draftStore.get(id);
    // What is in the box stays with its own agent.
    if (draftHasContent(mine, pinned)) draftStore.save(mine, { source: me, pinnedEnvironmentId: pinned });
    else draftStore.remove(mine.agentId, me);
    turnTo(id, theirs);
    setOffer(!draftHasContent(theirs) && draftHasContent(mine, pinned) ? { agentId: mine.agentId, reason: "opened" } : null);
  };
  const openForRef = useRef(openFor);
  openForRef.current = openFor;
  const firstSignal = useRef(true);
  useEffect(() => {
    // The first pass is the mount, which `boot` already answered.
    if (firstSignal.current) {
      firstSignal.current = false;
      if (focusSignal) composerRef.current?.focus({ end: true });
      return;
    }
    if (!focusSignal) return;
    if (initialAgentId) openForRef.current(initialAgentId);
    composerRef.current?.focus({ end: true });
  }, [focusSignal, initialAgentId]);

  // The other draft the starter is telling the person about, while it exists.
  const offered = offer && offer.agentId !== keyRef.current ? draftStore.get(offer.agentId) : null;
  const offeredAgent = offered ? byId.get(offered.agentId) : undefined;
  const moveOfferedHere = () => {
    if (!offered) return;
    draftStore.remove(offered.agentId, me);
    // As when the picker moves a draft: this agent's own environment and vaults apply.
    show({ ...offered, problem: null, options: { ...offered.options, environment_id: null, vault_ids: null } });
    setOffer(null);
    composerRef.current?.focus({ end: true });
  };

  // ── things to ask ─────────────────────────────────────────────────────
  const rules = useQuietQuery<{ data: StarterRule[] }>(agent ? `/v1/agents/${agent.id}/ambient-rules` : null);
  const starters = useMemo(
    () => buildStarters({ agent, rules: rules.data?.data, sessions }),
    [agent, rules.data, sessions],
  );
  const startersLoading = agentsLoading || (!!agent && rules.isLoading);
  // Once a person is writing their own words the starters step back.
  const ownWords = text.trim().length > 0 && !filledBy;

  const fill = (starter: Starter) => {
    setText(starter.text);
    setFilledBy(starter.key);
    setProblem(null);
    composerRef.current?.focus({ end: true });
  };

  // ── attachments ───────────────────────────────────────────────────────
  const filesRef = useRef(files);
  filesRef.current = files;
  const add = (incoming: File[]) => {
    const { accepted, refused: turnedAway } = screenAttachments(incoming, filesRef.current.length);
    setRefused(turnedAway);
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  };
  const addRef = useRef(add);
  addRef.current = add;

  // A file dropped anywhere on the page is meant for the box. Without this
  // the browser would open the file and the page (and the draft) would go.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
    const onEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth += 1;
      setDragging(true);
    };
    const onLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth = 0;
      setDragging(false);
      // The box itself already took a drop that landed on it.
      if (e.defaultPrevented) return;
      e.preventDefault();
      const dropped = Array.from(e.dataTransfer?.files ?? []);
      if (dropped.length) addRef.current(dropped);
      composerRef.current?.focus();
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, []);

  // ── starting ──────────────────────────────────────────────────────────
  const start = useAsyncAction(async (mode: "send" | "empty" | "without-failed" = "send") => {
    if (!agent) return;
    const prompt = mode === "empty" ? "" : text.trim();
    const failedBefore = problem?.stage === "upload" ? new Set(problem.failed) : null;
    const attach =
      mode === "empty" ? [] : mode === "without-failed" && failedBefore ? files.filter((f) => !failedBefore.has(f)) : files;
    setProblem(null);
    setRefused([]);
    setOptionsOpen(false);

    const firstLine = prompt.split("\n")[0].trim();
    const body = {
      agent: agent.id,
      ...(firstLine ? { title: firstLine.length > 72 ? `${firstLine.slice(0, 71).trimEnd()}…` : firstLine } : {}),
      // A title typed in Options wins over the one cut from the message.
      ...options.requestBody(),
    };
    const key = JSON.stringify(body);

    let session = made.current?.key === key ? made.current : null;
    if (!session) {
      try {
        const created = await api<{ id: string }>("/v1/sessions", {
          method: "POST",
          body: JSON.stringify(body),
          silentErrors: true,
        });
        session = { key, id: created.id, uploads: new Map() };
        made.current = session;
      } catch (err) {
        // A 402 (no balance for a cloud sandbox) is said here like any other
        // refusal, in the server's words. This console has no Billing page to
        // send the person to, and leaving would take the draft out of view.
        setProblem({ stage: "create", reason: reasonOf(err) });
        return;
      }
    }

    // Same message the session composer sends (../files/attach): every file
    // uploads first, scoped to the session; images ride along as pictures,
    // other files are written into the agent's sandbox and named in a note.
    let cache = attachedTo.current.get(session.id);
    if (!cache) {
      cache = newAttachmentCache();
      attachedTo.current.set(session.id, cache);
    }
    const { attachments, failed } = await attachToSession(api, session.id, attach, cache, reasonOf);
    if (failed.length > 0) {
      setProblem({ stage: "upload", reason: failed[0].reason, failed: failed.map((f) => f.file), sessionId: session.id });
      return;
    }
    if (prompt || attachments.length > 0) {
      try {
        await api(`/v1/sessions/${session.id}/events`, {
          method: "POST",
          body: JSON.stringify({ events: [buildUserMessageEvent(prompt, attachments)] }),
          silentErrors: true,
        });
      } catch (err) {
        setProblem({ stage: "send", reason: reasonOf(err), sessionId: session.id });
        return;
      }
    }

    // Sent: this draft is done. Drafts for other agents are untouched.
    leaving.current = true;
    made.current = null;
    draftStore.remove(keyRef.current, me);
    void queryClient.invalidateQueries({ queryKey: ["/v1/sessions"] });
    onNavigate?.();
    nav(`/sessions/${session.id}`);
  });

  useEffect(() => {
    onBusyChange?.(start.loading);
  }, [start.loading]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasContent = text.trim().length > 0 || files.length > 0;
  const canStart = !!agent && hasContent && options.ready;

  // ── states with no agent to talk to ───────────────────────────────────
  const noAgents = !agentsLoading && !agentsError && activeAgents.length === 0;
  const agentsFailed = !!agentsError && agents.length === 0;
  const unavailable = noAgents || agentsFailed;

  const failedNames = problem?.stage === "upload" ? problem.failed.map((f) => f.name) : [];
  const failedSet = problem?.stage === "upload" ? new Set(problem.failed) : null;
  const canSendWithout = !!failedSet && (text.trim().length > 0 || files.some((f) => !failedSet.has(f)));

  // One quiet line inside the box: why it cannot be sent yet, or where it will run.
  const footer = options.environmentMissing ? (
    <span className="flex items-center gap-2 text-warning">
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      This agent has no default environment. Choose one to send.
    </span>
  ) : options.resourcesInvalid ? (
    <span className="flex items-center gap-2 text-warning">
      <TriangleAlertIcon className="size-3.5 shrink-0" />
      {secretsDropped > 0
        ? "A token or secret value is never kept through a reload. Enter it again in Options to send."
        : "A resource in Options is not finished. Complete it or remove it to send."}
    </span>
  ) : pinned && options.environmentId === pinned && pinnedEnvironment.name ? (
    <span className="flex items-center gap-2">
      <BoxIcon className="size-3.5 shrink-0 text-fg-subtle" />
      <span className="truncate">
        Runs in <span className="font-medium text-fg">{pinnedEnvironment.name}</span>
      </span>
    </span>
  ) : undefined;

  const home = variant === "home";

  return (
    <div
      className={className}
      onPaste={(e) => {
        const pasted = Array.from(e.clipboardData?.files ?? []);
        if (pasted.length) {
          e.preventDefault();
          add(pasted);
        }
      }}
    >
      {/* Options open in place under the box, as wide as it: what is below
          moves down, nothing is covered, and the message stays in view. */}
      <Collapsible open={optionsOpen} onOpenChange={setOptionsOpen}>
        <div className="relative">
          <Composer
            ref={composerRef}
            size="lg"
            autoFocus={autoFocus}
            value={text}
            onChange={(v) => {
              setText(v);
              // Typed over: the words are the person's own now.
              setFilledBy(null);
              if (problem?.stage === "create") setProblem(null);
              // They are writing to this agent: the offer to bring another draft here has had its answer.
              if (offer?.reason === "opened") setOffer(null);
            }}
            onSubmit={() => void start.run("send")}
            submitting={start.loading}
            canSubmit={canStart}
            disabled={unavailable}
            placeholder={
              agentsFailed ? "Agents could not be loaded" : noAgents ? "Create an agent to start a session" : "Describe a task…"
            }
            aria-label="Message to start a new session"
            attachments={{
              files,
              onAdd: add,
              onRemove: (i) => {
                const removed = files[i];
                setFiles((cur) => cur.filter((_, idx) => idx !== i));
                // Taking out the file that failed settles that failure.
                if (problem?.stage === "upload" && removed) {
                  const left = problem.failed.filter((f) => f !== removed);
                  setProblem(left.length ? { ...problem, failed: left } : null);
                }
              },
            }}
            leading={
              unavailable ? undefined : (
                <>
                  <AgentPicker value={agent?.id ?? null} onChange={pickAgent} />
                  {agent && <SessionOptionsTrigger options={options} disabled={start.loading} />}
                </>
              )
            }
            footer={footer}
            className={cn(
              !home && "shadow-[var(--shadow-xs)] focus-within:shadow-[var(--shadow-sm)]",
              dragging && "border-plum shadow-[var(--shadow-focus)]",
            )}
          />
          {dragging && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex animate-fade-in items-center justify-center gap-2 rounded-2xl bg-bg-surface/90 text-small font-medium text-fg"
            >
              <FilePlusIcon className="size-4 text-plum" />
              Drop files to attach them
            </div>
          )}
        </div>
        <SessionOptionsPanel
          options={options}
          agent={agent}
          onClose={() => setOptionsOpen(false)}
          // Closing the panel returns to the message, not to the Options
          // button (whose tooltip would open over the draft).
          onClosed={() => composerRef.current?.focus({ end: true })}
          onStartEmpty={hasContent ? undefined : () => void start.run("empty")}
          startEmptyDisabled={!agent || !options.ready || start.loading}
        />
      </Collapsible>

      {/* News about this message, set against the box. */}
      {(problem || refused.length > 0 || lost.length > 0 || offered) && (
        <div className="mt-3 space-y-2">
          {offered && draftHasContent(offered) && (
            <ComposerNotice
              icon={PencilLineIcon}
              title={
                offer?.reason === "switched"
                  ? `${agent?.name ?? "This agent"} already had a draft, so that is what is shown`
                  : `You have an unsent draft for ${offeredAgent?.name ?? "another agent"}`
              }
              onDismiss={() => setOffer(null)}
              actions={
                // Offered only into an empty box: two drafts are never merged.
                !hasOwnContent ? (
                  <Button size="sm" variant="outline" onClick={moveOfferedHere}>
                    Move it here
                  </Button>
                ) : undefined
              }
            >
              {offer?.reason === "switched" ? (
                <>
                  What you wrote for {offeredAgent?.name ?? "the other agent"} ({describeDraft(offered)}) stays with{" "}
                  {offeredAgent?.name ?? "that agent"}. Choose {offeredAgent?.name ?? "it"} again to go back to it.
                </>
              ) : (
                <>
                  {capitalise(describeDraft(offered))}. It stays with {offeredAgent?.name ?? "that agent"} unless you move it
                  here.
                </>
              )}
            </ComposerNotice>
          )}
          {lost.length > 0 && (
            <ComposerNotice
              icon={FileXIcon}
              title={`${nameList(lost)} ${lost.length === 1 ? "was" : "were"} not kept when the page reloaded`}
              onDismiss={() => setLost([])}
            >
              The rest of your draft is here. Attach {lost.length === 1 ? "the file" : "the files"} again to send{" "}
              {lost.length === 1 ? "it" : "them"}.
            </ComposerNotice>
          )}
          {problem?.stage === "create" && (
            <ComposerNotice
              tone="danger"
              title="The session could not be started"
              onDismiss={() => setProblem(null)}
              actions={
                <Button size="sm" variant="outline" onClick={() => void start.run("send")} disabled={start.loading || !canStart}>
                  Try again
                </Button>
              }
            >
              {problem.reason} Your message is still in the box.
            </ComposerNotice>
          )}
          {problem?.stage === "upload" && (
            <ComposerNotice
              tone="danger"
              title={
                failedNames.length === 1
                  ? `${nameList(failedNames)} could not be uploaded, so nothing was sent`
                  : `${failedNames.length} files could not be uploaded, so nothing was sent`
              }
              onDismiss={() => setProblem(null)}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => void start.run("send")} disabled={start.loading}>
                    Try again
                  </Button>
                  {canSendWithout && (
                    <Button size="sm" variant="ghost" onClick={() => void start.run("without-failed")} disabled={start.loading}>
                      Send without {failedNames.length === 1 ? "it" : "them"}
                    </Button>
                  )}
                </>
              }
            >
              {failedNames.length > 1 && <>{nameList(failedNames)}. </>}
              {problem.reason} The session is created and waiting for this first message.
            </ComposerNotice>
          )}
          {problem?.stage === "send" && (
            <ComposerNotice
              tone="danger"
              title="The session was created, but your message was not sent"
              onDismiss={() => setProblem(null)}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={() => void start.run("send")} disabled={start.loading}>
                    Try again
                  </Button>
                  <Button size="sm" variant="ghost" asChild>
                    <Link to={`/sessions/${problem.sessionId}`} onClick={() => onNavigate?.()}>
                      Open the session
                    </Link>
                  </Button>
                </>
              }
            >
              {problem.reason} Your message is still in the box.
            </ComposerNotice>
          )}
          {refused.length > 0 && (
            <ComposerNotice icon={FileXIcon} title={refusalTitle(refused, nameList)} onDismiss={() => setRefused([])}>
              {refusalText(refused)}
            </ComposerNotice>
          )}
        </div>
      )}

      {/* Things to ask, or what stands in the way of asking. */}
      <div className={cn("relative mt-4 flex min-h-9 items-center", home ? "justify-center" : "justify-start")}>
        {/* While the person writes, the starters' place is taken by the two
            things worth knowing at that moment. The row keeps its height. */}
        {!unavailable && !startersLoading && (
          <p
            aria-hidden={!ownWords}
            className={cn(
              "pointer-events-none absolute inset-x-0 top-0 flex h-9 items-center gap-2 text-xs text-fg-subtle transition-opacity duration-[var(--dur-base)]",
              home ? "justify-center" : "justify-start px-1",
              ownWords ? "opacity-100" : "opacity-0",
            )}
          >
            <span className="flex items-center gap-1.5">
              <Kbd keys={["⇧", "↵"]} /> for a new line
            </span>
            <span aria-hidden="true">·</span>
            <span>Paste or drop a file to attach it</span>
          </p>
        )}
        {agentsFailed && quietFailure ? null : agentsFailed ? (
          <QueryProblem
            compact
            className="w-full text-left"
            title="Agents could not be loaded"
            error={agentsError}
            retry={refetchAgents}
          />
        ) : noAgents ? (
          <Button asChild>
            <Link to="/agents?create=1" onClick={() => onNavigate?.()}>
              Create your first agent
            </Link>
          </Button>
        ) : startersLoading ? (
          <div className="flex items-center gap-2" aria-hidden="true">
            {[148, 196, 172].map((w) => (
              <Skeleton key={w} className="h-9" rounded="full" style={{ width: w }} />
            ))}
          </div>
        ) : (
          <StarterRow
            starters={starters}
            home={home}
            // Hidden, not removed, while the person writes their own words: the page below does not jump.
            away={ownWords}
            selectedKey={filledBy && starters.some((s) => s.key === filledBy && s.text === text) ? filledBy : null}
            onFill={fill}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Things to ask, on one row. Every starter is laid out at its own width and
 * the row then keeps as many as fit, in the order they were ranked: one that
 * does not fit is left out rather than wrapped onto a line of its own, and a
 * shorter one after it may take its place. The first always shows (cut with
 * an ellipsis if the row is narrower than it).
 */
function StarterRow({
  starters,
  home,
  away,
  selectedKey,
  onFill,
}: {
  starters: Starter[];
  home: boolean;
  away: boolean;
  selectedKey: string | null;
  onFill: (starter: Starter) => void;
}) {
  const rowRef = useRef<HTMLUListElement>(null);
  /** Each chip's own width, measured while all of them are laid out. */
  const widths = useRef(new Map<string, number>());
  const [fit, setFit] = useState<{ keys: string; shown: Set<string> } | null>(null);
  // A chip measured in the fallback font is the wrong width once the real
  // one arrives: measure again then, or a chip could end up cut at the edge.
  const [fontsReady, setFontsReady] = useState(() => typeof document === "undefined" || !document.fonts || document.fonts.status === "loaded");
  useEffect(() => {
    if (fontsReady || !document.fonts) return;
    let live = true;
    void document.fonts.ready.then(() => live && setFontsReady(true));
    return () => {
      live = false;
    };
  }, [fontsReady]);
  const keys = starters.map((s) => `${s.key}:${s.label}`).join("|") + (fontsReady ? "" : "|~");
  // New starters are laid out whole (unseen) for one pass, so they can be measured.
  const measuring = fit?.keys !== keys;

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const GAP = 8;
    widths.current = new Map();
    for (const li of Array.from(row.children) as HTMLElement[]) {
      if (li.dataset.key) widths.current.set(li.dataset.key, li.offsetWidth);
    }
    const choose = () => {
      const style = getComputedStyle(row);
      const room = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      let used = 0;
      const shown = new Set<string>();
      for (const s of starters) {
        const w = widths.current.get(s.key) ?? 0;
        if (shown.size === 0 || used + GAP + w <= room) {
          used += (shown.size ? GAP : 0) + w;
          shown.add(s.key);
        }
      }
      setFit((prev) =>
        prev && prev.keys === keys && prev.shown.size === shown.size && [...shown].every((k) => prev.shown.has(k))
          ? prev
          : { keys, shown },
      );
    };
    choose();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(choose);
    observer.observe(row);
    return () => observer.disconnect();
  }, [keys]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <ul
      ref={rowRef}
      aria-label="Things to ask"
      inert={away || measuring}
      className={cn(
        // One row, never two. The padding leaves room for a chip's focus ring inside the clip.
        "-m-1 flex w-[calc(100%+0.5rem)] min-w-0 flex-nowrap items-center gap-2 overflow-hidden p-1 transition-opacity duration-[var(--dur-base)]",
        home ? "justify-center" : "justify-start",
        (away || measuring) && "opacity-0",
      )}
    >
      {starters.map((s, i) => {
        const Icon = STARTER_ICON[s.kind];
        const selected = selectedKey === s.key;
        const out = !measuring && !!fit && !fit.shown.has(s.key);
        return (
          <li key={s.key} data-key={s.key} className={cn(i === 0 && !measuring ? "min-w-0" : "shrink-0", out && "hidden")}>
            <Tip
              side="bottom"
              delay={500}
              label={
                <span className="block">
                  <span className="mb-1 block font-normal">“{s.text.trim()}”</span>
                  <span className="block font-normal opacity-80">{s.hint}</span>
                </span>
              }
            >
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onFill(s)}
                className={cn(
                  "flex h-9 max-w-full items-center gap-1.5 rounded-full border pr-3.5 pl-3 text-small font-medium whitespace-nowrap transition-quick active:scale-[0.97]",
                  selected
                    ? "border-border-strong bg-bg-surface text-fg shadow-[var(--shadow-xs)]"
                    : home
                      ? "border-transparent bg-bg-surface/65 text-fg-muted hover:bg-bg-surface hover:text-fg hover:shadow-[var(--shadow-xs)] dark:bg-bg-soft dark:hover:bg-bg-hover"
                      : "border-transparent bg-bg-soft text-fg-muted hover:bg-bg-hover hover:text-fg",
                )}
              >
                <Icon className={cn("size-3.5 shrink-0", selected ? "text-fg-muted" : "text-fg-subtle")} aria-hidden="true" />
                <span className="truncate">{s.label}</span>
              </button>
            </Tip>
          </li>
        );
      })}
    </ul>
  );
}

const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** What a draft holds, in a few words: “Summarise yesterday's…” and 2 files. */
function describeDraft(d: Draft): string {
  const words = draftPreview(d);
  const files = d.files.length + d.lostFiles.length;
  const parts: string[] = [];
  if (words) parts.push(`“${words}”`);
  if (files > 0) parts.push(plural(files, "file"));
  if (parts.length === 0) return "session options you changed";
  return parts.join(" and ");
}
