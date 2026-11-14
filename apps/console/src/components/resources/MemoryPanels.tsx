import { useState } from "react";
import { FileTextIcon, HistoryIcon, PencilIcon, Trash2Icon } from "lucide-react";

import { useApi } from "@/lib/api";
import { useQueryClient } from "@/lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";

import { EntityAvatar } from "../AgentAvatar";
import { Chip, StatusBadge } from "../Badge";
import { Callout } from "../Callout";
import { ConfirmDialog } from "../ConfirmDialog";
import { EntityRef } from "../EntityRef";
import { CodeWell } from "../EventCard";
import { Field } from "../Field";
import { CopyButton } from "../IdChip";
import { Markdown } from "../Markdown";
import { Modal } from "../Modal";
import { RelativeTime } from "../RelativeTime";
import { SegmentedControl } from "../SegmentedControl";
import { Skeleton, SkeletonText } from "../Skeleton";
import { baseName, type Memory, type MemoryListItem, type MemoryVersion } from "./memory";
import { errorMessage, formatBytes } from "./ResourceBits";
import { useQuietQuery } from "@/lib/useApiQuery";

const MONO = "font-mono text-small-size md:text-small-size";

// ── Shared: who and what ────────────────────────────────────────────

const OPERATION: Record<MemoryVersion["operation"], { label: string; tone: "success" | "info" | "neutral" }> = {
  created: { label: "Created", tone: "success" },
  modified: { label: "Edited", tone: "info" },
  deleted: { label: "Deleted", tone: "neutral" },
};

/** What happened to an entry, as a dot badge. A redacted version says so. */
export function OperationBadge({ version }: { version: Pick<MemoryVersion, "operation" | "redacted"> }) {
  const op = OPERATION[version.operation] ?? { label: version.operation, tone: "neutral" as const };
  return (
    <span className="inline-flex items-center gap-2">
      <StatusBadge status={version.operation} label={op.label} tone={op.tone} />
      {version.redacted && <Chip tone="outline">Redacted</Chip>}
    </span>
  );
}

/** Who wrote a version: a person, an agent's session, an API key or the system. */
export function Actor({ actor }: { actor: MemoryVersion["actor"] | undefined }) {
  if (!actor) return <span className="text-fg-subtle">Unknown</span>;
  if (actor.type === "agent_session") return <EntityRef kind="session" id={actor.id} />;
  const label =
    actor.type === "user" ? "A person" : actor.type === "api_key" ? "An API key" : actor.type === "system" ? "System" : actor.type;
  return (
    <span className="text-fg-muted" title={actor.id}>
      {label}
    </span>
  );
}

// ── New entry ───────────────────────────────────────────────────────

/** Create an entry. `not_exists` precondition: it never overwrites a path that is already there. */
export function WriteMemoryDialog({
  storeId,
  open,
  onClose,
  onSaved,
}: {
  storeId: string;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { api } = useApi();
  const [path, setPath] = useState("/");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPath("/");
    setContent("");
    setError(null);
  };
  const close = () => {
    if (saving) return;
    onClose();
    reset();
  };
  const valid = path.trim().length > 1;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api(`/v1/memory_stores/${storeId}/memories`, {
        method: "POST",
        body: JSON.stringify({ path: path.trim(), content, precondition: { type: "not_exists" } }),
        silentErrors: true,
      });
      onSaved();
      onClose();
      reset();
    } catch (e) {
      setError(errorMessage(e, "The entry could not be created"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="New entry"
      subtitle="A file in this store. Agents with the store attached can read it straight away."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!valid} loading={saving}>
            Create entry
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Callout tone="danger">{error}</Callout>}
        <Field label="Path" hint="Folders are created from the path. It must not exist yet.">
          <Input
            value={path}
            onChange={(e) => setPath(e.target.value)}
            placeholder="/preferences/formatting.md"
            autoComplete="off"
            spellCheck={false}
            autoFocus
            className={MONO}
          />
        </Field>
        <Field label="Content" hint="Plain text or Markdown, up to 100 KB.">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={12}
            placeholder={"# Formatting\n\nPrefer short paragraphs. Dates as 2026-11-10."}
            className={`max-h-[46vh] min-h-56 ${MONO}`}
          />
        </Field>
      </div>
    </Modal>
  );
}

// ── Entry panel ─────────────────────────────────────────────────────

/**
 * One entry, opened beside the list: read it (rendered or as source),
 * edit its path and content, see every version of it, roll back to one,
 * redact one, or delete it.
 *
 * Writes carry a content hash as a precondition, so an edit never
 * silently overwrites a change an agent made in the meantime.
 */
export function MemoryEntrySheet({
  storeId,
  item,
  archived,
  onClose,
  onChanged,
}: {
  storeId: string;
  item: MemoryListItem | null;
  archived: boolean;
  onClose: () => void;
  /** The entry changed or was deleted: refresh the list. */
  onChanged: () => void;
}) {
  return (
    <Sheet open={!!item} onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        className="w-full gap-0 p-0 data-[side=right]:sm:max-w-[640px]"
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement | null)?.focus?.();
        }}
        tabIndex={-1}
      >
        {item && (
          <EntryBody key={item.id} storeId={storeId} item={item} archived={archived} onClose={onClose} onChanged={onChanged} />
        )}
      </SheetContent>
    </Sheet>
  );
}

function EntryBody({
  storeId,
  item,
  archived,
  onClose,
  onChanged,
}: {
  storeId: string;
  item: MemoryListItem;
  archived: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const base = `/v1/memory_stores/${storeId}`;

  const entry = useQuietQuery<Memory>(`${base}/memories/${item.id}`);
  const memory = entry.data;
  const isMarkdown = /\.(md|markdown)$/i.test(item.path);

  const [view, setView] = useState<"preview" | "source">(isMarkdown ? "preview" : "source");
  const [editing, setEditing] = useState(false);
  const [path, setPath] = useState(item.path);
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [confirm, setConfirm] = useState<
    { kind: "delete" } | { kind: "rollback"; version: MemoryVersion } | { kind: "redact"; version: MemoryVersion } | null
  >(null);

  // Per-entry history. Not every runtime records versions.
  const versions = useQuietQuery<{ data: MemoryVersion[] }>(
    `${base}/memory_versions?memory_id=${item.id}`,
    showHistory,
  );

  const refreshAll = async () => {
    onChanged();
    await queryClient.invalidateQueries({ queryKey: ["quiet"] });
  };

  const startEdit = () => {
    if (!memory) return;
    setPath(memory.path);
    setContent(memory.content);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (!memory) return;
    setSaving(true);
    setError(null);
    try {
      await api(`${base}/memories/${memory.id}`, {
        method: "POST",
        body: JSON.stringify({
          path: path !== memory.path ? path : undefined,
          content: content !== memory.content ? content : undefined,
          // Refuse to overwrite if someone else wrote since this was read.
          precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
        }),
        silentErrors: true,
      });
      setEditing(false);
      await refreshAll();
    } catch (e) {
      setError(errorMessage(e, "The entry could not be saved"));
    } finally {
      setSaving(false);
    }
  };

  const sha = memory?.content_sha256 ?? item.content_sha256;
  // After a rename the list row is stale; the loaded entry knows its path.
  const currentPath = memory?.path ?? item.path;
  const list = versions.data?.data ?? [];

  return (
    <>
      <SheetHeader className="flex-row items-start gap-4 pb-4">
        <EntityAvatar icon={FileTextIcon} size="lg" />
        <div className="min-w-0 flex-1">
          <SheetTitle className="truncate" title={currentPath}>
            {baseName(currentPath)}
          </SheetTitle>
          <SheetDescription className="mt-0.5 truncate font-mono text-xs" title={currentPath}>
            {currentPath}
          </SheetDescription>
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5 text-xs text-fg-subtle">
            <Chip>{formatBytes(memory?.size_bytes ?? item.size_bytes)}</Chip>
            <span>
              Updated <RelativeTime value={memory?.updated_at ?? item.updated_at} />
            </span>
            <span aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-0.5 font-mono text-micro-size" title={`sha256 ${sha}`}>
              {sha.slice(0, 10)}…
              <CopyButton value={sha} label="Copy sha256" className="size-5" />
            </span>
          </div>
        </div>
      </SheetHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6">
        {error && <Callout tone="danger">{error}</Callout>}

        {entry.error ? (
          <Callout tone="danger" title="This entry could not be loaded">
            {errorMessage(entry.error)}
          </Callout>
        ) : !memory ? (
          <SkeletonText lines={8} />
        ) : editing ? (
          <div className="space-y-5">
            <Field label="Path">
              <Input value={path} onChange={(e) => setPath(e.target.value)} spellCheck={false} autoComplete="off" className={MONO} />
            </Field>
            <Field label="Content">
              <Textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={18}
                aria-label="Memory content"
                className={`max-h-[56vh] min-h-72 ${MONO}`}
              />
            </Field>
          </div>
        ) : (
          <section>
            <div className="mb-2 flex h-8 items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-fg-subtle">Content</h3>
              <div className="flex items-center gap-1">
                <CopyButton value={memory.content} label="Copy content" />
                {isMarkdown && (
                  <SegmentedControl<"preview" | "source">
                    label="View"
                    size="sm"
                    value={view}
                    onChange={setView}
                    options={[
                      { value: "preview", label: "Preview" },
                      { value: "source", label: "Source" },
                    ]}
                  />
                )}
              </div>
            </div>
            {!memory.content ? (
              <p className="rounded-lg bg-bg-soft px-4 py-6 text-center text-small text-fg-subtle">This entry is empty.</p>
            ) : view === "preview" && isMarkdown ? (
              <div className="rounded-lg border border-border bg-bg-surface px-5 py-4 text-prose text-fg dark:bg-bg-inset">
                <Markdown>{memory.content}</Markdown>
              </div>
            ) : (
              <CodeWell className="max-h-[56vh]">{memory.content}</CodeWell>
            )}
          </section>
        )}

        {!editing && (
          <section>
            <div className="mb-2 flex h-8 items-center justify-between gap-3">
              <h3 className="text-xs font-medium text-fg-subtle">Versions</h3>
              <Button variant="ghost" size="xs" onClick={() => setShowHistory((s) => !s)} aria-expanded={showHistory}>
                <HistoryIcon data-icon="inline-start" />
                {showHistory ? "Hide" : "Show"} version history
              </Button>
            </div>
            {showHistory &&
              (versions.isLoading ? (
                <Skeleton className="h-20 w-full" rounded="lg" />
              ) : versions.missing ? (
                <p className="rounded-lg bg-bg-soft px-4 py-3 text-small text-fg-muted">
                  This server does not keep a version history for memory entries.
                </p>
              ) : versions.error ? (
                <Callout tone="danger" title="The history could not be loaded">
                  {errorMessage(versions.error)}
                </Callout>
              ) : list.length === 0 ? (
                <p className="rounded-lg bg-bg-soft px-4 py-3 text-small text-fg-muted">No versions recorded yet.</p>
              ) : (
                <ul className="overflow-hidden rounded-lg border border-border">
                  {list.map((v) => {
                    const head = !!v.content_sha256 && v.content_sha256 === sha;
                    const hasContent = v.content !== undefined && v.content !== null;
                    return (
                      <li key={v.id} className="flex min-h-12 items-center gap-3 border-t border-border px-3.5 py-2 first:border-t-0">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <OperationBadge version={v} />
                            {head && <Chip tone="success">Current</Chip>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
                            <Actor actor={v.actor} />
                            <span aria-hidden="true">·</span>
                            <RelativeTime value={v.created_at} />
                          </div>
                        </div>
                        {!archived && !v.redacted && !head && (
                          <div className="flex shrink-0 items-center gap-1">
                            {hasContent && (
                              <Button variant="ghost" size="xs" onClick={() => setConfirm({ kind: "rollback", version: v })}>
                                Roll back
                              </Button>
                            )}
                            <Button variant="ghost" size="xs" onClick={() => setConfirm({ kind: "redact", version: v })}>
                              Redact
                            </Button>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              ))}
          </section>
        )}
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-border bg-bg-inset/60 px-6 py-3.5">
        {editing ? (
          <>
            <p className="min-w-0 truncate text-xs text-fg-subtle">Saving is refused if the entry changed while you were editing.</p>
            <div className="flex shrink-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => void save()} loading={saving} disabled={!path.trim()}>
                Save
              </Button>
            </div>
          </>
        ) : archived ? (
          <p className="text-xs text-fg-subtle">This store is archived, so its entries are read-only.</p>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirm({ kind: "delete" })} disabled={!memory}>
              <Trash2Icon data-icon="inline-start" />
              Delete memory
            </Button>
            <Button variant="outline" size="sm" onClick={startEdit} disabled={!memory}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
          </>
        )}
      </div>

      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        destructive={confirm?.kind !== "rollback"}
        title={
          confirm?.kind === "delete"
            ? `Delete ${baseName(currentPath)}?`
            : confirm?.kind === "rollback"
              ? "Roll back to this version?"
              : "Redact this version?"
        }
        body={
          confirm?.kind === "delete"
            ? "The entry is removed from the store, so agents no longer see it. Its history is kept for audit."
            : confirm?.kind === "rollback"
              ? "A new version is written with the content of the older one. Nothing is lost: the current content stays in the history."
              : "The content of this version is wiped for good. The record that it existed stays in the history."
        }
        confirmLabel={confirm?.kind === "delete" ? "Delete memory" : confirm?.kind === "rollback" ? "Roll back" : "Redact version"}
        onConfirm={async () => {
          if (!confirm || !memory) return;
          if (confirm.kind === "delete") {
            await api(`${base}/memories/${memory.id}?expected_content_sha256=${memory.content_sha256}`, { method: "DELETE" });
            onChanged();
            onClose();
          } else if (confirm.kind === "rollback") {
            await api(`${base}/memories/${memory.id}`, {
              method: "POST",
              body: JSON.stringify({
                content: confirm.version.content,
                // Checked against the current head, so a concurrent write is not clobbered.
                precondition: { type: "content_sha256", content_sha256: memory.content_sha256 },
              }),
            });
            await refreshAll();
          } else {
            await api(`${base}/memory_versions/${confirm.version.id}/redact`, { method: "POST" });
            await refreshAll();
          }
        }}
      />
    </>
  );
}
