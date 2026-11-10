// POST /v1/files on Node + file resources attached mid-session.
//
// Spawns the real main-node (SQLite + localfs blobs + subprocess sandbox)
// and drives it over HTTP, so the route, the auth middleware, the files
// service/blob backend the GET routes read, and the sandbox mount are all
// the production wiring.
//
//   1. upload contract — multipart + JSON happy paths, size ceiling, bad
//      filenames, scope validation, download round-trip
//   2. auth + tenant isolation — 401 without credentials; cookie and
//      API-key callers each see only their own tenant's files
//   3. a file resource added to an already-running session is on disk
//      before the request returns (i.e. before the next turn can start)

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_LOADER = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

/** Upload ceiling the test servers run with — small enough to trip cheaply. */
const MAX_BYTES = 64 * 1024;

async function startMainNode(opts: {
  dataDir: string;
  env?: Record<string, string>;
}): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(process.execPath, ["--import", TSX_LOADER, MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      // Hermetic: main-node self-loads .env/.env.local for any key the
      // child env leaves undefined — an empty string blocks the file value,
      // so the test never touches the operator's real database / bucket /
      // sandbox provider / auth provider.
      DATABASE_URL: "",
      FILES_S3_ENDPOINT: "",
      FILES_S3_BUCKET: "",
      CLERK_SECRET_KEY: "",
      CLERK_PUBLISHABLE_KEY: "",
      ANTHROPIC_API_KEY: "test-key-not-real",
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      SANDBOX_PROVIDER: "subprocess",
      UPLOAD_MAX_BYTES: String(MAX_BYTES),
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      NODE_ENV: "test",
      ...opts.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch { /* not ready */ }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null || handle.child.signalCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else rej(new Error("could not pick port"));
    });
  });
}

function newDataDir(tag: string): string {
  const dir = join(tmpdir(), `oma-test-${tag}-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface FileRecord {
  id: string;
  type: string;
  filename: string;
  media_type: string;
  size_bytes: number;
  scope_id?: string;
  downloadable: boolean;
  created_at: string;
}

function multipart(
  filename: string,
  content: string | Uint8Array,
  type: string,
  fields: Record<string, string> = {},
): FormData {
  const fd = new FormData();
  fd.append("file", new File([content], filename, { type }));
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

/** A hand-built multipart body, so the filename reaches the server exactly
 *  as written (FormData/File would be free to normalise it). */
function rawMultipart(filename: string, content: string): { body: string; contentType: string } {
  const boundary = `----omatest${randomBytes(8).toString("hex")}`;
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `${content}\r\n` +
    `--${boundary}--\r\n`;
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

describe("Node POST /v1/files", () => {
  let h: ProcessHandle;
  let base: string;

  beforeAll(async () => {
    h = await startMainNode({ dataDir: newDataDir("upload"), env: { AUTH_DISABLED: "1" } });
    base = `http://localhost:${h.port}/v1`;
  });

  afterAll(async () => {
    await killHard(h).catch(() => {});
    try { rmSync(h.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("stores a multipart upload and serves it back through the existing GET routes", async () => {
    const csv = "region,revenue\nemea,120\napac,95\n";
    const res = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("q3 sales.csv", csv, "text/csv", { downloadable: "true" }),
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as FileRecord;
    expect(file).toMatchObject({
      type: "file",
      filename: "q3 sales.csv",
      media_type: "text/csv",
      size_bytes: Buffer.byteLength(csv),
      downloadable: true,
    });
    expect(file.id).toMatch(/^file[-_]/);
    expect(file.created_at).toBeTruthy();
    expect(file.scope_id).toBeUndefined();

    const meta = await fetch(`${base}/files/${file.id}`);
    expect(meta.status).toBe(200);
    expect(((await meta.json()) as FileRecord).filename).toBe("q3 sales.csv");

    const list = (await (await fetch(`${base}/files`)).json()) as { data: FileRecord[] };
    expect(list.data.map((f) => f.id)).toContain(file.id);

    const content = await fetch(`${base}/files/${file.id}/content`);
    expect(content.status).toBe(200);
    expect(await content.text()).toBe(csv);
    expect(content.headers.get("content-type")).toContain("text/csv");
    // Uploaded bytes are never rendered inline on the console's origin.
    expect(content.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(content.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("keeps binary bytes intact and defaults to not downloadable", async () => {
    const bytes = new Uint8Array(2048).map((_, i) => (i * 31) % 256);
    const res = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("blob.bin", bytes, "application/octet-stream"),
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as FileRecord;
    expect(file.size_bytes).toBe(2048);
    expect(file.downloadable).toBe(false);
    // Opaque by default — same split as the CF route.
    expect((await fetch(`${base}/files/${file.id}/content`)).status).toBe(403);
    // …but the stored blob is byte-identical to what was sent.
    const blobDir = join(h.dataDir, "files-blobs");
    expect(findFileWithBytes(blobDir, bytes)).toBe(true);
  });

  it("guesses a media type from the extension when the client sends none", async () => {
    const res = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("notes.md", "# hi", ""),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as FileRecord).media_type).toBe("text/markdown");
  });

  it("accepts the JSON body form (SDK / curl without multipart)", async () => {
    const res = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "data.json", content: '{"a":1}', media_type: "text/plain" }),
    });
    expect(res.status).toBe(201);
    const file = (await res.json()) as FileRecord;
    expect(file.filename).toBe("data.json");
    expect(file.size_bytes).toBe(7);
  });

  it("rejects a file over the limit with 413 and stores nothing", async () => {
    const before = ((await (await fetch(`${base}/files`)).json()) as { data: FileRecord[] }).data.length;

    // Just over the per-file ceiling (under the stream cap, so this is the
    // exact-size check, not the body limiter).
    const justOver = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("big.bin", new Uint8Array(MAX_BYTES + 1), "application/octet-stream"),
    });
    expect(justOver.status).toBe(413);
    expect(((await justOver.json()) as { error: string }).error).toMatch(/too large/i);

    // Far over: cut off by the body limiter while streaming.
    const farOver = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("huge.bin", new Uint8Array(4 * 1024 * 1024), "application/octet-stream"),
    });
    expect(farOver.status).toBe(413);

    // The JSON form has the same ceiling.
    const jsonOver = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "big.txt", content: "x".repeat(MAX_BYTES + 1), encoding: "utf8" }),
    });
    expect(jsonOver.status).toBe(413);

    const after = ((await (await fetch(`${base}/files`)).json()) as { data: FileRecord[] }).data.length;
    expect(after).toBe(before);
  });

  it("accepts a file exactly at the limit", async () => {
    const res = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("edge.bin", new Uint8Array(MAX_BYTES), "application/octet-stream"),
    });
    expect(res.status).toBe(201);
  });

  it.each([
    "../../etc/passwd",
    "..",
    "nested/dir/file.txt",
    "back\\slash.txt",
    "x".repeat(256),
  ])("rejects filename %j with 400", async (filename) => {
    const { body, contentType } = rawMultipart(filename, "payload");
    const res = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/filename/i);
  });

  it("rejects path-traversal and control characters in a JSON filename", async () => {
    for (const filename of ["../escape.txt", "a\u0000b.txt", "line\nbreak.txt", ""]) {
      const res = await fetch(`${base}/files`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename, content: "x", encoding: "utf8" }),
      });
      expect(res.status, JSON.stringify(filename)).toBe(400);
    }
  });

  it("rejects a multipart body with no file field, and unparseable bodies", async () => {
    const fd = new FormData();
    fd.append("scope_id", "whatever");
    expect((await fetch(`${base}/files`, { method: "POST", body: fd })).status).toBe(400);

    const badJson = await fetch(`${base}/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
  });

  it("only accepts a scope_id that is one of the tenant's sessions", async () => {
    const unknown = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("a.txt", "x", "text/plain", { scope_id: "sess_does_not_exist" }),
    });
    expect(unknown.status).toBe(404);

    const session = await createSession(base);
    const scoped = await fetch(`${base}/files`, {
      method: "POST",
      body: multipart("a.txt", "x", "text/plain", { scope_id: session.id }),
    });
    expect(scoped.status).toBe(201);
    const file = (await scoped.json()) as FileRecord;
    expect(file.scope_id).toBe(session.id);

    const list = (await (await fetch(`${base}/files?scope_id=${session.id}`)).json()) as { data: FileRecord[] };
    expect(list.data.map((f) => f.id)).toEqual([file.id]);
  });

  // ── file resources on a live session ────────────────────────────────

  it("writes a file resource added mid-session into the sandbox before the request returns", async () => {
    const session = await createSession(base);
    // Realize the sandbox first — this is the "session already has a
    // sandbox" case, where mount-at-sandbox-start would never run again.
    expect(await exec(base, session.id, "echo warm")).toContain("warm");

    const csv = "region,revenue\nemea,120\n";
    const file = await upload(base, "q3-sales.csv", csv, "text/csv", session.id);
    const res = await fetch(`${base}/sessions/${session.id}/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "file", file_id: file.id }),
    });
    expect(res.status).toBe(201);
    const resource = (await res.json()) as { type: string; file_id: string; mount_path: string };
    expect(resource).toMatchObject({ type: "file", file_id: file.id });
    // The response names where the agent will find it.
    expect(resource.mount_path).toBe("/mnt/session/uploads/q3-sales.csv");

    // No turn has run and nothing else was called: the file is already
    // there. (Subprocess sandbox: /mnt/… resolves under the workdir.)
    expect(await exec(base, session.id, "cat mnt/session/uploads/q3-sales.csv")).toContain("emea,120");
  });

  it("mounts the new file only — earlier uploads the agent edited are left alone", async () => {
    const session = await createSession(base);
    await exec(base, session.id, "echo warm");

    const first = await upload(base, "first.txt", "original", "text/plain", session.id);
    await attach(base, session.id, first.id);
    // The agent edits its copy…
    await exec(base, session.id, "printf 'edited-by-agent' > mnt/session/uploads/first.txt");

    // …then the user attaches something else.
    const second = await upload(base, "second.txt", "second", "text/plain", session.id);
    await attach(base, session.id, second.id);

    expect(await exec(base, session.id, "cat mnt/session/uploads/second.txt")).toContain("second");
    expect(await exec(base, session.id, "cat mnt/session/uploads/first.txt")).toContain("edited-by-agent");
  });

  it("realizes the sandbox and mounts when the session has not run yet", async () => {
    const session = await createSession(base);
    const file = await upload(base, "cold.txt", "cold-start", "text/plain", session.id);
    const resource = await attach(base, session.id, file.id);
    expect(resource.mount_path).toBe("/mnt/session/uploads/cold.txt");
    expect(await exec(base, session.id, "cat mnt/session/uploads/cold.txt")).toContain("cold-start");
  });

  it("404s a file resource for an unknown file and leaves no resource row", async () => {
    const session = await createSession(base);
    const res = await fetch(`${base}/sessions/${session.id}/resources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "file", file_id: "file-nope" }),
    });
    expect(res.status).toBe(404);
    const list = (await (await fetch(`${base}/sessions/${session.id}/resources`)).json()) as { data: unknown[] };
    expect(list.data).toEqual([]);
  });
});

describe("Node POST /v1/files — auth and tenant isolation", () => {
  let h: ProcessHandle;
  let origin: string;

  beforeAll(async () => {
    // Auth ON (no AUTH_DISABLED): better-auth email/password + API keys.
    h = await startMainNode({ dataDir: newDataDir("upload-auth") });
    origin = `http://localhost:${h.port}`;
  });

  afterAll(async () => {
    await killHard(h).catch(() => {});
    try { rmSync(h.dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  async function signUp(email: string): Promise<string> {
    const res = await fetch(`${origin}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password: "correct-horse-battery-1", name: email.split("@")[0] }),
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
    expect(cookie).toContain("session_token");
    return cookie;
  }

  async function mintApiKey(cookie: string): Promise<string> {
    const res = await fetch(`${origin}/v1/api_keys`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ name: "upload-test" }),
    });
    expect(res.status).toBe(201);
    return ((await res.json()) as { key: string }).key;
  }

  it("requires credentials", async () => {
    const res = await fetch(`${origin}/v1/files`, {
      method: "POST",
      body: multipart("a.txt", "x", "text/plain"),
    });
    expect(res.status).toBe(401);

    const badKey = await fetch(`${origin}/v1/files`, {
      method: "POST",
      headers: { "x-api-key": "oma_not_a_real_key" },
      body: multipart("a.txt", "x", "text/plain"),
    });
    expect(badKey.status).toBe(401);
  });

  it("accepts cookie and API-key callers and keeps each tenant's files to itself", async () => {
    const aliceCookie = await signUp(`alice-${randomBytes(4).toString("hex")}@example.com`);
    const bobCookie = await signUp(`bob-${randomBytes(4).toString("hex")}@example.com`);
    const aliceKey = await mintApiKey(aliceCookie);
    const bobKey = await mintApiKey(bobCookie);

    // Alice uploads with her session cookie (the console path)…
    const viaCookie = await fetch(`${origin}/v1/files`, {
      method: "POST",
      headers: { cookie: aliceCookie },
      body: multipart("alice-cookie.txt", "alice secret 1", "text/plain", { downloadable: "true" }),
    });
    expect(viaCookie.status).toBe(201);
    const cookieFile = (await viaCookie.json()) as FileRecord;

    // …and with her API key (the SDK / curl path).
    const viaKey = await fetch(`${origin}/v1/files`, {
      method: "POST",
      headers: { "x-api-key": aliceKey },
      body: multipart("alice-key.txt", "alice secret 2", "text/plain", { downloadable: "true" }),
    });
    expect(viaKey.status).toBe(201);
    const keyFile = (await viaKey.json()) as FileRecord;

    // Both land in the same tenant: either credential sees both.
    const aliceList = (await (
      await fetch(`${origin}/v1/files`, { headers: { "x-api-key": aliceKey } })
    ).json()) as { data: FileRecord[] };
    expect(aliceList.data.map((f) => f.id).sort()).toEqual([cookieFile.id, keyFile.id].sort());
    const own = await fetch(`${origin}/v1/files/${keyFile.id}/content`, { headers: { cookie: aliceCookie } });
    expect(await own.text()).toBe("alice secret 2");

    // Bob (another tenant) can't list, read, download or delete them.
    for (const headers of [{ "x-api-key": bobKey }, { cookie: bobCookie }] as Array<Record<string, string>>) {
      const list = (await (await fetch(`${origin}/v1/files`, { headers })).json()) as { data: FileRecord[] };
      expect(list.data).toEqual([]);
      for (const id of [cookieFile.id, keyFile.id]) {
        expect((await fetch(`${origin}/v1/files/${id}`, { headers })).status).toBe(404);
        expect((await fetch(`${origin}/v1/files/${id}/content`, { headers })).status).toBe(404);
        expect((await fetch(`${origin}/v1/files/${id}`, { method: "DELETE", headers })).status).toBe(404);
      }
    }
    // Still there for Alice after Bob's delete attempts.
    expect((await fetch(`${origin}/v1/files/${cookieFile.id}`, { headers: { "x-api-key": aliceKey } })).status).toBe(200);

    // Bob can't scope an upload to Alice's session, nor attach her file
    // to a session of his own.
    const aliceSession = await createSession(`${origin}/v1`, { "x-api-key": aliceKey });
    const crossScope = await fetch(`${origin}/v1/files`, {
      method: "POST",
      headers: { "x-api-key": bobKey },
      body: multipart("bob.txt", "x", "text/plain", { scope_id: aliceSession.id }),
    });
    expect(crossScope.status).toBe(404);

    const bobSession = await createSession(`${origin}/v1`, { "x-api-key": bobKey });
    const crossAttach = await fetch(`${origin}/v1/sessions/${bobSession.id}/resources`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": bobKey },
      body: JSON.stringify({ type: "file", file_id: keyFile.id }),
    });
    expect(crossAttach.status).toBe(404);
  });
});

// ── helpers ───────────────────────────────────────────────────────────

async function createSession(
  base: string,
  headers: Record<string, string> = {},
): Promise<{ id: string }> {
  const aRes = await fetch(`${base}/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ name: `upload-agent-${randomBytes(3).toString("hex")}`, model: "claude-haiku-4-5-20251001" }),
  });
  if (aRes.status !== 201) throw new Error(`agent create: ${aRes.status} ${await aRes.text()}`);
  const agent = (await aRes.json()) as { id: string };
  const sRes = await fetch(`${base}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ agent: agent.id, environment: "env_local_runtime" }),
  });
  if (sRes.status !== 201) throw new Error(`session create: ${sRes.status} ${await sRes.text()}`);
  return (await sRes.json()) as { id: string };
}

async function upload(
  base: string,
  filename: string,
  content: string,
  type: string,
  scopeId?: string,
): Promise<FileRecord> {
  const res = await fetch(`${base}/files`, {
    method: "POST",
    body: multipart(filename, content, type, scopeId ? { scope_id: scopeId } : {}),
  });
  if (res.status !== 201) throw new Error(`upload: ${res.status} ${await res.text()}`);
  return (await res.json()) as FileRecord;
}

async function attach(
  base: string,
  sessionId: string,
  fileId: string,
): Promise<{ mount_path: string }> {
  const res = await fetch(`${base}/sessions/${sessionId}/resources`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "file", file_id: fileId }),
  });
  if (res.status !== 201) throw new Error(`attach: ${res.status} ${await res.text()}`);
  return (await res.json()) as { mount_path: string };
}

async function exec(base: string, sessionId: string, command: string): Promise<string> {
  const res = await fetch(`${base}/sessions/${sessionId}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, timeout_ms: 30_000 }),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`exec ${command}: ${res.status} ${text}`);
  return text;
}

/** True when some file under `dir` holds exactly `bytes`. */
function findFileWithBytes(dir: string, bytes: Uint8Array): boolean {
  if (!existsSync(dir)) return false;
  const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
  const want = Buffer.from(bytes);
  const walk = (d: string): boolean => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        if (walk(full)) return true;
      } else if (readFileSync(full).equals(want)) {
        return true;
      }
    }
    return false;
  };
  return walk(dir);
}
