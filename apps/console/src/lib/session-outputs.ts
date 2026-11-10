/**
 * Session outputs — the files an agent wrote under its outputs dir
 * (`/mnt/session/outputs/`), served by GET /v1/sessions/:id/outputs[/<name>].
 *
 * Agents point at these files in their replies as
 * `sandbox:/mnt/session/outputs/report.md`, `/mnt/session/outputs/report.md`
 * or a bare `report.md`. None of those is a URL the browser can follow —
 * left alone, a relative one navigates the SPA to a route that doesn't
 * exist. `resolveOutputLink` maps them onto the outputs API instead.
 */

import { useEffect, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { getActiveTenantId, readApiErrorMessage } from "./api";
import { getClerkBearerToken } from "./clerk-auth";
import type { Event } from "./events";

export interface SessionOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

// ─── Link resolution ───────────────────────────────────────────────────

export type OutputLinkTarget =
  /** A file in the session outputs dir — downloadable. */
  | { kind: "output"; filename: string }
  /** A relative path that isn't (yet) a known output — re-check on click. */
  | { kind: "relative"; path: string }
  /** A sandbox path the outputs API can't serve (outside the outputs dir,
   *  or inside a subfolder of it). */
  | { kind: "unavailable"; path: string };

/** `/mnt/session/outputs/…` and the per-session agent-computer layout
 *  `/mnt/sessions/<sid>/outputs/…`. */
const OUTPUTS_DIR = /^\/mnt\/(?:session|sessions\/[^/]+)\/outputs\/(.+)$/;
/** Roots that only exist inside the agent's sandbox, never in the app. */
const SANDBOX_ROOT = /^\/(?:mnt|workspace|tmp|home|root|var|opt|usr|etc)(?:\/|$)/;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Classify a link href from an agent message. Returns null for ordinary
 * links (http(s), mailto, in-page anchors) the browser should handle.
 */
export function resolveOutputLink(
  href: string | undefined | null,
  outputs: readonly SessionOutputFile[] | null | undefined,
): OutputLinkTarget | null {
  if (!href) return null;
  let raw = href.trim();
  if (!raw || raw.startsWith("#")) return null;

  // `sandbox:/path`, `sandbox:///path` and `file:///path` all mean "a path
  // inside the agent's sandbox".
  let sandboxScheme = false;
  const scheme = /^(sandbox|file):(?:\/\/)?/i.exec(raw);
  if (scheme) {
    sandboxScheme = true;
    raw = raw.slice(scheme[0].length);
    if (!raw.startsWith("/")) raw = `/${raw}`;
  } else if (HAS_SCHEME.test(raw) || raw.startsWith("//")) {
    return null;
  }

  // Drop ?query / #fragment — they mean nothing for a sandbox file.
  const path = decode(raw.replace(/[?#].*$/, ""));
  if (!path) return null;

  if (path.startsWith("/")) {
    const m = OUTPUTS_DIR.exec(path);
    if (m) {
      const rest = m[1].replace(/\/+$/, "");
      // The outputs API is flat: only top-level files are listed/served.
      return rest && !rest.includes("/")
        ? { kind: "output", filename: rest }
        : { kind: "unavailable", path };
    }
    if (sandboxScheme || SANDBOX_ROOT.test(path)) return { kind: "unavailable", path };
    return null; // some other absolute path — leave it to the browser
  }

  // Relative: `report.md`, `./report.md`, `outputs/report.md`.
  const rel = path.replace(/^(?:\.\/)+/, "").replace(/^outputs\//, "");
  if (!rel || rel.startsWith("../")) return { kind: "unavailable", path };
  if (outputs?.some((o) => o.filename === rel)) return { kind: "output", filename: rel };
  return { kind: "relative", path: rel };
}

// ─── Authenticated fetch + download ────────────────────────────────────

/** Same auth the `api()` helper sends (cookie + Clerk bearer + workspace
 *  pin), for responses that aren't JSON. A plain `<a href>` can't carry
 *  the bearer token or the tenant header. */
async function authedFetch(path: string): Promise<Response> {
  const activeTenant = getActiveTenantId();
  const clerkToken = await getClerkBearerToken();
  return fetch(path, {
    credentials: "include",
    headers: {
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
      ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
    },
  });
}

export function sessionOutputUrl(sessionId: string, filename: string): string {
  return `/v1/sessions/${sessionId}/outputs/${encodeURIComponent(filename)}`;
}

/** Save a fetched response body to the user's disk. Always a download,
 *  never an inline view: outputs are agent-written bytes (possibly HTML)
 *  and must not render on the console's origin. */
async function saveResponse(res: Response, filename: string): Promise<void> {
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** Download one session output. Resolves true on success; failures toast. */
export async function downloadSessionOutput(sessionId: string, filename: string): Promise<boolean> {
  try {
    const res = await authedFetch(sessionOutputUrl(sessionId, filename));
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Couldn't download "${filename}": ${readApiErrorMessage(body, res.status)}`);
      return false;
    }
    await saveResponse(res, filename);
    return true;
  } catch (e) {
    toast.error(`Couldn't download "${filename}": ${e instanceof Error ? e.message : "network error"}`);
    return false;
  }
}

/** Download an uploaded file (GET /v1/files/:id/content). */
export async function downloadUploadedFile(fileId: string, filename: string): Promise<boolean> {
  try {
    const res = await authedFetch(`/v1/files/${fileId}/content`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(`Download failed: ${readApiErrorMessage(body, res.status)}`);
      return false;
    }
    await saveResponse(res, filename);
    return true;
  } catch (e) {
    toast.error(`Download failed: ${e instanceof Error ? e.message : "network error"}`);
    return false;
  }
}

// ─── Per-session outputs store ─────────────────────────────────────────
//
// One cached listing per session, shared by every link in the transcript,
// the per-turn Files strip and the Files panel. Module-level (not React
// Query) so <Markdown> can use it in trees with no QueryClientProvider.

interface Snapshot {
  /** null until the first fetch settles. */
  outputs: SessionOutputFile[] | null;
  error: string | null;
}

interface Entry {
  /** Replaced (never mutated) on every settle so useSyncExternalStore
   *  sees a new reference exactly when something changed. */
  snap: Snapshot;
  inflight: Promise<SessionOutputFile[]> | null;
  listeners: Set<() => void>;
}

const EMPTY: Snapshot = { outputs: null, error: null };
const store = new Map<string, Entry>();

function entryFor(sessionId: string): Entry {
  let e = store.get(sessionId);
  if (!e) {
    e = { snap: EMPTY, inflight: null, listeners: new Set() };
    store.set(sessionId, e);
  }
  return e;
}

/** (Re)fetch a session's output listing. Concurrent callers share one
 *  request. Never rejects — a failed fetch keeps the previous listing. */
export function refreshSessionOutputs(sessionId: string): Promise<SessionOutputFile[]> {
  const e = entryFor(sessionId);
  if (e.inflight) return e.inflight;
  e.inflight = (async () => {
    try {
      const res = await authedFetch(`/v1/sessions/${sessionId}/outputs`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(readApiErrorMessage(body, res.status));
      }
      const body = (await res.json()) as { data?: SessionOutputFile[] };
      e.snap = { outputs: Array.isArray(body.data) ? body.data : [], error: null };
    } catch (err) {
      e.snap = {
        outputs: e.snap.outputs,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      e.inflight = null;
      for (const l of e.listeners) l();
    }
    return e.snap.outputs ?? [];
  })();
  return e.inflight;
}

/** Test hook: forget every cached listing. */
export function resetSessionOutputsStore(): void {
  store.clear();
}

/** Subscribe to a session's output listing; fetches it on first use. */
export function useSessionOutputs(sessionId: string | undefined): Snapshot {
  const snap = useSyncExternalStore(
    (onChange) => {
      if (!sessionId) return () => {};
      const e = entryFor(sessionId);
      e.listeners.add(onChange);
      return () => e.listeners.delete(onChange);
    },
    () => (sessionId ? entryFor(sessionId).snap : EMPTY),
  );
  useEffect(() => {
    if (!sessionId) return;
    const e = entryFor(sessionId);
    if (e.snap === EMPTY && !e.inflight) void refreshSessionOutputs(sessionId);
  }, [sessionId]);
  return snap;
}

// ─── Outputs per turn ──────────────────────────────────────────────────

function eventMs(e: Event): number | null {
  const pa = (e as { processed_at?: unknown }).processed_at;
  for (const v of [pa, e.ts]) {
    if (typeof v === "number") return v > 1e12 ? v : v * 1000;
    if (typeof v === "string") {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

/**
 * Attribute each output to the turn it was written in, keyed by that
 * turn's LAST agent.message (where the Files strip renders). A turn runs
 * from one user.message to the next; an output belongs to the latest turn
 * that started at or before its `uploaded_at`. Turns that produced no
 * agent.message get no strip — the Files panel still lists everything.
 */
export function outputsByTurn(
  events: readonly Event[],
  outputs: readonly SessionOutputFile[] | null | undefined,
): Map<Event, SessionOutputFile[]> {
  const result = new Map<Event, SessionOutputFile[]>();
  if (!outputs || outputs.length === 0) return result;

  const turns: Array<{ startMs: number; lastMessage: Event | null }> = [];
  for (const e of events) {
    if (e.type === "user.message") {
      const ms = eventMs(e);
      // A user.message with no timestamp can't bound a turn; fold it into
      // the previous one rather than guess.
      if (ms !== null) turns.push({ startMs: ms, lastMessage: null });
    } else if (e.type === "agent.message" && turns.length > 0) {
      turns[turns.length - 1].lastMessage = e;
    }
  }
  if (turns.length === 0) return result;

  for (const o of outputs) {
    const t = Date.parse(o.uploaded_at);
    let idx = 0;
    if (!Number.isNaN(t)) {
      for (let i = 0; i < turns.length; i++) {
        if (turns[i].startMs <= t) idx = i;
      }
    } else {
      idx = turns.length - 1;
    }
    const anchor = turns[idx].lastMessage;
    if (!anchor) continue;
    const list = result.get(anchor);
    if (list) list.push(o);
    else result.set(anchor, [o]);
  }
  return result;
}
