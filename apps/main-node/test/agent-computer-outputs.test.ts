import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, realpath, mkdir, readFile, writeFile, symlink, unlink, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxExecutor } from "@open-managed-agents/sandbox";
import type { OutputsAdapter } from "@open-managed-agents/http-routes";
import { agentComputerOutputsAdapter } from "../src/lib/agent-computer-outputs";

const exec = promisify(execFile);
let directory: string;
let outputsPath: string;
let sandbox: SandboxExecutor;

function createAdapter(resolve = vi.fn(async (_tenant: string, _session: string) => ({ sandbox, outputsPath }))) {
  const fallback = {
    list: vi.fn<OutputsAdapter["list"]>(async () => []),
    read: vi.fn<OutputsAdapter["read"]>(async () => null),
    deleteAll: vi.fn(async () => {}),
  };
  return { adapter: agentComputerOutputsAdapter({ resolve, fallback }), fallback, resolve };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), "oma-computer-outputs-")));
  outputsPath = join(directory, "session-a", "outputs");
  await mkdir(outputsPath, { recursive: true });
  sandbox = {
    exec: async (command) => (await exec("/bin/sh", ["-c", command], { maxBuffer: 2 * 1024 * 1024 })).stdout,
    readFile: async () => { throw new Error("Downloads must use verified file descriptors"); },
    writeFile: async () => "",
  };
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("agent computer outputs", () => {
  it("lists and streams binary files directly from the computer", async () => {
    const filename = "report ' $(echo unchanged).png";
    const bytes = Buffer.alloc(1_300_000);
    for (let index = 0; index < bytes.length; index++) bytes[index] = index % 256;
    await writeFile(join(outputsPath, filename), bytes);
    const { adapter, fallback, resolve } = createAdapter();

    expect(await adapter.list("tenant-a", "session-a")).toEqual([{
      filename,
      size_bytes: bytes.length,
      media_type: "image/png",
      uploaded_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    }]);
    const output = await adapter.read("tenant-a", "session-a", filename);
    expect(output?.size).toBe(bytes.length);
    expect(output?.contentType).toBe("image/png");
    expect(Buffer.from(await new Response(output!.body).arrayBuffer())).toEqual(bytes);
    expect(resolve).toHaveBeenCalledWith("tenant-a", "session-a");
    expect(fallback.list).toHaveBeenCalledWith("tenant-a", "session-a");
    expect(fallback.read).not.toHaveBeenCalled();
  });

  it("retains S3 listings and downloads after recreation while preferring current computer files", async () => {
    await writeFile(join(outputsPath, "current.txt"), "current contents");
    const { adapter, fallback } = createAdapter();
    const retained = {
      filename: "retained.txt", size_bytes: 8,
      uploaded_at: "2026-01-01T00:00:00.000Z", media_type: "text/plain",
    };
    fallback.list.mockResolvedValue([retained, { ...retained, filename: "current.txt" }]);
    fallback.read.mockResolvedValue({
      body: Uint8Array.from(Buffer.from("retained")).buffer,
      size: 8,
      contentType: "text/plain",
    });

    const listing = await adapter.list("tenant-a", "session-a");
    expect(listing).toHaveLength(2);
    expect(listing).toContainEqual(retained);
    expect(listing?.find((file) => file.filename === "current.txt")?.size_bytes).toBe(16);
    const old = await adapter.read("tenant-a", "session-a", "retained.txt");
    expect(await new Response(old!.body).text()).toBe("retained");
    expect(fallback.read).toHaveBeenCalledWith("tenant-a", "session-a", "retained.txt");
    const current = await adapter.read("tenant-a", "session-a", "current.txt");
    expect(await new Response(current!.body).text()).toBe("current contents");
    expect(fallback.read).toHaveBeenCalledTimes(1);
  });

  it("does not list or read symlinks, directories, or paths outside the outputs directory", async () => {
    await writeFile(join(directory, "private.txt"), "private contents");
    await symlink(join(directory, "private.txt"), join(outputsPath, "escape.txt"));
    await mkdir(join(outputsPath, "nested"));
    const { adapter, resolve } = createAdapter();

    expect(await adapter.list("tenant-a", "session-a")).toEqual([]);
    expect(await adapter.read("tenant-a", "session-a", "escape.txt")).toBeNull();
    expect(await adapter.read("tenant-a", "session-a", "nested")).toBeNull();
    const resolvedBefore = resolve.mock.calls.length;
    for (const filename of ["../private.txt", "/private.txt", "nested/file.txt", "..", "a\\b", "bad\0name"]) {
      expect(await adapter.read("tenant-a", "session-a", filename)).toBeNull();
    }
    expect(resolve).toHaveBeenCalledTimes(resolvedBefore);
  });

  it("rejects symlinks replacing the outputs directory or one of its ancestors", async () => {
    await writeFile(join(outputsPath, "report.txt"), "only accessible through the real directory");
    await symlink(join(directory, "session-a"), join(directory, "linked-session"));
    const parentLink = createAdapter(vi.fn(async () => ({ sandbox, outputsPath: join(directory, "linked-session", "outputs") })));
    expect(await parentLink.adapter.list("tenant-a", "session-a")).toEqual([]);
    expect(await parentLink.adapter.read("tenant-a", "session-a", "report.txt")).toBeNull();

    const second = join(directory, "session-b");
    await mkdir(second);
    await symlink(outputsPath, join(second, "outputs"));
    const outputLink = createAdapter(vi.fn(async () => ({ sandbox, outputsPath: join(second, "outputs") })));
    expect(await outputLink.adapter.list("tenant-a", "session-b")).toEqual([]);
    await outputLink.adapter.deleteAll("tenant-a", "session-b");
    expect(await readFile(join(outputsPath, "report.txt"), "utf8")).toContain("only accessible");
  });

  it("deletes only this session's output contents, without following nested symlinks", async () => {
    const sibling = join(directory, "session-b", "outputs");
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, "keep.txt"), "other session");
    await mkdir(join(outputsPath, "nested"));
    await writeFile(join(outputsPath, "nested", "remove.txt"), "generated file");
    await symlink(sibling, join(outputsPath, "external"));
    const { adapter, fallback } = createAdapter();

    await adapter.deleteAll("tenant-a", "session-a");

    expect(await readdir(outputsPath)).toEqual([]);
    expect(await readFile(join(sibling, "keep.txt"), "utf8")).toBe("other session");
    expect(fallback.deleteAll).toHaveBeenCalledWith("tenant-a", "session-a");
  });

  it("refuses a symlink substituted between download chunks", async () => {
    const outputFile = join(outputsPath, "report.bin");
    const privateFile = join(directory, "private.bin");
    await writeFile(outputFile, Buffer.alloc(1_300_000, 1));
    await writeFile(privateFile, Buffer.alloc(1_300_000, 2));
    const originalExec = sandbox.exec;
    let calls = 0;
    sandbox.exec = async (command, timeout) => {
      calls++;
      if (calls === 2) {
        await unlink(outputFile);
        await symlink(privateFile, outputFile);
      }
      return originalExec(command, timeout);
    };
    const { adapter } = createAdapter();
    const output = await adapter.read("tenant-a", "session-a", "report.bin");

    await expect(new Response(output!.body).arrayBuffer()).rejects.toThrow("Output is no longer available");
  });

  it("uses the existing adapter for sessions without an agent computer", async () => {
    const resolve = vi.fn(async () => null);
    const fallback = { list: vi.fn(async () => []), read: vi.fn(async () => null), deleteAll: vi.fn(async () => {}) };
    const adapter = agentComputerOutputsAdapter({ resolve, fallback });

    expect(await adapter.list("tenant-b", "session-local")).toEqual([]);
    expect(await adapter.read("tenant-b", "session-local", "report.txt")).toBeNull();
    await adapter.deleteAll("tenant-b", "session-local");
    expect(fallback.list).toHaveBeenCalledWith("tenant-b", "session-local");
    expect(fallback.read).toHaveBeenCalledWith("tenant-b", "session-local", "report.txt");
    expect(fallback.deleteAll).toHaveBeenCalledWith("tenant-b", "session-local");
  });
});
