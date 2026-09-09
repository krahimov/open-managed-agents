/**
 * Shared memory bridge for host-workdir SDK harnesses (claude-agent-sdk,
 * codex-sdk). The DefaultHarness mounts memory stores at /mnt/memory via the
 * sandbox; SDK harnesses run the vendor CLI in a plain host workdir with no
 * sandbox mount, so instead each store's files are materialized into
 * <cwd>/memory/<name>/ before the turn and changed files are written back
 * after (CAS-guarded, fail-closed on conflict).
 */

import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { memoryGuidance as sharedMemoryGuidance } from "@open-managed-agents/agent/harness/platform-guidance";

export interface SdkMemoryPort {
  /** All stores attached to the session, with their current contents. */
  resolve: (
    tenantId: string,
    sessionId: string,
  ) => Promise<
    Array<{
      storeId: string;
      name: string;
      access: "read_write" | "read_only";
      memories: Array<{ path: string; content: string }>;
    }>
  >;
  /** Persist one file back. baseSha256=null asserts not_exists (new file);
   *  a hash asserts compare-and-swap. Returns conflict=true when the remote
   *  moved under us (we then keep the remote copy, never clobber). */
  write: (args: {
    tenantId: string;
    sessionId: string;
    storeId: string;
    path: string;
    content: string;
    baseSha256: string | null;
  }) => Promise<{ ok: boolean; conflict?: boolean; error?: string }>;
}

export interface MemoryManifestEntry {
  storeId: string;
  memPath: string;
  storeName: string;
  access: "read_write" | "read_only";
  sha256: string;
}

export interface MaterializedMemory {
  /** abs file path → base state, for the post-turn compare-and-swap. */
  manifest: Map<string, MemoryManifestEntry>;
  /** Store lookup by directory name — lets write-back attribute NEW files
   *  (including the first file in a previously-empty store) to the right
   *  store id + access level. */
  storeByName: Map<string, { storeId: string; access: "read_write" | "read_only" }>;
  /** System-prompt block pointing the agent at its stores ("" when none). */
  guidance: string;
}

/** Materialize the session's attached stores into <cwd>/memory/<name>/<path>.
 *  Throws on resolve failure — callers treat memory as best-effort and must
 *  not let it block the turn. */
export async function materializeMemory(
  port: SdkMemoryPort,
  tenantId: string,
  sessionId: string,
  cwd: string,
): Promise<MaterializedMemory> {
  const manifest = new Map<string, MemoryManifestEntry>();
  const storeByName = new Map<string, { storeId: string; access: "read_write" | "read_only" }>();
  const stores = await port.resolve(tenantId, sessionId);
  const lines: string[] = [];
  for (const store of stores) {
    storeByName.set(store.name, { storeId: store.storeId, access: store.access });
    const storeDir = path.join(cwd, "memory", store.name);
    await mkdir(storeDir, { recursive: true });
    for (const mem of store.memories) {
      const abs = path.join(storeDir, mem.path);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, mem.content, "utf8");
      manifest.set(abs, {
        storeId: store.storeId,
        memPath: mem.path,
        storeName: store.name,
        access: store.access,
        sha256: sha256Hex(mem.content),
      });
    }
    lines.push(
      `  - ./memory/${store.name}/  (${store.memories.length} file(s)` +
        (store.access === "read_only" ? ", READ-ONLY — do not edit" : ", read/write — edits persist") +
        ")",
    );
  }
  const guidance =
    lines.length > 0
      ? [
          "",
          sharedMemoryGuidance,
          "Memory directories (survive across sessions):",
          ...lines,
          "Files you create or edit under a read/write memory directory are saved back automatically when the turn ends.",
        ].join("\n")
      : "";
  return { manifest, storeByName, guidance };
}

/** Scan <cwd>/memory after the turn and persist changed/new files back to
 *  their stores. CAS-guarded (base sha for edits, not_exists for new files)
 *  so a concurrent write elsewhere is never silently clobbered — on
 *  conflict we keep the remote copy. Read-only stores are skipped. */
export async function writeBackMemory(
  port: SdkMemoryPort,
  tenantId: string,
  sessionId: string,
  cwd: string,
  materialized: MaterializedMemory,
): Promise<{ saved: number; conflicts: string[] }> {
  const { manifest, storeByName } = materialized;
  const memRoot = path.join(cwd, "memory");
  const files = await walkFiles(memRoot).catch(() => [] as string[]);
  let saved = 0;
  const conflicts: string[] = [];
  for (const abs of files) {
    const rel = path.relative(memRoot, abs); // "<storeName>/<memPath...>"
    const segs = rel.split(path.sep);
    if (segs.length < 2) continue; // stray file directly under memory/
    const storeName = segs[0];
    const memPath = segs.slice(1).join("/");
    const store = storeByName.get(storeName);
    if (!store || store.access !== "read_write") continue;

    let content: string;
    try {
      content = await readFile(abs, "utf8");
    } catch {
      continue;
    }
    const prior = manifest.get(abs);
    if (prior && prior.sha256 === sha256Hex(content)) continue; // unchanged

    const res = await port.write({
      tenantId,
      sessionId,
      storeId: store.storeId,
      path: memPath,
      content,
      baseSha256: prior ? prior.sha256 : null,
    });
    if (res.ok) saved++;
    else if (res.conflict) conflicts.push(`${storeName}/${memPath}`);
  }
  return { saved, conflicts };
}

/** Recursively list all files under a directory (absolute paths). */
async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkFiles(full)));
    else if (e.isFile()) out.push(full);
  }
  return out;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
