import { describe, expect, it, vi } from "vitest";
import {
  AttachmentError,
  attachmentsOf,
  buildAttachmentNote,
  buildUserMessageEvent,
  prepareAttachments,
  type MessageAttachment,
} from "./attachments";

/** Fake `api()` recording every call; `respond` decides each outcome. */
function fakeApi(respond: (path: string, init?: RequestInit) => unknown) {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  const api = vi.fn(async (path: string, init?: RequestInit) => {
    calls.push({ path, init });
    return respond(path, init);
  });
  return { api: api as never, calls };
}

const csv = () => new File(["a,b\n1,2\n"], "sales.csv", { type: "text/csv" });
const png = () => new File([new Uint8Array([137, 80, 78, 71])], "chart.png", { type: "image/png" });

describe("prepareAttachments", () => {
  it("uploads a non-image file, attaches it as a session resource, and records its sandbox path", async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === "/v1/files") {
        return { id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8 };
      }
      if (path === "/v1/sessions/sess-1/resources") {
        return { id: "res-1", type: "file", file_id: "file-1", mount_path: "/mnt/session/uploads/sales.csv" };
      }
      throw new Error(`unexpected ${path}`);
    });

    const out = await prepareAttachments(api, "sess-1", [csv()]);

    expect(out).toEqual([
      {
        file_id: "file-1",
        filename: "sales.csv",
        media_type: "text/csv",
        size_bytes: 8,
        kind: "file",
        path: "/mnt/session/uploads/sales.csv",
      },
    ]);
    // Upload is multipart, scoped to the session.
    expect(calls[0].path).toBe("/v1/files");
    const fd = calls[0].init?.body as FormData;
    expect(fd).toBeInstanceOf(FormData);
    expect((fd.get("file") as File).name).toBe("sales.csv");
    expect(fd.get("scope_id")).toBe("sess-1");
    // Then the resource attach — which is what writes it into the sandbox.
    expect(calls[1].path).toBe("/v1/sessions/sess-1/resources");
    expect(JSON.parse(calls[1].init?.body as string)).toEqual({ type: "file", file_id: "file-1" });
  });

  it("sends images inline — no session resource", async () => {
    const { api, calls } = fakeApi(() => ({
      id: "file-2", filename: "chart.png", media_type: "image/png", size_bytes: 4,
    }));
    const out = await prepareAttachments(api, "sess-1", [png()]);
    expect(out).toEqual([
      { file_id: "file-2", filename: "chart.png", media_type: "image/png", size_bytes: 4, kind: "image" },
    ]);
    expect(calls.map((c) => c.path)).toEqual(["/v1/files"]);
  });

  it("falls back to the file-id path when the runtime doesn't report one", async () => {
    const { api } = fakeApi((path) =>
      path === "/v1/files"
        ? { id: "file-9", filename: "notes.md", media_type: "text/markdown", size_bytes: 3 }
        : { id: "res-9", type: "file", file_id: "file-9" },
    );
    const [a] = await prepareAttachments(api, "sess-1", [new File(["hey"], "notes.md")]);
    expect(a.path).toBe("/mnt/session/uploads/file-9");
  });

  it("rejects with the file's name when the upload fails, and stops", async () => {
    const { api, calls } = fakeApi((path) => {
      if (path === "/v1/files") throw new Error("Upload too large: 30000000 bytes exceeds limit of 26214400 bytes");
      throw new Error(`unexpected ${path}`);
    });
    const err = await prepareAttachments(api, "sess-1", [csv(), png()]).catch((e) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as AttachmentError).filename).toBe("sales.csv");
    expect((err as Error).message).toContain('Couldn\'t attach "sales.csv"');
    expect((err as Error).message).toContain("Upload too large");
    // The second file was never attempted.
    expect(calls).toHaveLength(1);
  });

  it("rejects when the sandbox write fails — an uploaded-but-unmounted file is still a failure", async () => {
    const { api } = fakeApi((path) => {
      if (path === "/v1/files") return { id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8 };
      throw new Error("File could not be written to the session sandbox: disk full");
    });
    const err = await prepareAttachments(api, "sess-1", [csv()]).catch((e) => e);
    expect(err).toBeInstanceOf(AttachmentError);
    expect((err as Error).message).toContain("disk full");
  });

  it("does not re-upload files that succeeded before a failed send", async () => {
    const cache = new WeakMap<File, MessageAttachment>();
    const good = png();
    const bad = csv();
    let failCsv = true;
    const { api, calls } = fakeApi((path, init) => {
      if (path === "/v1/files") {
        const name = ((init?.body as FormData).get("file") as File).name;
        if (name === "sales.csv" && failCsv) throw new Error("boom");
        return name === "chart.png"
          ? { id: "file-img", filename: name, media_type: "image/png", size_bytes: 4 }
          : { id: "file-csv", filename: name, media_type: "text/csv", size_bytes: 8 };
      }
      return { id: "res", type: "file", file_id: "file-csv", mount_path: "/mnt/session/uploads/sales.csv" };
    });

    await expect(prepareAttachments(api, "sess-1", [good, bad], cache)).rejects.toBeInstanceOf(AttachmentError);
    failCsv = false;
    const out = await prepareAttachments(api, "sess-1", [good, bad], cache);

    expect(out.map((a) => a.file_id)).toEqual(["file-img", "file-csv"]);
    const uploads = calls.filter((c) => c.path === "/v1/files");
    // chart.png once; sales.csv twice (failed, then retried).
    expect(uploads.map((c) => ((c.init?.body as FormData).get("file") as File).name)).toEqual([
      "chart.png", "sales.csv", "sales.csv",
    ]);
  });
});

describe("buildUserMessageEvent", () => {
  const file: MessageAttachment = {
    file_id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 2048,
    kind: "file", path: "/mnt/session/uploads/sales.csv",
  };
  const image: MessageAttachment = {
    file_id: "file-2", filename: "chart.png", media_type: "image/png", size_bytes: 10, kind: "image",
  };

  it("keeps the user's words first and tells the agent where the files are in a later block", () => {
    const ev = buildUserMessageEvent("summarise this", [file, image]);
    expect(ev.content[0]).toEqual({ type: "text", text: "summarise this" });
    expect(ev.content[1]).toEqual({ type: "image", source: { type: "file", file_id: "file-2" } });
    const note = ev.content[2] as { type: "text"; text: string };
    expect(note.type).toBe("text");
    expect(note.text).toContain("/mnt/session/uploads/sales.csv");
    expect(note.text).toContain("sales.csv, text/csv, 2.0 KB");
    // Images are inline — they aren't listed as sandbox files.
    expect(note.text).not.toContain("chart.png");
    expect(ev.metadata).toEqual({ attachments: [file, image] });
    expect(attachmentsOf(ev)).toEqual([file, image]);
  });

  it("labels an attachment-only message and adds no note for images alone", () => {
    const ev = buildUserMessageEvent("", [image]);
    expect(ev.content).toEqual([
      { type: "text", text: "Attached 1 file." },
      { type: "image", source: { type: "file", file_id: "file-2" } },
    ]);
  });

  it("is a plain text message with no attachments", () => {
    expect(buildUserMessageEvent("hi", [])).toEqual({
      type: "user.message",
      content: [{ type: "text", text: "hi" }],
    });
    expect(buildAttachmentNote([])).toBe("");
  });
});
