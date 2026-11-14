// Files in both directions through the real SessionDetail page:
//   in  — attach a non-image file in the composer → uploaded, attached as a
//         session resource, and named (with its sandbox path) to the agent;
//         a failed upload is surfaced and nothing is sent.
//   out — links in agent messages to output files download the session
//         output instead of navigating to an app route.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { toast } from "sonner";
import { server } from "../mocks/server";
import { resetSessionOutputsStore } from "../lib/session-outputs";
import { SessionDetail } from "./SessionDetail";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  // StickToBottom (Conversation) needs these in jsdom.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollTo ??= function () {};
  // jsdom has no object URLs; the composer makes one per picked file and
  // downloads save through one.
  URL.createObjectURL = vi.fn(() => "blob:mock");
  URL.revokeObjectURL = vi.fn();
});

let history: Array<Record<string, unknown>> = [];
/** POSTs the page made through api(), in order. */
let posts: Array<{ path: string; body: unknown }> = [];
/** Per-test override for POST responses; default succeeds. */
let onPost: (path: string) => unknown = () => ({});
/** Output listing + download requests that reached the network layer. */
let outputFetches: string[] = [];
let outputs: Array<Record<string, unknown>> = [];

beforeEach(() => {
  resetSessionOutputsStore();
  posts = [];
  outputFetches = [];
  outputs = [];
  onPost = () => ({});
  vi.mocked(toast.error).mockClear();
  api.mockReset();
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push({ path, body: init.body instanceof FormData ? init.body : JSON.parse(String(init.body)) });
      return onPost(path);
    }
    if (path.startsWith("/v1/sessions/sess-1/events")) {
      return { data: history.map((data, i) => ({ seq: i + 1, type: data.type, data })), has_more: false };
    }
    if (path === "/v1/sessions/sess-1") return { agent: { id: "agent-1", name: "QA agent" } };
    if (path.endsWith("/trajectory")) return { outcome: "success" };
    if (path.endsWith("/threads") || path.endsWith("/pending")) return { data: [] };
    throw new Error(`unexpected ${path}`);
  });
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

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

const mount = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/sessions/sess-1"]}>
        <Where />
        <Routes>
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="*" element={<div>WRONG ROUTE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const csv = () => new File(["a,b\n1,2\n"], "sales.csv", { type: "text/csv" });

async function pickAndSend(file: File, text: string) {
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(picker, { target: { files: [file] } });
  // The pending attachment shows as a chip with its name and size.
  const chips = await screen.findByTestId("composer-attachments");
  expect(within(chips).getByText("sales.csv")).toBeInTheDocument();
  expect(within(chips).getByText("8 B")).toBeInTheDocument();

  const box = screen.getByPlaceholderText(/Send a message/);
  fireEvent.change(box, { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Submit" }));
  return box as HTMLTextAreaElement;
}

describe("SessionDetail attach flow", () => {
  it("offers 'Attach file' for any file type, not images only", async () => {
    history = [];
    mount();
    expect(await screen.findByRole("button", { name: "Attach file" })).toBeInTheDocument();
    const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    expect(picker.getAttribute("accept")).toBeNull();
    expect(picker.multiple).toBe(true);
  });

  it("uploads a non-image file, attaches it as a session resource, then tells the agent its path", async () => {
    history = [];
    onPost = (path) => {
      if (path === "/v1/files") return { id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8 };
      if (path === "/v1/sessions/sess-1/resources") {
        return { id: "res-1", type: "file", file_id: "file-1", mount_path: "/mnt/session/uploads/sales.csv" };
      }
      return {};
    };
    mount();
    await screen.findByRole("button", { name: "Attach file" });
    await pickAndSend(csv(), "summarise this");

    await waitFor(() => expect(posts.map((p) => p.path)).toEqual([
      "/v1/files",
      // resource attach lands BEFORE the message that starts the turn
      "/v1/sessions/sess-1/resources",
      "/v1/sessions/sess-1/events",
    ]));
    expect(((posts[0].body as FormData).get("file") as File).name).toBe("sales.csv");
    expect(posts[1].body).toEqual({ type: "file", file_id: "file-1" });

    const [event] = (posts[2].body as { events: Array<Record<string, any>> }).events;
    expect(event.type).toBe("user.message");
    // The user's words stay the first (visible) block…
    expect(event.content[0]).toEqual({ type: "text", text: "summarise this" });
    // …and the model-readable attachment line rides in a later one.
    expect(event.content[1].text).toContain("/mnt/session/uploads/sales.csv");
    expect(event.content[1].text).toMatch(/attached/i);
    expect(event.metadata.attachments).toEqual([
      expect.objectContaining({ file_id: "file-1", kind: "file", path: "/mnt/session/uploads/sales.csv" }),
    ]);
    // Sent → the composer's pending attachment is cleared.
    await waitFor(() => expect(screen.queryByTestId("composer-attachments")).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("surfaces a failed upload, sends nothing, and keeps the text + file for a retry", async () => {
    history = [];
    onPost = (path) => {
      if (path === "/v1/files") throw new Error("Upload too large: limit is 26214400 bytes");
      return {};
    };
    mount();
    await screen.findByRole("button", { name: "Attach file" });
    const box = await pickAndSend(csv(), "summarise this");

    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    const message = String(vi.mocked(toast.error).mock.calls[0][0]);
    expect(message).toContain('Couldn\'t attach "sales.csv"');
    expect(message).toContain("Upload too large");
    expect(message).toContain("not sent");

    // No user.message went out, and the file was not silently dropped.
    expect(posts.map((p) => p.path)).toEqual(["/v1/files"]);
    expect(within(screen.getByTestId("composer-attachments")).getByText("sales.csv")).toBeInTheDocument();
    await waitFor(() => expect(box.value).toBe("summarise this"));
  });

  it("shows attachment chips on a sent message and hides the path note from the bubble", async () => {
    history = [
      {
        type: "user.message", id: "u1", ts: "2026-11-10T10:00:00.000Z",
        content: [
          { type: "text", text: "summarise this" },
          { type: "text", text: "[Attached file — …]\n- /mnt/session/uploads/sales.csv (sales.csv, text/csv, 8 B)" },
        ],
        metadata: { attachments: [{ file_id: "file-1", filename: "sales.csv", media_type: "text/csv", size_bytes: 8, kind: "file", path: "/mnt/session/uploads/sales.csv" }] },
      },
    ];
    mount();
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
    outputs = [
      { filename: "competitors.md", size_bytes: 2048, uploaded_at: "2026-11-10T10:00:20.000Z", media_type: "text/markdown" },
    ];
    // jsdom would try to navigate to the blob: URL the download helper clicks.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  it("downloads a bare relative filename that matches a session output — never an app route", async () => {
    history = turn("Saved the analysis to [competitors.md](competitors.md).");
    mount();
    const link = await screen.findByRole("link", { name: /competitors\.md/ });
    await waitFor(() => expect(link.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md"));

    fireEvent.click(link);

    await waitFor(() => expect(outputFetches).toContain("download:competitors.md"));
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
    expect(screen.queryByText("WRONG ROUTE")).toBeNull();
  });

  it("downloads sandbox:/mnt/session/outputs/… and plain /mnt/session/outputs/… links", async () => {
    history = turn(
      "See [the report](sandbox:/mnt/session/outputs/competitors.md) or [same file](/mnt/session/outputs/competitors.md).",
    );
    mount();
    const sandbox = await screen.findByRole("link", { name: /the report/ });
    const plain = screen.getByRole("link", { name: /same file/ });
    expect(sandbox.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md");
    expect(plain.getAttribute("href")).toBe("/v1/sessions/sess-1/outputs/competitors.md");

    fireEvent.click(sandbox);
    fireEvent.click(plain);

    await waitFor(() =>
      expect(outputFetches.filter((f) => f === "download:competitors.md")).toHaveLength(2),
    );
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
  });

  it("does not navigate for a relative link that isn't a session output", async () => {
    history = turn("Draft is at [notes](drafts.md).");
    mount();
    const link = await screen.findByRole("link", { name: /notes/ });
    expect(link.getAttribute("href")).toBe("#");

    fireEvent.click(link);

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(`"drafts.md" isn't in this session's files.`));
    expect(outputFetches.some((f) => f.startsWith("download:"))).toBe(false);
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
    // The click re-listed outputs, which re-renders the transcript. The
    // link must survive that as the same DOM node — a remounted link is
    // detached mid-click and its default navigation goes through.
    expect(outputFetches.filter((f) => f === "list").length).toBeGreaterThan(1);
    expect(link.isConnected).toBe(true);
  });

  it("lists the turn's outputs in a Files strip under the agent message, with Download", async () => {
    history = turn("Done.");
    mount();
    const strip = await screen.findByTestId("turn-files");
    fireEvent.click(within(strip).getByRole("button", { name: "Download competitors.md" }));
    await waitFor(() => expect(outputFetches).toContain("download:competitors.md"));
  });
});
