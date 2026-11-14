// Files in both directions through the real SessionDetail page (ported from
// main's SessionDetail.files test, rewritten for Muse's composer and
// conversation):
//   in  — any file can be attached; a non-image is uploaded, attached to the
//         session as a resource and named (with its sandbox path) to the
//         agent; a failed upload is said next to the box and nothing is sent;
//         a sent message shows its files as chips, not the path note.
//   out — links in agent messages to output files download them instead of
//         navigating to an app route; each turn lists the files it wrote.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";

import { server } from "../mocks/server";
import { resetSessionOutputsStore } from "../lib/session-outputs";
import { installDomShims, mountSession, newRig, rigApi, type PageRig } from "./session-detail/test-page";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  installDomShims();
  // jsdom has no object URLs; downloads save through one.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

let rig: PageRig;
/** Output listing + download requests that reached the network layer. */
let outputFetches: string[] = [];
let outputs: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetSessionOutputsStore();
  try {
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
  rig = newRig();
  outputFetches = [];
  outputs = [];
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.info).mockClear();
  rigApi(api, rig);
  server.use(
    http.get("*/v1/sessions/sess-1/outputs", () => {
      outputFetches.push("list");
      return HttpResponse.json({ data: outputs, has_more: false });
    }),
    http.get("*/v1/sessions/sess-1/outputs/:filename", ({ params }) => {
      outputFetches.push(`download:${String(params.filename)}`);
      return new HttpResponse("# file body", { headers: { "content-type": "text/markdown" } });
    }),
  );
});

afterEach(() => vi.restoreAllMocks());

const csv = () => new File(["a,b\n1,2\n"], "sales.csv", { type: "text/csv" });

async function pick(file: File) {
  await screen.findByRole("button", { name: "Attach files" });
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [file] } });
  // The pending attachment shows as a chip with its name and size.
  const chips = await screen.findByTestId("composer-attachments");
  expect(within(chips).getByText("sales.csv")).toBeInTheDocument();
  expect(within(chips).getByText("8 B")).toBeInTheDocument();
}

async function pickAndSend(file: File, text: string) {
  await pick(file);
  const box = screen.getByRole("textbox", { name: "Message QA agent" }) as HTMLTextAreaElement;
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
  return box;
}

describe("SessionDetail attach flow", () => {
  it("offers to attach any kind of file, not images only", async () => {
    mountSession();
    expect(await screen.findByRole("button", { name: "Attach files" })).toBeInTheDocument();
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker.getAttribute("accept")).toBeNull();
    expect(picker.multiple).toBe(true);
  });

  it("takes a CSV without a refusal: no notice, the chip waits to be sent", async () => {
    mountSession();
    await pick(csv());
    expect(screen.queryByText(/was not attached/)).toBeNull();
    expect(screen.queryByText(/images only/i)).toBeNull();
  });

  it("uploads a non-image file, attaches it as a session resource, then tells the agent its path", async () => {
    rig.onPost = (path) => {
      if (path === "/v1/files") return { id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8 };
      if (path === "/v1/sessions/sess-1/resources") {
        return { id: "res-1", type: "file", file_id: "file-1", mount_path: "/mnt/session/uploads/sales.csv" };
      }
      return {};
    };
    mountSession();
    await pickAndSend(csv(), "summarise this");

    await waitFor(() =>
      expect(rig.posts.map((p) => p.path)).toEqual([
        "/v1/files",
        // The resource is attached BEFORE the message that starts the turn.
        "/v1/sessions/sess-1/resources",
        "/v1/sessions/sess-1/events",
      ]),
    );
    const form = rig.posts[0].body as FormData;
    expect((form.get("file") as File).name).toBe("sales.csv");
    expect(form.get("scope_id")).toBe("sess-1");
    expect(rig.posts[1].body).toEqual({ type: "file", file_id: "file-1" });

    const [event] = (rig.posts[2].body as { events: Array<Record<string, any>> }).events;
    expect(event.type).toBe("user.message");
    // The person's words stay the first (visible) block…
    expect(event.content[0]).toEqual({ type: "text", text: "summarise this" });
    // …and the model-readable attachment line rides in a later one.
    expect(event.content[1].text).toContain("/mnt/session/uploads/sales.csv");
    expect(event.content[1].text).toMatch(/attached/i);
    expect(event.metadata.attachments).toEqual([
      expect.objectContaining({ file_id: "file-1", kind: "file", path: "/mnt/session/uploads/sales.csv" }),
    ]);
    // Sent: the box no longer holds the attachment.
    await waitFor(() => expect(screen.queryByTestId("composer-attachments")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("sends an image inline as a picture, with no resource and no path note", async () => {
    rig.onPost = (path) =>
      path === "/v1/files" ? { id: "img-1", filename: "chart.png", media_type: "image/png", size_bytes: 3 } : {};
    mountSession();
    await screen.findByRole("button", { name: "Attach files" });
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    fireEvent.change(picker, { target: { files: [new File(["png"], "chart.png", { type: "image/png" })] } });
    await screen.findByTestId("composer-attachments");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(rig.posts.map((p) => p.path)).toEqual(["/v1/files", "/v1/sessions/sess-1/events"]));
    const [event] = (rig.posts[1].body as { events: Array<Record<string, any>> }).events;
    expect(event.content).toEqual([
      { type: "text", text: "Attached 1 file." },
      { type: "image", source: { type: "file", file_id: "img-1" } },
    ]);
  });

  it("says a failed upload next to the box, sends nothing, and keeps the text and the file for a retry", async () => {
    rig.onPost = (path) => {
      if (path === "/v1/files") throw new Error("Upload too large: limit is 26214400 bytes");
      return {};
    };
    mountSession();
    const box = await pickAndSend(csv(), "summarise this");

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("“sales.csv” could not be uploaded, so nothing was sent");
    expect(notice).toHaveTextContent("Your message is back in the box below.");
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeInTheDocument();

    // No user.message went out, and the file was not silently dropped.
    expect(rig.posts.map((p) => p.path)).toEqual(["/v1/files"]);
    expect(within(screen.getByTestId("composer-attachments")).getByText("sales.csv")).toBeInTheDocument();
    await waitFor(() => expect(box.value).toBe("summarise this"));
  });

  it("refuses a file over 25 MB by name, and attaches nothing", async () => {
    mountSession();
    await screen.findByRole("button", { name: "Attach files" });
    const big = new File(["x"], "video.mov", { type: "video/quicktime" });
    Object.defineProperty(big, "size", { value: 26 * 1024 * 1024 });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [big] } });
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("“video.mov” was not attached");
    expect(notice).toHaveTextContent("A file can be up to 25 MB.");
    expect(screen.queryByTestId("composer-attachments")).toBeNull();
  });

  it("shows attachment chips on a sent message and keeps the path note out of the bubble", async () => {
    rig.history = [
      {
        type: "user.message",
        id: "u1",
        ts: "2026-11-10T10:00:00.000Z",
        content: [
          { type: "text", text: "summarise this" },
          { type: "text", text: "[Attached file — …]\n- /mnt/session/uploads/sales.csv (sales.csv, text/csv, 8 B)" },
        ],
        metadata: {
          attachments: [
            { file_id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8, kind: "file", path: "/mnt/session/uploads/sales.csv" },
          ],
        },
      },
    ];
    mountSession();
    const chips = await screen.findByTestId("message-attachments");
    expect(within(chips).getByText("sales.csv")).toBeInTheDocument();
    expect(screen.getByText("summarise this")).toBeInTheDocument();
    expect(screen.queryByText(/Attached file —/)).toBeNull();
  });
});

describe("SessionDetail output links", () => {
  const turn = (text: string) => [
    { type: "user.message", id: "u1", ts: "2026-11-10T10:00:00.000Z", content: [{ type: "text", text: "research competitors" }] },
    { type: "session.status_running", id: "r1", ts: "2026-11-10T10:00:01.000Z" },
    { type: "agent.message", id: "a1", ts: "2026-11-10T10:00:30.000Z", content: [{ type: "text", text }] },
    { type: "session.status_idle", id: "i1", ts: "2026-11-10T10:00:31.000Z", stop_reason: { type: "end_turn" } },
  ];

  beforeEach(() => {
    outputs = [{ filename: "competitors.md", size_bytes: 2048, uploaded_at: "2026-11-10T10:00:20.000Z", media_type: "text/markdown" }];
    // jsdom would try to navigate to the blob: URL the download helper clicks.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("downloads a bare relative filename that matches a session output — never an app route", async () => {
    rig.history = turn("Saved the analysis to [competitors.md](competitors.md).");
    mountSession();
    const link = await screen.findByRole("link", { name: /competitors\.md/ });
    await waitFor(() => expect(link.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md"));

    fireEvent.click(link);

    await waitFor(() => expect(outputFetches).toContain("download:competitors.md"));
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
    expect(screen.queryByText("WRONG ROUTE")).toBeNull();
  });

  it("downloads sandbox:/mnt/session/outputs/… and plain /mnt/session/outputs/… links", async () => {
    rig.history = turn("See [the report](sandbox:/mnt/session/outputs/competitors.md) or [same file](/mnt/session/outputs/competitors.md).");
    mountSession();
    const sandbox = await screen.findByRole("link", { name: /the report/ });
    const plain = screen.getByRole("link", { name: /same file/ });
    expect(sandbox.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md");
    expect(plain.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md");

    fireEvent.click(sandbox);
    fireEvent.click(plain);

    await waitFor(() => expect(outputFetches.filter((f) => f === "download:competitors.md")).toHaveLength(2));
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
  });

  it("does not navigate for a relative link that isn't a session output", async () => {
    rig.history = turn("Draft is at [notes](drafts.md).");
    mountSession();
    const link = await screen.findByRole("link", { name: /notes/ });
    expect(link.getAttribute("href")).toBe("#");

    fireEvent.click(link);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("“drafts.md” is not among this session's files."));
    expect(outputFetches.some((f) => f.startsWith("download:"))).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
    // The click listed the outputs again, which re-renders the transcript.
    // The link must survive that as the same DOM node: a remounted link is
    // detached mid-click and its default navigation goes through.
    expect(outputFetches.filter((f) => f === "list").length).toBeGreaterThan(1);
    expect(link.isConnected).toBe(true);
  });

  it("says a path elsewhere in the sandbox cannot be downloaded, and goes nowhere", async () => {
    rig.history = turn("Scratch work is in [scratch](/workspace/tmp/scratch.txt).");
    mountSession();
    const link = await screen.findByRole("link", { name: /scratch/ });
    fireEvent.click(link);
    await waitFor(() => expect(toast.info).toHaveBeenCalled());
    expect(String(vi.mocked(toast.info).mock.calls[0][0])).toContain("in the agent's sandbox");
    expect(outputFetches.some((f) => f.startsWith("download:"))).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
  });

  it("never makes a live link to the console's own sign-in routes", async () => {
    rig.history = turn("[Open the report](/v1/oauth/authorize?mcp_server_url=https://evil.example)");
    mountSession();
    await screen.findByText("Open the report");
    const anchor = screen.getByText("Open the report").closest("a");
    expect(anchor?.getAttribute("href") ?? "").not.toContain("/v1/oauth");
  });

  it("lists the turn's outputs in a Files row under the agent message, with Download", async () => {
    rig.history = turn("Done.");
    mountSession();
    const strip = await screen.findByTestId("turn-files");
    expect(within(strip).getByText("2.0 KB")).toBeInTheDocument();
    fireEvent.click(within(strip).getByRole("button", { name: "Download competitors.md" }));
    await waitFor(() => expect(outputFetches).toContain("download:competitors.md"));
  });
});
