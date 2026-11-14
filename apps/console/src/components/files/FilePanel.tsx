import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { CopyIcon, DownloadIcon, EyeOffIcon, LockKeyholeIcon, Trash2Icon } from "lucide-react";
import type { FileRecord } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { copyText } from "@/lib/clipboard";
import { formatAbsolute, plural } from "@/lib/format";
import { sessionTitle } from "@/lib/sessions";
import type { SessionRecord } from "@/types/session";

import { AgentAvatar, EntityAvatar } from "../AgentAvatar";
import { CodeWell } from "../EventCard";
import { IdChip } from "../IdChip";
import { Markdown } from "../Markdown";
import { Property, PropertyList } from "../PropertyList";
import { ErrorState } from "../QueryProblem";
import { RelativeTime } from "../RelativeTime";
import { formatBytes } from "../resources/ResourceBits";
import { useQuietQuery } from "@/lib/useApiQuery";
import { RowActionsMenu } from "../RowActionsMenu";
import { Skeleton } from "../Skeleton";
import { PREVIEW_LIMIT, fetchFileContent, fileExtension, fileKind, parseDelimited, type FileKind } from "./files";

/**
 * A file, opened beside the list: what is in it, where it came from, and
 * the two things people do with a file (download it, delete it).
 *
 * The preview reads the file through the same content endpoint Download
 * uses, only for kinds that read well in a panel (Markdown, tables, text,
 * code, images) and only when the file is small enough to load whole.
 */
export function FilePanel({
  file,
  session,
  onClose,
  onDownload,
  onDelete,
}: {
  file: FileRecord | null;
  /** The session the file belongs to, when the list already knows it. */
  session?: SessionRecord;
  onClose: () => void;
  onDownload: (file: FileRecord) => void;
  onDelete: (file: FileRecord) => void;
}) {
  // Keep the last file while the panel slides out, so it does not empty mid-animation.
  const [shown, setShown] = useState<FileRecord | null>(file);
  useEffect(() => {
    if (file) setShown(file);
  }, [file]);
  const f = file ?? shown;
  const kind = f ? fileKind(f) : null;
  const locked = f?.downloadable === false;

  return (
    <Sheet open={!!file} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        className="gap-0 outline-none data-[side=right]:sm:max-w-[560px]"
        tabIndex={-1}
        // Start on the panel itself: focusing the first control would pop its tooltip over the title.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          (e.currentTarget as HTMLElement).focus();
        }}
      >
        {f && kind && (
          <>
            <SheetHeader className="pb-5">
              <div className="flex items-start gap-3.5">
                <EntityAvatar icon={kind.icon} size="lg" />
                <div className="min-w-0 flex-1">
                  <SheetTitle className="break-words">{f.filename}</SheetTitle>
                  <SheetDescription className="mt-1 text-small text-fg-muted">
                    {kind.label} · {formatBytes(f.size_bytes)}
                  </SheetDescription>
                </div>
              </div>
            </SheetHeader>

            <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 pb-6">
              <PanelGroup label="Preview">
                <FilePreview key={f.id} file={f} kind={kind} />
              </PanelGroup>

              <PanelGroup label="Details">
                {/* A narrow panel: a slimmer label column leaves the names room. */}
                <PropertyList labelWidth="narrow">
                  <Property label="Session">
                    <FileSession id={f.scope_id} session={session} />
                  </Property>
                  <Property label="Type">
                    <span className="font-mono text-xs text-fg-muted">{f.media_type || "Unknown"}</span>
                  </Property>
                  <Property label="Size">
                    <span title={`${f.size_bytes.toLocaleString()} bytes`}>{formatBytes(f.size_bytes)}</span>
                  </Property>
                  <Property label="Added">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <RelativeTime value={f.created_at} fallback="Not recorded" />
                      <span className="text-xs text-fg-subtle">{formatAbsolute(f.created_at)}</span>
                    </span>
                  </Property>
                  <Property label="File id">
                    <IdChip id={f.id} full label="Copy file id" />
                  </Property>
                </PropertyList>
              </PanelGroup>
            </div>

            <SheetFooter className="flex-row items-center gap-2 py-4">
              <Button disabled={locked} onClick={() => onDownload(f)}>
                <DownloadIcon data-icon="inline-start" />
                Download
              </Button>
              {locked && <span className="text-xs text-fg-muted">Kept for agents only</span>}
              <div className="ml-auto">
                <RowActionsMenu
                  label={`More actions for ${f.filename}`}
                  actions={[
                    { label: "Copy file id", icon: <CopyIcon />, onSelect: () => void copyText(f.id) },
                    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => onDelete(f) },
                  ]}
                />
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function PanelGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-fg-subtle">{label}</h3>
      {children}
    </section>
  );
}

/** The session a file belongs to, by title, with its agent's mark. */
export function FileSession({ id, session }: { id: string | null | undefined; session?: SessionRecord }) {
  if (!id) return <span className="text-fg-subtle">Not attached to a session</span>;
  return session ? <SessionLink session={session} /> : <LookedUpSession id={id} />;
}

function SessionLink({ session }: { session: SessionRecord }) {
  const title = sessionTitle(session);
  return (
    <Link
      to={`/sessions/${session.id}`}
      onClick={(e) => e.stopPropagation()}
      title={session.agent?.name ? `${title} · ${session.agent.name}` : title}
      className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm align-middle text-small-size font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
    >
      <AgentAvatar name={session.agent?.name} id={session.agent?.id} size="xs" />
      <span className="truncate">{title}</span>
    </Link>
  );
}

/**
 * A session the list did not include (older than the recent window, or
 * deleted since). Looked up quietly: a file that outlived its session is
 * normal, not an error worth a toast.
 */
function LookedUpSession({ id }: { id: string }) {
  const lookup = useQuietQuery<SessionRecord>(`/v1/sessions/${id}`);
  if (lookup.data) return <SessionLink session={lookup.data} />;
  if (lookup.isLoading) return <Skeleton className="inline-block h-4 w-36 align-middle" rounded="sm" />;
  return (
    <span className="text-fg-subtle" title={id}>
      {lookup.missing ? "Session no longer exists" : "Session unavailable"}
    </span>
  );
}

/** A quiet block that says why there is nothing to look at. */
function NoPreview({ icon: Icon, children }: { icon: typeof EyeOffIcon; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-bg-soft px-4 py-3.5 text-small text-fg-muted">
      <Icon className="size-4 shrink-0 text-fg-subtle" />
      <p>{children}</p>
    </div>
  );
}

function FilePreview({ file, kind }: { file: FileRecord; kind: FileKind }) {
  const isImage = kind.preview === "image";
  const tooLarge = file.size_bytes > (isImage ? PREVIEW_LIMIT.image : PREVIEW_LIMIT.text);
  const canLoad = file.downloadable !== false && kind.preview !== "none" && !tooLarge && file.size_bytes > 0;

  const query = useQuery({
    queryKey: ["file-content", file.id],
    queryFn: ({ signal }) => fetchFileContent(file.id, signal),
    enabled: canLoad,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // A Blob becomes either text or an object URL (revoked when the panel moves on).
  const [text, setText] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const blob = query.data;
    if (!blob) return;
    if (isImage) {
      const next = URL.createObjectURL(blob);
      setUrl(next);
      return () => URL.revokeObjectURL(next);
    }
    let live = true;
    void blob.text().then((value) => live && setText(value));
    return () => {
      live = false;
    };
  }, [query.data, isImage]);

  if (file.downloadable === false) {
    return <NoPreview icon={LockKeyholeIcon}>This file is kept for agents. It cannot be opened or downloaded from the console.</NoPreview>;
  }
  if (file.size_bytes === 0) return <NoPreview icon={EyeOffIcon}>This file is empty.</NoPreview>;
  if (kind.preview === "none") {
    return <NoPreview icon={EyeOffIcon}>There is no preview for this kind of file. Download it to open it.</NoPreview>;
  }
  if (tooLarge) {
    return (
      <NoPreview icon={EyeOffIcon}>
        At {formatBytes(file.size_bytes)} this file is too large to preview. Download it to open it.
      </NoPreview>
    );
  }
  if (query.error) {
    return <ErrorState compact title="The file could not be opened" error={query.error} retry={() => void query.refetch()} />;
  }
  if (isImage) {
    return url ? (
      <div className="flex justify-center rounded-lg border border-border bg-bg-inset p-3">
        <img src={url} alt={file.filename} className="max-h-[420px] max-w-full rounded-md object-contain" />
      </div>
    ) : (
      <Skeleton className="h-56 w-full" rounded="lg" />
    );
  }
  if (text === null) {
    return (
      <div className="space-y-2 rounded-lg border border-border bg-bg-surface p-4" aria-hidden="true">
        <Skeleton className="h-3.5 w-2/5" rounded="sm" />
        <Skeleton className="h-3.5 w-full" rounded="sm" />
        <Skeleton className="h-3.5 w-11/12" rounded="sm" />
        <Skeleton className="h-3.5 w-3/5" rounded="sm" />
      </div>
    );
  }
  if (kind.preview === "markdown") {
    return (
      <div className="max-h-[460px] overflow-y-auto rounded-lg border border-border bg-bg-surface px-4 py-3.5 text-small leading-relaxed text-fg dark:bg-bg-inset [&_h1]:text-h3 [&_h2]:text-h3 [&_h3]:text-sm [&_h3]:font-semibold">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  if (kind.preview === "table") {
    return <TablePreview text={text} delimiter={fileExtension(file.filename) === "tsv" ? "\t" : ","} />;
  }
  return <CodeWell className="max-h-[460px]">{kind.preview === "code" ? prettyJson(text, file) : text}</CodeWell>;
}

/** JSON reads better indented; anything that does not parse is shown as written. */
function prettyJson(text: string, file: FileRecord): string {
  if (fileExtension(file.filename) !== "json" && file.media_type !== "application/json") return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

const TABLE_ROWS = 100;

/** The first rows of a CSV as a real table: first row as the header, numbers right-aligned. */
function TablePreview({ text, delimiter }: { text: string; delimiter: "," | "\t" }) {
  const { rows, total } = useMemo(() => parseDelimited(text, delimiter, TABLE_ROWS + 1), [text, delimiter]);
  if (rows.length === 0) return <NoPreview icon={EyeOffIcon}>This file has no rows.</NoPreview>;
  const [head, ...body] = rows;
  const width = Math.max(...rows.map((r) => r.length));
  const numeric = Array.from({ length: width }, (_, c) => {
    const cells = body.map((r) => r[c] ?? "").filter((v) => v !== "");
    return cells.length > 0 && cells.every((v) => /^-?[\d,]*\.?\d+%?$/.test(v.trim()));
  });
  const more = total - 1 - body.length;
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-bg-surface dark:bg-bg-inset">
      <div className="max-h-[460px] overflow-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr>
              {Array.from({ length: width }, (_, c) => (
                <th
                  key={c}
                  scope="col"
                  className={`sticky top-0 border-b border-border bg-bg-inset px-3 py-2 font-medium whitespace-nowrap text-fg-subtle ${
                    numeric[c] ? "text-right" : "text-left"
                  }`}
                >
                  {head[c] || `Column ${c + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, r) => (
              <tr key={r} className="border-b border-border last:border-b-0">
                {Array.from({ length: width }, (_, c) => (
                  <td
                    key={c}
                    title={(row[c] ?? "").length > 28 ? row[c] : undefined}
                    className={`max-w-56 truncate px-3 py-2 whitespace-nowrap text-fg ${numeric[c] ? "text-right" : "text-left"}`}
                  >
                    {row[c] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="border-t border-border bg-bg-inset/60 px-3 py-2 text-xs text-fg-subtle">
        {more > 0
          ? `Showing the first ${body.length} of ${(total - 1).toLocaleString()} rows`
          : `${plural(body.length, "row")}, ${plural(width, "column")}`}
      </p>
    </div>
  );
}
