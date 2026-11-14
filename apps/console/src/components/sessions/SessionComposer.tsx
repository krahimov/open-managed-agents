import { useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArchiveIcon, FileXIcon, FlagIcon, ImagePlusIcon, PlusIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useCopy } from "@/lib/clipboard";
import { useQuietQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import { Composer, ComposerNotice, type ComposerHandle } from "../Composer";
import { ModelBadge } from "../ModelBadge";
import { refusalAdvice, refusalTitle, type FilesKnown, type Refusal } from "../files/refusal";
import { RefusalBody } from "../files/RefusalBody";
import { failureSentence } from "@/lib/failure-text";

const MAX_FILES = 10;
const MAX_BYTES = 25 * 1024 * 1024;
/** How many files are read to find a refused file in Files. */
const FILES_LOOKUP = 200;

/**
 * What became of a message the person sent. The composer keeps their words
 * until the server has taken them: anything but `ok` puts the text and the
 * attachments back in the box.
 *
 *   upload  one or more attachments did not upload; NOTHING was sent
 *   send    the message itself was refused or never arrived
 *           (`closed`: the session no longer takes messages at all)
 */
export type SendResult =
  | { ok: true }
  | { ok: false; stage: "upload"; failed: Array<{ file: File; reason: string }> }
  | { ok: false; stage: "send"; reason: string; closed?: boolean };

type Problem = Exclude<SendResult, { ok: true }>;

/** Why this session takes no messages, when it does not. */
export type ComposerClosed = "ended" | "archived";

const draftKey = (id: string) => `muse:session:draft:${id}`;

function readDraft(id: string | undefined): string {
  if (!id) return "";
  try {
    return sessionStorage.getItem(draftKey(id)) ?? "";
  } catch {
    return "";
  }
}

function writeDraft(id: string | undefined, text: string) {
  if (!id) return;
  try {
    if (text) sessionStorage.setItem(draftKey(id), text);
    else sessionStorage.removeItem(draftKey(id));
  } catch {
    // storage unavailable: the draft just will not survive a reload
  }
}

/** “a.csv”, “a.csv” and “b.pdf”, “a.csv”, “b.pdf” and 2 more */
function nameList(names: string[]): string {
  const q = names.map((n) => `“${n}”`);
  if (q.length <= 1) return q[0] ?? "";
  if (q.length === 2) return `${q[0]} and ${q[1]}`;
  if (q.length === 3) return `${q[0]}, ${q[1]} and ${q[2]}`;
  return `${q[0]}, ${q[1]} and ${q.length - 2} more`;
}

/**
 * The composer inside a session: the shared <Composer> plus what a session
 * needs around it.
 *
 * Attachments. A message carries images: the paperclip, a paste, or a drop
 * anywhere on the page (up to 10, 25 MB each). Anything else is refused in
 * a line above the box that names the file, says why, and says what is
 * true instead (../files/refusal): another kind of file is mounted from
 * Files when a session starts, so it goes to a new session.
 *
 * Sending. The box empties at once and the message shows in the
 * conversation as "Sending…". If the server does not take it, the words and
 * the attachments come back into the box under a notice that says what
 * failed, with "Try again". An attachment that fails to upload stops the
 * whole message: the person chooses between trying again and sending
 * without it. Typed text is also kept per session for the life of the tab,
 * so leaving the page does not lose it.
 *
 * Closed. A session that has ended or been archived takes no messages, so
 * there is no box to type in: a quiet bar says so and offers a new session
 * with the same agent.
 */
export function SessionComposer({
  sessionId,
  agentName,
  model,
  running,
  stalled,
  sending,
  onSend,
  onStop,
  footer,
  autoFocus,
  empty,
  closed,
  onNewSession,
  className,
}: {
  /** Keys the kept draft. */
  sessionId?: string;
  agentName?: string;
  model?: string | { id: string; speed?: string };
  running: boolean;
  /** It reports as running but has recorded nothing for a long time: do not say it "is working". */
  stalled?: boolean;
  sending: boolean;
  onSend: (text: string, files: File[]) => Promise<SendResult>;
  onStop: () => void;
  /** A quiet line inside the card: "Waiting for your approval above". */
  footer?: ReactNode;
  autoFocus?: boolean;
  /** Nothing has been said yet: the placeholder invites a first message. */
  empty?: boolean;
  /** The session takes no more messages: show why instead of a box. */
  closed?: ComposerClosed | null;
  /** Start a new session with this session's agent. */
  onNewSession?: () => void;
  className?: string;
}) {
  const [text, setText] = useState(() => readDraft(sessionId));
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  /** The last send did not go through. */
  const [problem, setProblem] = useState<Problem | null>(null);
  /** Files that were not attached, each with its reason. */
  const [refused, setRefused] = useState<Refusal[]>([]);
  const ref = useRef<ComposerHandle>(null);
  const filesRef = useRef(files);
  filesRef.current = files;
  const textRef = useRef(text);
  textRef.current = text;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const changeText = (next: string) => {
    setText(next);
    writeDraft(sessionId, next);
  };

  const add = (incoming: File[]) => {
    if (closed) return;
    const accepted: File[] = [];
    const turnedAway: Refusal[] = [];
    for (const f of incoming) {
      if (!f.type.startsWith("image/")) turnedAway.push({ name: f.name, why: "type", mediaType: f.type });
      else if (f.size > MAX_BYTES) turnedAway.push({ name: f.name, why: "size" });
      else if (filesRef.current.length + accepted.length >= MAX_FILES) turnedAway.push({ name: f.name, why: "count" });
      else accepted.push(f);
    }
    setRefused(turnedAway);
    if (accepted.length) setFiles((prev) => [...prev, ...accepted]);
  };
  const addRef = useRef(add);
  addRef.current = add;

  // Drop an image anywhere on the page, not only on the box.
  useEffect(() => {
    if (closed) return;
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
      ref.current?.focus();
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
      setDragging(false);
    };
  }, [closed]);

  const name = agentName ?? "the agent";

  // Whether a refused file is already in Files changes what to do with it.
  // Looked up only once one was refused; unknown, nothing is claimed.
  const refusedType = refused.some((r) => r.why === "type");
  const inFiles = useQuietQuery<{ data: Array<{ filename: string }>; has_more?: boolean }>(
    `/v1/files?limit=${FILES_LOOKUP}`,
    refusedType,
  );
  const filesKnown: FilesKnown | undefined = inFiles.data
    ? { names: inFiles.data.data.map((f) => f.filename), partial: !!inFiles.data.has_more || inFiles.data.data.length >= FILES_LOOKUP }
    : undefined;
  const advice = refusalAdvice({ refused, where: "session", files: filesKnown, maxFiles: MAX_FILES });

  /** Send `value` + `attached`. The box is emptied now and refilled if the server does not take them. */
  const deliver = async (value: string, attached: File[]) => {
    setText("");
    setFiles([]);
    setProblem(null);
    setRefused([]);
    // The draft stays in storage until the server has it.
    let result: SendResult;
    try {
      result = await onSend(value, attached);
    } catch (err) {
      result = { ok: false, stage: "send", reason: err instanceof Error ? failureSentence(err) : "Something went wrong before the message left." };
    }
    if (result.ok) {
      // Sent. What is kept from here on is whatever has been typed since.
      if (mounted.current) writeDraft(sessionId, textRef.current);
      else if (readDraft(sessionId) === value) writeDraft(sessionId, "");
      return;
    }
    if (!mounted.current) {
      // The person has left this session. Their words are kept for when
      // they come back, and they are told now rather than never.
      writeDraft(sessionId, value);
      toast.error(`Your message to ${name} was not sent. The text is kept in that session's message box.`);
      return;
    }
    // Back in the box: what was sent first, then anything typed since.
    setText((typed) => {
      const next = typed.trim() ? (value ? `${value}\n${typed}` : typed) : value;
      writeDraft(sessionId, next);
      return next;
    });
    setFiles((added) => [...attached, ...added]);
    setProblem(result);
    ref.current?.focus({ end: true });
  };

  const submit = () => void deliver(text, files);

  // ── closed: no box, a reason and a way forward ──
  if (closed) {
    return (
      <ClosedBar
        className={className}
        reason={closed}
        agentName={agentName}
        onNewSession={onNewSession}
        unsent={text.trim() ? text : ""}
      />
    );
  }

  const failedNames = problem?.stage === "upload" ? problem.failed.map((f) => f.file.name) : [];
  const failedSet = problem?.stage === "upload" ? new Set(problem.failed.map((f) => f.file)) : null;
  const survivors = failedSet ? files.filter((f) => !failedSet.has(f)) : files;
  const canSendWithout = !!failedSet && (text.trim().length > 0 || survivors.length > 0);

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
      {(problem || refused.length > 0) && (
        <div className="mb-2 space-y-2">
          {problem?.stage === "send" && (
            <ComposerNotice
              tone="danger"
              title="Your message was not sent"
              onDismiss={() => setProblem(null)}
              actions={
                <Button size="sm" variant="outline" onClick={submit} disabled={sending}>
                  Try again
                </Button>
              }
            >
              {problem.reason} Your message is back in the box below{files.length > 0 ? ", with its attachments" : ""}. Edit it or
              try again.
            </ComposerNotice>
          )}
          {problem?.stage === "upload" && (
            <ComposerNotice
              tone="danger"
              title={
                failedNames.length === 1
                  ? `${nameList(failedNames)} could not be uploaded, so nothing was sent`
                  : `${failedNames.length} attachments could not be uploaded, so nothing was sent`
              }
              onDismiss={() => setProblem(null)}
              actions={
                <>
                  <Button size="sm" variant="outline" onClick={submit} disabled={sending}>
                    Try again
                  </Button>
                  {canSendWithout && (
                    <Button size="sm" variant="ghost" onClick={() => void deliver(text, survivors)} disabled={sending}>
                      Send without {failedNames.length === 1 ? "it" : "them"}
                    </Button>
                  )}
                </>
              }
            >
              {failedNames.length > 1 && <>{nameList(failedNames)}. </>}
              {problem.failed[0]?.reason} Your message is back in the box below.
            </ComposerNotice>
          )}
          {refused.length > 0 && (
            <ComposerNotice
              tone="neutral"
              icon={FileXIcon}
              title={refusalTitle(refused, nameList)}
              onDismiss={() => setRefused([])}
              actions={
                advice.action?.kind === "new-session" && onNewSession ? (
                  <Button size="sm" variant="outline" onClick={onNewSession}>
                    Start a new session
                  </Button>
                ) : undefined
              }
            >
              <RefusalBody body={advice.body} />
            </ComposerNotice>
          )}
        </div>
      )}
      <div className="relative">
      <Composer
        ref={ref}
        size="md"
        value={text}
        onChange={changeText}
        onSubmit={submit}
        submitting={sending}
        running={running}
        onStop={onStop}
        autoFocus={autoFocus}
        aria-label={`Message ${name}`}
        placeholder={
          running
            ? stalled
              ? `${agentName ?? "The agent"} has gone quiet. Queue a follow-up…`
              : `${agentName ?? "The agent"} is working. Queue a follow-up…`
            : empty
              ? `Message ${name}…`
              : `Reply to ${name}…`
        }
        attachments={{
          files,
          onAdd: add,
          onRemove: (i) => {
            const removed = files[i];
            setFiles((prev) => prev.filter((_, idx) => idx !== i));
            // Taking out the attachment that failed settles that failure.
            if (problem?.stage === "upload" && removed) {
              const left = problem.failed.filter((f) => f.file !== removed);
              setProblem(left.length ? { ...problem, failed: left } : null);
            }
          },
          accept: "image/*",
        }}
        leading={model ? <ModelBadge model={model} variant="plain" className="ml-1 text-xs text-fg-subtle" /> : undefined}
        footer={footer}
        className={cn(dragging && "border-plum shadow-[var(--shadow-focus)]")}
      />
      {dragging && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 flex animate-fade-in items-center justify-center gap-2 rounded-2xl bg-bg-surface/90 text-small font-medium text-fg"
        >
          <ImagePlusIcon className="size-4 text-plum" />
          Drop images to attach them
        </div>
      )}
      </div>
    </div>
  );
}

const CLOSED: Record<ComposerClosed, { icon: typeof FlagIcon; title: string; body: string }> = {
  ended: {
    icon: FlagIcon,
    title: "This session has ended",
    body: "It cannot take new messages. Everything above is kept.",
  },
  archived: {
    icon: ArchiveIcon,
    title: "This session is archived",
    body: "It cannot take new messages. Its history is kept.",
  },
};

/**
 * Where the box would be, for a session that takes no more messages. It is
 * a flat band, not a raised card, so it does not read as something to type
 * in. If the person had words in the box when the session closed, they are
 * not thrown away: the band offers to copy them.
 */
function ClosedBar({
  reason,
  agentName,
  onNewSession,
  unsent,
  className,
}: {
  reason: ComposerClosed;
  agentName?: string;
  onNewSession?: () => void;
  /** Words that were in the box when the session closed. */
  unsent: string;
  className?: string;
}) {
  const c = CLOSED[reason];
  const { copied, copy } = useCopy();
  return (
    <div data-slot="composer-closed" className={cn("rounded-2xl bg-bg-soft", className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-3.5 pr-3.5 pl-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-bg-surface text-fg-muted shadow-[var(--shadow-xs)] dark:bg-bg-pressed">
          <c.icon className="size-4" />
        </span>
        <div className="min-w-[12rem] flex-1">
          <p className="text-small font-medium text-fg">{c.title}</p>
          <p className="text-small text-fg-muted">{c.body}</p>
        </div>
        {onNewSession && (
          <Button onClick={onNewSession} className="max-w-full">
            <PlusIcon data-icon="inline-start" />
            <span className="truncate">New session with {agentName ?? "this agent"}</span>
          </Button>
        )}
      </div>
      {unsent && (
        <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border py-2.5 pr-3.5 pl-4 text-small">
          <p className="min-w-0 flex-1 text-fg-muted">
            <span className="font-medium text-fg">Your unsent message is kept.</span> Copy it to use it in a new session.
            <span className="mt-1 line-clamp-2 break-words whitespace-pre-wrap text-fg-subtle">{unsent}</span>
          </p>
          <Button size="sm" variant="outline" onClick={() => void copy(unsent)}>
            {copied ? "Copied" : "Copy message"}
          </Button>
        </div>
      )}
    </div>
  );
}
