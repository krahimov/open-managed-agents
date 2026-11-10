import { Hono } from "hono";
import type { Env } from "@open-managed-agents/shared";
import { sessionOutputsPrefix } from "@open-managed-agents/shared";
import { handleFileUpload, resolveUploadMaxBytes } from "@open-managed-agents/http-routes";
import { toFileRecord, FileNotFoundError } from "@open-managed-agents/files-store";
import type { Services } from "@open-managed-agents/services";
import { checkUploadFreq, checkUploadSize } from "../quotas";

const app = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}>();

// ─── Session-outputs synthesis ──────────────────────────────────────
//
// Files the agent writes to /mnt/session/outputs/ inside the sandbox land
// in R2 under `t/<tenant>/session-outputs/<session>/<filename>` with no
// D1 row (the mount is bytes-only — listing scans the R2 prefix directly).
// To make these reachable through the standard AMA Files API, we synthesize
// file rows on the fly:
//
//   - LIST /v1/files?scope_id=<sessionId> includes both real D1-backed
//     files AND R2 objects under the session-outputs prefix.
//   - GET /v1/files/:id and /content recognize ids matching `out:<sessionId>:
//     <base64url(filename)>` and read R2 directly with no D1 round-trip.
//
// Wire id format is opaque to the SDK; format is stable and self-describing
// so we never need a backing index. base64url encoding so filenames with
// special chars (spaces, slashes — though slashes shouldn't reach here)
// don't break URL routing.

function encodeOutputId(sessionId: string, filename: string): string {
  // base64url; strip padding so the id stays URL-friendly
  const b64 = btoa(filename).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `out:${sessionId}:${b64}`;
}

function decodeOutputId(
  id: string,
): { sessionId: string; filename: string } | null {
  if (!id.startsWith("out:")) return null;
  const rest = id.slice(4);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const sessionId = rest.slice(0, sep);
  const b64 = rest.slice(sep + 1);
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/")
      + "===".slice((b64.length + 3) % 4);
    return { sessionId, filename: atob(padded) };
  } catch {
    return null;
  }
}

const OUTPUT_MIME_GUESS: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip",
};

function guessOutputMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  return OUTPUT_MIME_GUESS[ext] || "application/octet-stream";
}

interface ApiFileRecord {
  id: string;
  type: "file";
  filename: string;
  media_type: string;
  size_bytes: number;
  created_at: string;
  scope?: { type: "session"; id: string };
  downloadable?: boolean;
}

async function listSessionOutputAsFiles(
  bucket: R2Bucket,
  tenantId: string,
  sessionId: string,
): Promise<ApiFileRecord[]> {
  const prefix = sessionOutputsPrefix(tenantId, sessionId);
  const list = await bucket.list({ prefix, limit: 1000 });
  return list.objects.map((o: R2Object) => {
    const filename = o.key.slice(prefix.length);
    return {
      id: encodeOutputId(sessionId, filename),
      type: "file" as const,
      filename,
      media_type: o.httpMetadata?.contentType || guessOutputMime(filename),
      size_bytes: o.size,
      created_at: o.uploaded.toISOString(),
      scope: { type: "session" as const, id: sessionId },
      downloadable: true,
    };
  });
}

// POST /v1/files — upload file (multipart form or JSON body)
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  // Cheap upfront rejects so a flood of oversized / over-frequent uploads
  // doesn't even read the body. Both gates soft-pass when unconfigured.
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = c.var.services.filesBlob;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  // Parsing, filename/media-type validation, size ceiling and storage are
  // shared with apps/main-node (packages/http-routes/src/files/upload.ts).
  // CF deliberately does NOT pass `sessionExists`: scope_id stays a
  // free-form tag here, as it always has been.
  return handleFileUpload(c.req.raw, {
    tenantId: t,
    files: c.var.services.files,
    filesBlob: bucket,
    toRecord: toFileRecord,
    maxBytes: resolveUploadMaxBytes(c.env.UPLOAD_MAX_BYTES),
  });
});

// GET /v1/files — list files (cursor-paginated, optional scope_id filter)
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const beforeId = c.req.query("before_id"); // returns files with id < before_id
  const afterId = c.req.query("after_id");   // returns files with id > after_id
  const order = c.req.query("order") === "asc" ? "asc" : "desc";

  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;

  // Ask for one extra row so we can derive `has_more` without a count query.
  const rows = await c.var.services.files.list({
    tenantId: t,
    sessionId: scopeId,
    beforeId,
    afterId,
    order,
    limit: requested + 1,
  });

  const slice = rows.slice(0, requested);
  const data: ApiFileRecord[] = slice.map(toFileRecord) as ApiFileRecord[];
  let hasMore = rows.length > requested;

  // When the caller scopes to a session, also list the R2 session-outputs
  // prefix and fold those in as synthesized rows. Pagination here is
  // best-effort: we don't honor before_id/after_id across the synthesized
  // set (they'd need a unified cursor scheme over D1 + R2). For typical
  // usage — list session artifacts after the agent finishes — this returns
  // everything in one page.
  if (scopeId && c.env.FILES_BUCKET) {
    const synthesized = await listSessionOutputAsFiles(
      c.env.FILES_BUCKET,
      t,
      scopeId,
    );
    data.push(...synthesized);
    if (synthesized.length >= 1000) hasMore = true;
  }

  return c.json({
    data,
    has_more: hasMore,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
  });
});

// GET /v1/files/:id — get file metadata
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");

  // Synthesized session-output id: derive metadata from R2 directly,
  // no D1 round-trip needed.
  const decoded = decodeOutputId(id);
  if (decoded) {
    const bucket = c.env.FILES_BUCKET;
    if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);
    const r2Key = `${sessionOutputsPrefix(t, decoded.sessionId)}${decoded.filename}`;
    const head = await bucket.head(r2Key);
    if (!head) return c.json({ error: "File not found" }, 404);
    const record: ApiFileRecord = {
      id,
      type: "file",
      filename: decoded.filename,
      media_type: head.httpMetadata?.contentType || guessOutputMime(decoded.filename),
      size_bytes: head.size,
      created_at: head.uploaded.toISOString(),
      scope: { type: "session", id: decoded.sessionId },
      downloadable: true,
    };
    return c.json(record);
  }

  const row = await c.var.services.files.get({
    tenantId: t,
    fileId: id,
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});

// GET /v1/files/:id/content — download file content (streamed from R2).
// Gated by `downloadable` flag, mirroring Anthropic's split: user-uploaded
// files are opaque, model/sandbox-emitted artefacts are downloadable.
app.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const r2 = c.env.FILES_BUCKET;
  const bucket = c.var.services.filesBlob;
  if (!r2 || !bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  // Synthesized session-output id: stream R2 directly.
  const decoded = decodeOutputId(id);
  if (decoded) {
    const r2Key = `${sessionOutputsPrefix(t, decoded.sessionId)}${decoded.filename}`;
    const obj = await r2.get(r2Key);
    if (!obj) return c.json({ error: "File content not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || guessOutputMime(decoded.filename),
      },
    });
  }

  const row = await c.var.services.files.get({
    tenantId: t,
    fileId: id,
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) {
    return c.json({ error: "This file is not downloadable" }, 403);
  }

  const obj = await bucket.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);

  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});

// DELETE /v1/files/:id — delete metadata + R2 object
app.delete("/:id", async (c) => {
  const bucket = c.var.services.filesBlob;
  try {
    const deleted = await c.var.services.files.delete({
      tenantId: c.get("tenant_id"),
      fileId: c.req.param("id"),
    });
    if (bucket) await bucket.delete(deleted.r2_key);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

export default app;
