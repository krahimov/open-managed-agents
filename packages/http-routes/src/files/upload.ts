// POST /v1/files — shared upload handler.
//
// CF (apps/main/src/routes/files.ts) and Node (apps/main-node) both call
// `handleFileUpload` so the wire contract can't drift between runtimes:
//
//   multipart/form-data   file=<blob>  [scope_id=<session id>]  [downloadable=true|1]
//   application/json      { filename, content, media_type?, scope_id?,
//                           encoding?: "base64" | "utf8", downloadable? }
//
//   201 → FileRecord ({ id, type:"file", filename, media_type, size_bytes,
//                       scope_id?, downloadable, created_at })
//   400 → missing/invalid field, bad filename, unparseable body
//   404 → scope_id names a session this tenant doesn't own
//   413 → file larger than the limit
//
// Runtime-specific gates stay with the caller: CF runs its per-tenant upload
// rate limit first; Node wraps the route in hono's bodyLimit so an oversized
// chunked body is cut off while streaming rather than after buffering.

import {
  fileR2Key,
  generateFileId,
  guessSessionOutputMime,
} from "@open-managed-agents/shared";
import type { BlobStore } from "@open-managed-agents/blob-store";

/** Default per-file ceiling. Matches the console composer's client-side
 *  limit and the CF `checkUploadSize` default; override with UPLOAD_MAX_BYTES. */
export const DEFAULT_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/** Longest filename we store (bytes are what filesystems count, but a
 *  character cap is the contract the Anthropic Files API documents). */
export const MAX_UPLOAD_FILENAME_LENGTH = 255;

/** Resolve the effective upload ceiling from an env-style value. */
export function resolveUploadMaxBytes(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_UPLOAD_MAX_BYTES;
}

/**
 * Validate an uploaded filename. The name is later used as the last path
 * segment of the sandbox mount (`/mnt/session/uploads/<filename>`) and in
 * download headers, so anything that could steer a path is rejected rather
 * than silently rewritten — the caller learns their name was unusable.
 *
 * Returns the trimmed filename, or null when it is unusable.
 */
export function sanitizeUploadFilename(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  if (name.length === 0 || name.length > MAX_UPLOAD_FILENAME_LENGTH) return null;
  if (name === "." || name === "..") return null;
  // Path separators (either flavour) and control chars incl. NUL.
  // eslint-disable-next-line no-control-regex
  if (/[\\/\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

/**
 * Normalise a client-supplied media type. Browsers send "" for unknown
 * extensions (.md, .jsonl, .parquet …) — fall back to an extension guess,
 * then to application/octet-stream. Anything that isn't a plain
 * `type/subtype[; params]` token is discarded so a hostile value can't smuggle
 * header syntax into the Content-Type we later serve.
 */
export function normalizeUploadMediaType(raw: unknown, filename: string): string {
  const candidate = typeof raw === "string" ? raw.trim() : "";
  if (
    candidate.length > 0 &&
    candidate.length <= 255 &&
    /^[\w.+-]+\/[\w.+-]+(\s*;\s*[\w.+-]+=("[^"\r\n]*"|[\w.+-]+))*$/.test(candidate)
  ) {
    return candidate;
  }
  return guessSessionOutputMime(filename);
}

/**
 * `Content-Disposition: attachment` value for a stored filename. ASCII
 * fallback in `filename=` (quotes/backslashes/non-ASCII replaced) plus the
 * RFC 5987 `filename*` form so non-ASCII names survive the download.
 */
export function contentDispositionAttachment(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export interface FileUploadDeps<Row = unknown> {
  tenantId: string;
  /** files-store service (metadata rows). */
  files: {
    create(input: {
      id: string;
      tenantId: string;
      sessionId?: string;
      filename: string;
      mediaType: string;
      sizeBytes: number;
      r2Key: string;
      downloadable: boolean;
    }): Promise<Row>;
  };
  /** Blob backend the GET /v1/files/:id/content route reads from. */
  filesBlob: BlobStore;
  /** Map a stored row to the wire FileRecord (`toFileRecord`). */
  toRecord: (row: Row) => unknown;
  /** Per-file ceiling in bytes. Defaults to DEFAULT_UPLOAD_MAX_BYTES. */
  maxBytes?: number;
  /**
   * Tenant check for `scope_id`. When supplied, an upload scoped to a
   * session the tenant doesn't own is rejected with 404 instead of
   * creating a row keyed to someone else's session id.
   */
  sessionExists?: (sessionId: string) => Promise<boolean>;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tooLarge(size: number, maxBytes: number): Response {
  return json(
    { error: `Upload too large: ${size} bytes exceeds limit of ${maxBytes} bytes` },
    413,
  );
}

/** Handle one POST /v1/files request end to end. Never throws for client
 *  errors — they come back as 4xx responses. */
export async function handleFileUpload<Row>(
  req: Request,
  deps: FileUploadDeps<Row>,
): Promise<Response> {
  const maxBytes = deps.maxBytes ?? DEFAULT_UPLOAD_MAX_BYTES;

  let rawFilename: unknown;
  let rawMediaType: unknown;
  let body: ArrayBuffer;
  let scopeId: string | undefined;
  let downloadable = false;

  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    let formData: FormData;
    try {
      formData = await req.formData();
    } catch {
      return json({ error: "Invalid multipart body" }, 400);
    }
    // Cast: the workers-types FormData typing narrows `get` to string.
    const file = formData.get("file") as unknown as File | string | null;
    if (!file || typeof file === "string") {
      return json({ error: "file field is required in multipart upload" }, 400);
    }
    if (file.size > maxBytes) return tooLarge(file.size, maxBytes);
    rawFilename = file.name;
    rawMediaType = file.type;
    body = await file.arrayBuffer();
    const sc = formData.get("scope_id");
    if (typeof sc === "string" && sc.length > 0) scopeId = sc;
    const d = formData.get("downloadable");
    if (typeof d === "string") downloadable = d === "true" || d === "1";
  } else {
    // JSON body upload — content is base64-encoded for binary, raw text for text/*
    let payload: {
      filename?: unknown;
      content?: unknown;
      media_type?: unknown;
      scope_id?: unknown;
      encoding?: unknown;
      downloadable?: unknown;
    };
    try {
      payload = (await req.json()) as typeof payload;
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }
    if (!payload || typeof payload !== "object") {
      return json({ error: "filename and content are required" }, 400);
    }
    if (!payload.filename || typeof payload.content !== "string") {
      return json({ error: "filename and content are required" }, 400);
    }
    rawFilename = payload.filename;
    rawMediaType = payload.media_type;
    if (typeof payload.scope_id === "string" && payload.scope_id.length > 0) {
      scopeId = payload.scope_id;
    }
    downloadable = payload.downloadable === true;

    const declared = typeof payload.media_type === "string" ? payload.media_type : "";
    const encoding =
      payload.encoding === "base64" || payload.encoding === "utf8"
        ? payload.encoding
        : declared.startsWith("text/")
          ? "utf8"
          : "base64";
    if (encoding === "base64") {
      let bin: string;
      try {
        bin = atob(payload.content);
      } catch {
        return json({ error: "content is not valid base64" }, 400);
      }
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes.buffer;
    } else {
      body = new TextEncoder().encode(payload.content).buffer as ArrayBuffer;
    }
    if (body.byteLength > maxBytes) return tooLarge(body.byteLength, maxBytes);
  }

  const filename = sanitizeUploadFilename(rawFilename);
  if (!filename) {
    return json(
      {
        error:
          `Invalid filename: must be 1-${MAX_UPLOAD_FILENAME_LENGTH} characters with no ` +
          `path separators or control characters`,
      },
      400,
    );
  }
  // Multipart: clients send "" or application/octet-stream for types they
  // don't know (.md, .jsonl, …), so an extension guess beats both. JSON
  // uploads keep their historical contract — the declared media_type, or
  // application/octet-stream when none is given.
  const declaredType = typeof rawMediaType === "string" ? rawMediaType.trim() : "";
  const mediaType = contentType.includes("multipart/form-data")
    ? declaredType && declaredType !== "application/octet-stream"
      ? normalizeUploadMediaType(declaredType, filename)
      : guessSessionOutputMime(filename)
    : declaredType
      ? normalizeUploadMediaType(declaredType, filename)
      : "application/octet-stream";

  if (scopeId && deps.sessionExists && !(await deps.sessionExists(scopeId))) {
    return json({ error: "Session not found" }, 404);
  }

  const id = generateFileId();
  const r2Key = fileR2Key(deps.tenantId, id);
  // Blob PUT first, then metadata insert — an orphan blob on metadata
  // failure, never a row pointing at missing bytes.
  await deps.filesBlob.put(r2Key, body, { httpMetadata: { contentType: mediaType } });

  const row = await deps.files.create({
    id,
    tenantId: deps.tenantId,
    sessionId: scopeId,
    filename,
    mediaType,
    sizeBytes: body.byteLength,
    r2Key,
    downloadable,
  });

  return json(deps.toRecord(row), 201);
}
