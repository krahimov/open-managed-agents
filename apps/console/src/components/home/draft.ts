import type { ResourceRow } from "./session-options";

/**
 * The draft of a session that has not been started yet.
 *
 * A draft is the whole thing a person put together in the session starter:
 * the words, who they are for, the images, and the options chosen (where it
 * runs, vaults, mounted resources, title). All of it is kept together, so
 * closing the dialog, leaving Home, reloading the page or a start that
 * fails brings back exactly what was there.
 *
 * One draft per agent. The starter always shows the draft of the agent in
 * its picker:
 *
 *   - opening the starter with no agent asked for shows the draft worked on
 *     last, with its agent;
 *   - opening it for one agent (an agent's "Start session", `?agent_id=`)
 *     shows that agent's own draft. A draft written for another agent is
 *     never poured into it: the starter says it exists and offers to move it;
 *   - changing the agent in the picker takes what is written along, unless
 *     the agent chosen already has a draft of its own, which is then shown
 *     while the other one stays where it was.
 *
 * Where it lives. In memory for the life of the page, which is what makes
 * images, typed secrets and a half-finished start survive closing the dialog
 * or going to another screen. For a reload: the words, the agent and the
 * options are in `sessionStorage` (this tab only), the images in IndexedDB.
 * A secret typed into Options (a repository token, a variable's value) is
 * never written to either: after a reload its row is there with the secret
 * blank, and the starter says so.
 */

export interface DraftOptions {
  /** The environment chosen for this session; null follows the agent's default. */
  environment_id: string | null;
  /** The vaults chosen for this session; null follows the agent's defaults. */
  vault_ids: string[] | null;
  title: string;
  resources: ResourceRow[];
}

/** A session that a start already created for this draft before a later step failed. */
export interface DraftStart {
  /** The request body it was created with: only the same request reuses it. */
  key: string;
  id: string;
  uploads: Map<File, { id: string; media_type: string }>;
}

export type DraftProblem =
  /** The session was not created. */
  | { stage: "create"; reason: string }
  /** The session exists, an image did not upload, nothing was sent. */
  | { stage: "upload"; reason: string; failed: File[]; sessionId: string }
  /** The session exists, the first message was refused. */
  | { stage: "send"; reason: string; sessionId: string };

export interface Draft {
  /** Who it is for. "" while the starter does not know its agent yet. */
  agentId: string;
  text: string;
  /** The starter chip whose text is in the box untouched, if that is all the text is. */
  filledBy: string | null;
  files: File[];
  options: DraftOptions;
  made: DraftStart | null;
  problem: DraftProblem | null;
  /** Images this draft held before a reload that could not be read back, by name. */
  lostFiles: string[];
  /** Secrets that a reload dropped from the resources (they are never stored). */
  secretsDropped: number;
  touchedAt: number;
}

export const emptyOptions = (): DraftOptions => ({ environment_id: null, vault_ids: null, title: "", resources: [] });

export function blankDraft(agentId = ""): Draft {
  return {
    agentId,
    text: "",
    filledBy: null,
    files: [],
    options: emptyOptions(),
    made: null,
    problem: null,
    lostFiles: [],
    secretsDropped: 0,
    touchedAt: 0,
  };
}

/**
 * Has the person put something of their own into it? A starter chip sitting
 * in the box untouched is not theirs yet, and neither is the environment the
 * starter was opened from (`pinnedEnvironmentId`).
 */
export function draftHasContent(d: Draft | null | undefined, pinnedEnvironmentId?: string): boolean {
  if (!d) return false;
  if (d.text.trim() && !d.filledBy) return true;
  if (d.files.length > 0 || d.lostFiles.length > 0) return true;
  const o = d.options;
  if (o.title.trim() || o.resources.length > 0 || o.vault_ids !== null) return true;
  return o.environment_id !== null && o.environment_id !== (pinnedEnvironmentId ?? null);
}

/** Is there anything to keep at all? (An untouched chip is kept, so the box reopens as it was left.) */
export function draftIsKept(d: Draft, pinnedEnvironmentId?: string): boolean {
  return !!d.text.trim() || !!d.made || draftHasContent(d, pinnedEnvironmentId);
}

/** One line that tells a person which draft this is. */
export function draftPreview(d: Draft, max = 64): string {
  const line = d.text.trim().split("\n")[0]?.trim() || d.options.title.trim();
  if (!line) return "";
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

// ── what a reload may read back ─────────────────────────────────────────

/** Resources as they may be written to storage: every secret blanked. `dropped` counts them. */
export function withoutSecrets(rows: ResourceRow[]): { rows: ResourceRow[]; dropped: number } {
  let dropped = 0;
  const out = rows.map((r): ResourceRow => {
    if (r.kind === "github" && r.token) {
      dropped += 1;
      return { ...r, token: "" };
    }
    if (r.kind === "env" && r.value) {
      dropped += 1;
      return { ...r, value: "" };
    }
    return r;
  });
  return { rows: out, dropped };
}

interface StoredDraft {
  text: string;
  filledBy: string | null;
  files: string[];
  options: DraftOptions;
  made: { key: string; id: string } | null;
  secretsDropped: number;
  touchedAt: number;
}
interface StoredState {
  v: 2;
  recipient: string | null;
  drafts: Record<string, StoredDraft>;
}

export function serialiseDrafts(drafts: Iterable<Draft>, recipient: string | null): string {
  const out: StoredState = { v: 2, recipient, drafts: {} };
  for (const d of drafts) {
    const { rows, dropped } = withoutSecrets(d.options.resources);
    out.drafts[d.agentId] = {
      text: d.text,
      filledBy: d.filledBy,
      files: [...d.files.map((f) => f.name), ...d.lostFiles],
      options: { ...d.options, resources: rows },
      made: d.made ? { key: d.made.key, id: d.made.id } : null,
      // Secrets dropped by an earlier reload and still missing stay counted.
      secretsDropped: dropped + d.secretsDropped,
      touchedAt: d.touchedAt,
    };
  }
  return JSON.stringify(out);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

const RESOURCE_KEYS: Record<ResourceRow["kind"], string[]> = {
  github: ["url", "token", "checkout_type", "checkout_name", "mount_path"],
  file: ["file_id", "mount_path"],
  memory_store: ["memory_store_id", "mount_path", "access"],
  env: ["name", "value"],
};

function readResources(v: unknown): ResourceRow[] {
  if (!Array.isArray(v)) return [];
  const out: ResourceRow[] = [];
  for (const row of v) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const keys = RESOURCE_KEYS[r.kind as ResourceRow["kind"]];
    if (!keys || !keys.every((k) => typeof r[k] === "string")) continue;
    out.push(r as unknown as ResourceRow);
  }
  return out;
}

/**
 * Drafts read back from storage. Their images are not here: each draft says
 * how many it had in `pendingFiles`, by name, and the store fetches them.
 */
export function restoreDrafts(raw: string | null): {
  recipient: string | null;
  drafts: Array<Draft & { pendingFiles: string[] }>;
} {
  const none = { recipient: null, drafts: [] };
  if (!raw) return none;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return none;
  }
  const state = parsed as Partial<StoredState> | null;
  if (!state || state.v !== 2 || !state.drafts || typeof state.drafts !== "object") return none;
  const drafts: Array<Draft & { pendingFiles: string[] }> = [];
  for (const [agentId, s] of Object.entries(state.drafts)) {
    if (!s || typeof s !== "object") continue;
    const o = (s.options ?? {}) as Partial<DraftOptions>;
    drafts.push({
      agentId,
      text: typeof s.text === "string" ? s.text : "",
      filledBy: typeof s.filledBy === "string" ? s.filledBy : null,
      files: [],
      pendingFiles: isStringArray(s.files) ? s.files : [],
      options: {
        environment_id: typeof o.environment_id === "string" && o.environment_id ? o.environment_id : null,
        vault_ids: isStringArray(o.vault_ids) ? o.vault_ids : null,
        title: typeof o.title === "string" ? o.title : "",
        resources: readResources(o.resources),
      },
      made:
        s.made && typeof s.made.key === "string" && typeof s.made.id === "string"
          ? { key: s.made.key, id: s.made.id, uploads: new Map() }
          : null,
      problem: null,
      lostFiles: [],
      secretsDropped: typeof s.secretsDropped === "number" ? s.secretsDropped : 0,
      touchedAt: typeof s.touchedAt === "number" ? s.touchedAt : 0,
    });
  }
  return { recipient: typeof state.recipient === "string" ? state.recipient : null, drafts };
}

// ── the store ───────────────────────────────────────────────────────────

const STATE_KEY = "muse:new-session:drafts";
/** Round 1 kept the words only, under this key. Read once, then removed. */
const LEGACY_TEXT_KEY = "muse:new-session:draft";
const TAB_KEY = "muse:new-session:tab";
const DB_NAME = "muse-new-session";
const DB_STORE = "images";
/** Images of a tab that was closed without sending are swept after this long. */
const IMAGE_TTL_MS = 3 * 24 * 60 * 60 * 1000;

type Listener = (agentId: string, source: unknown) => void;

interface Entry {
  draft: Draft;
  /** Its images are still being read back after a reload. */
  pendingFiles: string[] | null;
  /** The `files` array last written to IndexedDB (by identity). */
  writtenFiles: File[] | null;
}

function sameOptions(a: DraftOptions, b: DraftOptions): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
const sameList = <T,>(a: T[], b: T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));
function sameDraft(a: Draft, b: Draft): boolean {
  return (
    a.text === b.text &&
    a.filledBy === b.filledBy &&
    sameList(a.files, b.files) &&
    a.made === b.made &&
    a.problem === b.problem &&
    sameList(a.lostFiles, b.lostFiles) &&
    a.secretsDropped === b.secretsDropped &&
    sameOptions(a.options, b.options)
  );
}

export interface DraftStorage {
  session: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Images of one draft, for a reload. Any of these may fail: the draft then says which images it lost. */
  images: {
    put: (key: string, files: File[]) => Promise<void>;
    get: (key: string) => Promise<File[] | null>;
    remove: (key: string) => Promise<void>;
  } | null;
}

export function createDraftStore(storage: DraftStorage, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const listeners = new Set<Listener>();
  let recipient: string | null = null;
  let loaded = false;

  const emit = (agentId: string, source: unknown) => {
    for (const l of listeners) l(agentId, source);
  };

  const persist = () => {
    if (!storage.session) return;
    try {
      if (entries.size === 0 && !recipient) storage.session.removeItem(STATE_KEY);
      else {
        // A draft whose images are still being read back keeps their names.
        const drafts = [...entries.values()].map((e) => (e.pendingFiles ? { ...e.draft, lostFiles: e.pendingFiles } : e.draft));
        storage.session.setItem(STATE_KEY, serialiseDrafts(drafts, recipient));
      }
    } catch {
      // Storage is full or unavailable: the draft still lives for the life of the page.
    }
  };

  const load = () => {
    if (loaded) return;
    loaded = true;
    if (!storage.session) return;
    let raw: string | null = null;
    let legacy: string | null = null;
    try {
      raw = storage.session.getItem(STATE_KEY);
      legacy = storage.session.getItem(LEGACY_TEXT_KEY);
      if (legacy !== null) storage.session.removeItem(LEGACY_TEXT_KEY);
    } catch {
      return;
    }
    const restored = restoreDrafts(raw);
    recipient = restored.recipient;
    for (const { pendingFiles, ...draft } of restored.drafts) {
      entries.set(draft.agentId, { draft, pendingFiles: pendingFiles.length ? pendingFiles : null, writtenFiles: null });
    }
    if (legacy && entries.size === 0) {
      entries.set("", { draft: { ...blankDraft(""), text: legacy, touchedAt: now() }, pendingFiles: null, writtenFiles: null });
    }
    // Read the images back. Until they arrive the draft shows none; a
    // starter that has it open is told when they do.
    for (const [agentId, entry] of entries) {
      const names = entry.pendingFiles;
      if (!names) continue;
      const settle = (files: File[] | null) => {
        const cur = entries.get(agentId);
        // The person already changed the images, or the draft is gone.
        if (!cur || cur.pendingFiles !== names) return;
        cur.pendingFiles = null;
        if (files && files.length > 0) {
          cur.draft = { ...cur.draft, files };
          cur.writtenFiles = files;
        } else {
          cur.draft = { ...cur.draft, lostFiles: names };
        }
        emit(agentId, storage);
      };
      if (!storage.images) settle(null);
      else storage.images.get(agentId).then(settle, () => settle(null));
    }
  };

  const writeImages = (entry: Entry) => {
    if (!storage.images || entry.pendingFiles || entry.writtenFiles === entry.draft.files) return;
    const files = entry.draft.files;
    entry.writtenFiles = files;
    const done = files.length > 0 ? storage.images.put(entry.draft.agentId, files) : storage.images.remove(entry.draft.agentId);
    done.catch(() => undefined);
  };

  const remove = (agentId: string, source?: unknown) => {
    load();
    if (!entries.delete(agentId)) return;
    storage.images?.remove(agentId).catch(() => undefined);
    persist();
    emit(agentId, source);
  };

  return {
    /** The draft kept for this agent, if any. */
    get(agentId: string): Draft | null {
      load();
      return entries.get(agentId)?.draft ?? null;
    },
    /** The draft touched last. `withContent` skips ones that hold nothing of the person's own. */
    latest(opts: { except?: string; withContent?: boolean } = {}): Draft | null {
      load();
      let best: Draft | null = null;
      for (const { draft } of entries.values()) {
        if (draft.agentId === opts.except) continue;
        if (opts.withContent && !draftHasContent(draft)) continue;
        if (!best || draft.touchedAt > best.touchedAt) best = draft;
      }
      return best;
    },
    /**
     * Keep this draft for its agent, or forget it when nothing is left in it.
     * `pinnedEnvironmentId`: the environment the starter was opened from,
     * which alone is not a reason to keep a draft.
     */
    save(draft: Omit<Draft, "touchedAt">, opts: { source?: unknown; pinnedEnvironmentId?: string } = {}): void {
      load();
      const prev = entries.get(draft.agentId);
      const next: Draft = { ...draft, touchedAt: prev?.draft.touchedAt ?? 0 };
      if (!draftIsKept(next, opts.pinnedEnvironmentId)) {
        if (prev) remove(draft.agentId, opts.source);
        return;
      }
      if (prev && sameDraft(prev.draft, next)) return;
      next.touchedAt = now();
      // Images still being read back stay pending until the person changes them.
      const stillPending = prev?.pendingFiles && next.files === prev.draft.files ? prev.pendingFiles : null;
      const entry: Entry = { draft: next, pendingFiles: stillPending, writtenFiles: prev?.writtenFiles ?? null };
      entries.set(draft.agentId, entry);
      writeImages(entry);
      persist();
      emit(draft.agentId, opts.source);
    },
    remove,
    /** The agent the person chose last, kept so the starter reopens on it even with an empty box. */
    get recipient(): string | null {
      load();
      return recipient;
    },
    setRecipient(agentId: string | null): void {
      load();
      if (recipient === agentId) return;
      recipient = agentId;
      persist();
    },
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type DraftStore = ReturnType<typeof createDraftStore>;

// ── the browser's storage ───────────────────────────────────────────────

function browserStorage(): DraftStorage {
  let session: Storage | null = null;
  try {
    session = typeof sessionStorage !== "undefined" ? sessionStorage : null;
  } catch {
    session = null;
  }
  // Images are kept per tab, like the rest of the draft. IndexedDB is shared
  // by every tab, so each record carries this tab's id.
  let tab = "";
  try {
    tab = session?.getItem(TAB_KEY) ?? "";
    if (!tab && session) {
      tab = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
      session.setItem(TAB_KEY, tab);
    }
  } catch {
    tab = "";
  }
  if (!tab || typeof indexedDB === "undefined") return { session, images: null };

  let opening: Promise<IDBDatabase> | null = null;
  const db = () =>
    (opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("blocked"));
    }).then((database) => {
      sweep(database);
      return database;
    }));
  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>) =>
    db().then(
      (database) =>
        new Promise<T>((resolve, reject) => {
          const tx = database.transaction(DB_STORE, mode);
          const req = work(tx.objectStore(DB_STORE));
          tx.oncomplete = () => resolve(req.result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        }),
    );
  /** Forget images left behind by tabs that were closed without sending. */
  const sweep = (database: IDBDatabase) => {
    try {
      const store = database.transaction(DB_STORE, "readwrite").objectStore(DB_STORE);
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        const saved = (at.value as { at?: number } | undefined)?.at ?? 0;
        if (Date.now() - saved > IMAGE_TTL_MS) at.delete();
        at.continue();
      };
    } catch {
      // nothing to sweep
    }
  };
  const key = (agentId: string) => `${tab}|${agentId}`;
  return {
    session,
    images: {
      put: (agentId, files) => run("readwrite", (s) => s.put({ files, at: Date.now() }, key(agentId))).then(() => undefined),
      get: (agentId) =>
        run<{ files?: File[] } | undefined>("readonly", (s) => s.get(key(agentId))).then((row) =>
          Array.isArray(row?.files) ? row.files.filter((f): f is File => f instanceof File) : null,
        ),
      remove: (agentId) => run("readwrite", (s) => s.delete(key(agentId))).then(() => undefined),
    },
  };
}

/** The drafts of this tab. */
export const draftStore: DraftStore = createDraftStore(browserStorage());
