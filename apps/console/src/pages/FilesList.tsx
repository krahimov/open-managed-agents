/**
 * Files: everything agents wrote and everything they were given.
 *
 * A file browser, not a table of ids: each row leads with what the file is
 * (a type mark and its name), says which conversation it belongs to, how
 * big it is and when it arrived. A row opens the file beside the list with
 * a preview; Download and Delete are in the row menu and in that panel.
 *
 * GET /v1/files follows the Anthropic Files API shape: `before_id` as the
 * cursor and `has_more` on the page. The Session filter is the server's
 * `scope_id`; the search narrows the files loaded so far, because the
 * endpoint has no name filter. Pages are large (1000): the Node server
 * ignores the cursor and always answers `has_more: false`, so a small page
 * would be all the list ever showed.
 *
 * Upload puts files in Files (POST /v1/files, the same call the message
 * box makes), in the session the list is filtered to when it is; from
 * there a file can be mounted in a new session's Options.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { CopyIcon, DownloadIcon, EyeIcon, Trash2Icon, UploadIcon } from "lucide-react";
import { toast } from "sonner";
import type { FileRecord } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";
import { PopoverContent } from "@/components/ui/popover";
import {
  AgentAvatar,
  ConfirmDialog,
  DataTable,
  EntityAvatar,
  FacetedFilter,
  FilterChip,
  RelativeTime,
  RowActionsMenu,
  Skeleton,
  Tip,
  type ColumnDef,
} from "@/components/kit";
import { FilePanel } from "@/components/files/FilePanel";
import { MAX_ATTACHMENT_MEGABYTES } from "@/components/files/refusal";
import { OverflowTip } from "@/components/OverflowTip";
import { downloadFile, fileKind } from "@/components/files/files";
import { ResourceIdentity, formatBytes } from "@/components/resources/ResourceBits";
import { ResourceListError } from "@/components/resources/ResourceListError";
import { useApi } from "@/lib/api";
import { MAX_ATTACHMENT_BYTES, uploadFile } from "@/lib/attachments";
import { copyText } from "@/lib/clipboard";
import { countWords, plural, toDate } from "@/lib/format";
import { sessionTitle } from "@/lib/sessions";
import { useApiQuery, useInfiniteApiQuery, useQuietQuery } from "@/lib/useApiQuery";
import type { SessionRecord as Session } from "@/types/session";
import { withReason } from "@/lib/failure-text";

interface ListResponse {
  data: FileRecord[];
  has_more?: boolean;
}

const ALL_SESSIONS = "";
const SUBTITLE = "What your agents wrote and what they were given, kept with the session it belongs to.";

/**
 * The session a file belongs to, by title, with its agent's mark. A link
 * to that session; while the title is cut, the whole of it (and the
 * agent's name) is shown on hover and on keyboard focus. A session the
 * list did not include (older than the recent window, or deleted since) is
 * looked up quietly: a file that outlived its session is normal.
 */
function SessionCell({ id, session }: { id: string; session?: Session }) {
  const lookup = useQuietQuery<Session>(session ? null : `/v1/sessions/${id}`);
  const found = session ?? lookup.data;
  if (!found) {
    if (lookup.isLoading) return <Skeleton className="inline-block h-4 w-36 align-middle" rounded="sm" />;
    return <span className="text-fg-subtle">{lookup.missing ? "Session no longer exists" : "Session unavailable"}</span>;
  }
  const title = sessionTitle(found);
  return (
    <OverflowTip label={found.agent?.name ? `${title} · ${found.agent.name}` : title}>
      <Link
        to={`/sessions/${found.id}`}
        className="inline-flex max-w-full min-w-0 items-center gap-2 rounded-sm align-middle font-medium text-fg decoration-border-strong underline-offset-4 hover:underline"
      >
        <AgentAvatar name={found.agent?.name} id={found.agent?.id} size="xs" />
        <span className="truncate">{title}</span>
      </Link>
    </OverflowTip>
  );
}

/**
 * A file's leading mark is its type, said the way people say it: the
 * extension ("csv", "md", "json"). Down a list it tells the rows apart at
 * a glance, which an outline of a sheet of paper on every row does not.
 * A file with no short extension keeps its kind's icon.
 */
function FileTypeTile({ file }: { file: FileRecord }) {
  const ext = /\.([a-z0-9]{1,4})$/i.exec(file.filename)?.[1]?.toLowerCase();
  if (!ext) return <EntityAvatar icon={fileKind(file).icon} size="md" />;
  return (
    <EntityAvatar size="md">
      <span className="text-micro font-medium tracking-tight text-fg-muted">{ext}</span>
    </EntityAvatar>
  );
}

export function FilesList() {
  const { api } = useApi();
  const [sessionId, setSessionId] = useState<string>(ALL_SESSIONS);
  const [search, setSearch] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<FileRecord | null>(null);

  const params = useMemo(() => ({ scope_id: sessionId || undefined }), [sessionId]);
  const {
    items,
    isLoading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh,
    error,
  } = useInfiniteApiQuery<FileRecord>("/v1/files", {
    limit: 1000,
    params,
    cursorParam: "before_id",
    getNextCursor: (res) => {
      const page = res as ListResponse;
      return page.has_more ? page.data[page.data.length - 1]?.id : undefined;
    },
  });

  // The sessions a file can belong to: names for the Session column and the
  // options of its filter. One read of the most recent 200.
  const { data: sessionsRes } = useApiQuery<{ data: Session[] }>("/v1/sessions", { limit: "200" });
  const sessions = useMemo(() => sessionsRes?.data ?? [], [sessionsRes]);
  const sessionById = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  const sessionOptions = useMemo(
    () => [{ value: ALL_SESSIONS, label: "All sessions" }, ...sessions.map((s) => ({ value: s.id, label: sessionTitle(s) }))],
    [sessions],
  );
  const pickedSession = sessionId ? sessionById.get(sessionId) : undefined;

  const download = useCallback(async (file: FileRecord) => {
    try {
      await downloadFile(file);
    } catch (e) {
      toast.error(withReason(`${file.filename} could not be downloaded`, e));
    }
  }, []);

  // ── upload ──
  const picker = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const upload = async (picked: File[]) => {
    if (picked.length === 0) return;
    setUploading(true);
    let done = 0;
    for (const file of picked) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        toast.error(`“${file.name}” was not uploaded. A file can be up to ${MAX_ATTACHMENT_MEGABYTES} MB.`);
        continue;
      }
      try {
        await uploadFile(api, file, { scopeId: sessionId || undefined });
        done += 1;
      } catch (e) {
        toast.error(withReason(`“${file.name}” could not be uploaded`, e));
      }
    }
    setUploading(false);
    if (done > 0) {
      toast.success(done === 1 ? "File uploaded" : `${done} files uploaded`);
      refresh();
    }
  };
  const uploadButton = (
    <>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        aria-label="Choose files to upload"
        onChange={(e) => {
          const picked = Array.from(e.currentTarget.files ?? []);
          // Reset, so choosing the same file again still counts.
          e.currentTarget.value = "";
          void upload(picked);
        }}
      />
      <Tip label={pickedSession ? `Into ${sessionTitle(pickedSession)}` : "Up to 25 MB each"}>
        <Button onClick={() => picker.current?.click()} loading={uploading} loadingLabel="Uploading…">
          <UploadIcon data-icon="inline-start" />
          Upload
        </Button>
      </Tip>
    </>
  );

  const query = search.trim().toLowerCase();
  const rows = useMemo(() => (query ? items.filter((f) => f.filename.toLowerCase().includes(query)) : items), [items, query]);
  const open = openId ? (items.find((f) => f.id === openId) ?? null) : null;

  const columns = useMemo<ColumnDef<FileRecord>[]>(
    () => [
      {
        id: "file",
        accessorKey: "filename",
        header: "File",
        size: 360,
        minSize: 240,
        enableHiding: false,
        enableSorting: true,
        cell: ({ row }) => {
          const file = row.original;
          const kind = fileKind(file);
          return (
            <ResourceIdentity
              avatar={<FileTypeTile file={file} />}
              name={file.filename}
              secondary={`${kind.label}${file.downloadable === false ? " · kept for agents" : ""}`}
              secondaryTitle={`${kind.label}${file.media_type ? ` (${file.media_type})` : ""}${file.downloadable === false ? " · kept for agents" : ""}`}
            />
          );
        },
      },
      {
        id: "session",
        header: "Session",
        size: 380,
        minSize: 200,
        cell: ({ row }) =>
          row.original.scope_id ? (
            <SessionCell id={row.original.scope_id} session={sessionById.get(row.original.scope_id)} />
          ) : (
            <span className="text-fg-subtle">No session</span>
          ),
      },
      {
        id: "size",
        accessorKey: "size_bytes",
        header: "Size",
        size: 110,
        enableSorting: true,
        sortDescFirst: true,
        // Also in the file's panel: it gives way before the table scrolls sideways.
        meta: { align: "right", hideBelow: 720 },
        cell: ({ row }) => (
          <Tip label={`${row.original.size_bytes.toLocaleString()} bytes`}>
            <span className="text-fg-muted">{formatBytes(row.original.size_bytes)}</span>
          </Tip>
        ),
      },
      {
        id: "added",
        accessorFn: (f) => toDate(f.created_at)?.getTime(),
        header: "Added",
        size: 130,
        enableSorting: true,
        sortDescFirst: true,
        cell: ({ row }) => <RelativeTime value={row.original.created_at} className="text-fg-muted" fallback="Not recorded" />,
      },
      {
        id: "actions",
        header: "",
        size: 56,
        enableHiding: false,
        cell: ({ row }) => {
          const file = row.original;
          return (
            <RowActionsMenu
              label={`Actions for ${file.filename}`}
              actions={[
                { label: "Open", icon: <EyeIcon />, onSelect: () => setOpenId(file.id) },
                {
                  label: "Download",
                  icon: <DownloadIcon />,
                  disabled: file.downloadable === false,
                  onSelect: () => void download(file),
                },
                { label: "Copy file id", icon: <CopyIcon />, onSelect: () => void copyText(file.id) },
                { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setDeleting(file) },
              ]}
            />
          );
        },
      },
    ],
    [sessionById, download],
  );

  if (error && items.length === 0) {
    return <ResourceListError title="Files" subtitle={SUBTITLE} what="Files" error={error} retry={refresh} />;
  }

  const totalBytes = rows.reduce((sum, f) => sum + (f.size_bytes || 0), 0);
  const summary = isLoading
    ? undefined
    : query
      ? `${rows.length.toLocaleString()} of ${plural(items.length, "file")}${hasMore ? " loaded" : ""}`
      : rows.length > 0
        ? `${countWords(rows.length, hasMore, "file")} · ${formatBytes(totalBytes)}`
        : undefined;

  const filters = (
    <FilterChip
      label="Session"
      active={sessionId !== ALL_SESSIONS}
      display={sessionId ? (pickedSession ? sessionTitle(pickedSession) : "One session") : undefined}
      onClear={() => setSessionId(ALL_SESSIONS)}
    >
      <PopoverContent align="start" sideOffset={4} collisionPadding={8} className="w-96 p-0">
        <FacetedFilter options={sessionOptions} value={sessionId} onValueChange={setSessionId} searchPlaceholder="Search sessions" />
      </PopoverContent>
    </FilterChip>
  );

  const empty = query
    ? {
        title: `No files match “${search.trim()}”`,
        body: hasMore ? "Only the files loaded so far were searched. Clear the search to keep loading." : "Check the spelling, or clear the search.",
        action: (
          <Button variant="outline" onClick={() => setSearch("")}>
            Clear search
          </Button>
        ),
      }
    : sessionId
      ? {
          title: "No files in this session",
          body: "This session has not saved or been given any files.",
          action: (
            <Button variant="outline" onClick={() => setSessionId(ALL_SESSIONS)}>
              Clear filter
            </Button>
          ),
        }
      : {
          title: "No files yet",
          body: "Files show up here when an agent saves its work or someone attaches a file to a message. Upload one to mount it in a new session's Options.",
          action: undefined,
        };

  return (
    <DataTable<FileRecord>
      title="Files"
      subtitle={SUBTITLE}
      headerActions={uploadButton}
      searchPlaceholder="Search files"
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      summary={summary}
      columns={columns}
      data={rows}
      getRowId={(f) => f.id}
      onRowClick={(f) => setOpenId(f.id)}
      loading={isLoading}
      hasMore={hasMore && !query}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyKind="file"
      emptyTitle={empty.title}
      emptySubtitle={empty.body}
      emptyAction={empty.action}
    >
      <FilePanel
        file={open}
        session={open?.scope_id ? sessionById.get(open.scope_id) : undefined}
        onClose={() => setOpenId(null)}
        onDownload={(f) => void download(f)}
        onDelete={setDeleting}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        title={`Delete ${deleting?.filename ?? "this file"}?`}
        body="The file and its contents are removed for good. Sessions that used it keep their history, but can no longer open it. This cannot be undone."
        confirmLabel="Delete file"
        destructive
        onConfirm={async () => {
          if (!deleting) return;
          await api(`/v1/files/${deleting.id}`, { method: "DELETE" });
          if (openId === deleting.id) setOpenId(null);
          toast.success("File deleted");
          refresh();
        }}
      />
    </DataTable>
  );
}
