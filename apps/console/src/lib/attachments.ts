/**
 * Chat attachments — upload a picked file, hand it to the session, and
 * build the user.message that tells the agent about it.
 *
 * Two routes into the model:
 *   - images go inline as `image` content blocks (vision input);
 *   - every other file becomes a session file resource, which the runtime
 *     writes into the sandbox (`/mnt/session/uploads/<filename>`) before the
 *     turn runs. The agent can't see resources on its own, so the message
 *     carries a model-readable note listing the paths.
 *
 * The note rides in a SECOND text block: the chat bubble renders only the
 * first block, so the user sees their own words plus attachment chips
 * (from `metadata.attachments`) rather than the plumbing.
 */

/** Per-file ceiling — keep in step with the server default
 *  (DEFAULT_UPLOAD_MAX_BYTES in http-routes/files/upload.ts). */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

type Api = <T = unknown>(
  path: string,
  init?: RequestInit & { silentErrors?: boolean },
) => Promise<T>;

export interface UploadedFile {
  id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
}

/** One attachment as recorded on the user.message (`metadata.attachments`). */
export interface MessageAttachment {
  file_id: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  /** `image` → sent inline to the model; `file` → written to the sandbox. */
  kind: "image" | "file";
  /** Sandbox path for `kind: "file"`. */
  path?: string;
}

/** A specific file could not be uploaded / attached. The message names it
 *  so the composer can say which one instead of failing silently. */
export class AttachmentError extends Error {
  readonly filename: string;
  constructor(filename: string, reason: string) {
    super(`Couldn't attach "${filename}": ${reason}`);
    this.name = "AttachmentError";
    this.filename = filename;
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function isImageType(mediaType: string | undefined | null): boolean {
  return typeof mediaType === "string" && mediaType.startsWith("image/");
}

function reasonOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : "upload failed";
}

/** POST /v1/files (multipart). `scopeId` ties the file to a session so it
 *  shows in that session's Files panel and is cleaned up with it. */
export async function uploadFile(
  api: Api,
  file: File,
  opts: { scopeId?: string } = {},
): Promise<UploadedFile> {
  const fd = new FormData();
  fd.append("file", file);
  if (opts.scopeId) fd.append("scope_id", opts.scopeId);
  // Downloadable so the person who uploaded it can get it back from Files.
  fd.append("downloadable", "true");
  return api<UploadedFile>("/v1/files", { method: "POST", body: fd, silentErrors: true });
}

/**
 * Attach an uploaded file to the session as a file resource. Resolves with
 * the sandbox path once the runtime has written it — the server only
 * answers after the bytes are on disk, so a turn started next can read it.
 */
export async function attachFileToSession(
  api: Api,
  sessionId: string,
  file: UploadedFile,
): Promise<string> {
  const resource = await api<{ file_id?: string; mount_path?: string | null }>(
    `/v1/sessions/${sessionId}/resources`,
    {
      method: "POST",
      body: JSON.stringify({ type: "file", file_id: file.id }),
      silentErrors: true,
    },
  );
  if (typeof resource?.mount_path === "string" && resource.mount_path) return resource.mount_path;
  // Runtimes that mount lazily (Cloudflare) don't report a path; their
  // resource mounter's default is keyed by file id.
  return `/mnt/session/uploads/${file.id}`;
}

/**
 * Upload every file and make it reachable by the agent. All-or-nothing:
 * the first failure rejects with an AttachmentError naming the file, and
 * nothing is sent. `cache` (keyed by File identity) remembers files that
 * already made it, so retrying after a failure doesn't upload them twice.
 */
export async function prepareAttachments(
  api: Api,
  sessionId: string,
  files: File[],
  cache?: WeakMap<File, MessageAttachment>,
): Promise<MessageAttachment[]> {
  const out: MessageAttachment[] = [];
  for (const file of files) {
    const cached = cache?.get(file);
    if (cached) {
      out.push(cached);
      continue;
    }
    let attachment: MessageAttachment;
    try {
      const uploaded = await uploadFile(api, file, { scopeId: sessionId });
      const base = {
        file_id: uploaded.id,
        filename: uploaded.filename,
        media_type: uploaded.media_type,
        size_bytes: uploaded.size_bytes,
      };
      attachment = isImageType(uploaded.media_type)
        ? { ...base, kind: "image" }
        : { ...base, kind: "file", path: await attachFileToSession(api, sessionId, uploaded) };
    } catch (err) {
      throw new AttachmentError(file.name, reasonOf(err));
    }
    cache?.set(file, attachment);
    out.push(attachment);
  }
  return out;
}

/** The model-readable line(s) describing sandbox-mounted attachments.
 *  Empty string when there are none. */
export function buildAttachmentNote(attachments: MessageAttachment[]): string {
  const files = attachments.filter((a) => a.kind === "file" && a.path);
  if (files.length === 0) return "";
  const lines = files.map(
    (a) => `- ${a.path} (${a.filename}, ${a.media_type}, ${formatBytes(a.size_bytes)})`,
  );
  return [
    files.length === 1
      ? "[Attached file — the user attached this file to this message. It is saved in your sandbox at this path; read it from there:]"
      : "[Attached files — the user attached these files to this message. They are saved in your sandbox at these paths; read them from there:]",
    ...lines,
  ].join("\n");
}

type UserContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "file"; file_id: string } };

export interface UserMessageEventInput {
  type: "user.message";
  content: UserContentBlock[];
  metadata?: { attachments: MessageAttachment[] };
}

/** Label for a message that is only attachments (no typed text). */
export function attachmentsLabel(count: number): string {
  return count === 1 ? "Attached 1 file." : `Attached ${count} files.`;
}

/** Assemble the user.message event for typed text + prepared attachments. */
export function buildUserMessageEvent(
  text: string,
  attachments: MessageAttachment[],
): UserMessageEventInput {
  const content: UserContentBlock[] = [
    // First block is what the chat bubble shows.
    { type: "text", text: text || attachmentsLabel(attachments.length) },
  ];
  for (const a of attachments) {
    if (a.kind === "image") {
      content.push({ type: "image", source: { type: "file", file_id: a.file_id } });
    }
  }
  const note = buildAttachmentNote(attachments);
  if (note) content.push({ type: "text", text: note });
  return {
    type: "user.message",
    content,
    ...(attachments.length > 0 ? { metadata: { attachments } } : {}),
  };
}

/** Attachments recorded on a user.message event (empty when none). */
export function attachmentsOf(event: object): MessageAttachment[] {
  const metadata = (event as { metadata?: unknown }).metadata;
  const list = (metadata as { attachments?: unknown } | undefined)?.attachments;
  if (!Array.isArray(list)) return [];
  return list.filter(
    (a): a is MessageAttachment =>
      !!a && typeof a === "object" && typeof (a as MessageAttachment).filename === "string",
  );
}
