import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";

import { ApprovalControls } from "./ApprovalControls";

// Port of main's ToolConfirmationControls tests: what a person can do with
// a call the session is blocked on, and what reaches the server.

// The real api() against msw: lib/server-features keeps the real module
// (mocks/handlers imports it during setup), so the server is mocked, not useApi.
vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

let features: string[] = [];
let role = "owner";
let failPost = false;
let sent: Array<{ path: string; body: unknown }> = [];
beforeEach(() => {
  features = [];
  role = "owner";
  failPost = false;
  sent = [];
  const post = async ({ request }: { request: Request }) => {
    sent.push({ path: new URL(request.url).pathname, body: await request.json() });
    return failPost ? HttpResponse.json({ error: "boom" }, { status: 500 }) : HttpResponse.json({ accepted: true });
  };
  server.use(
    http.get("*/v1/server_features", () => HttpResponse.json({ features })),
    http.get("*/v1/workspace/access", () => HttpResponse.json({ authorization: { role, kind: "user" }, budgets_supported: false })),
    http.get("*/v1/operations", () => HttpResponse.json({ sessions: [], work_items: [], missions: [] })),
    http.post("*/v1/sessions/:id/events", post),
    http.post("*/v1/operations/sessions/:id/approvals", post),
  );
});
afterEach(() => cleanup());

const wrap = (node: ReactNode) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{node}</QueryClientProvider>);

const posts = () => sent.map((p) => [p.path]);
const posted = () => sent[0].body as { events: Array<Record<string, unknown>> } & Record<string, unknown>;

/** The buttons are enabled once the server has said what it can do. */
const allowButton = async () => {
  const button = await screen.findByRole("button", { name: "Allow this call" });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
};

describe("ApprovalControls", () => {
  it("allows with a user.tool_confirmation event on the session", async () => {
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_1" />);
    fireEvent.click(await allowButton());
    expect(await screen.findByText(/^Allowed\. The agent is picking/)).toHaveAttribute("role", "status");
    expect(posts()[0][0]).toBe("/v1/sessions/sess-1/events");
    expect(posted()).toEqual({ events: [{ type: "user.tool_confirmation", tool_use_id: "call_1", result: "allow" }] });
  });

  it("denies in a second step, with the optional reason as deny_message", async () => {
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_2" />);
    await allowButton();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    // Nothing is sent until the deny is confirmed.
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/Tell the agent why/), { target: { value: "  not on prod  " } });
    fireEvent.click(screen.getByRole("button", { name: "Deny this call" }));
    expect(await screen.findByText(/^Denied\./)).toHaveAttribute("role", "status");
    expect(posted()).toEqual({
      events: [{ type: "user.tool_confirmation", tool_use_id: "call_2", result: "deny", deny_message: "not on prod" }],
    });
  });

  it("omits deny_message when no reason is given and addresses a sub-agent's thread", async () => {
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_3" threadId="sthr_worker" />);
    await allowButton();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.click(screen.getByRole("button", { name: "Deny this call" }));
    await screen.findByText(/^(Allowed|Denied)\./);
    expect(posted()).toEqual({
      events: [{ type: "user.tool_confirmation", tool_use_id: "call_3", result: "deny", session_thread_id: "sthr_worker" }],
    });
  });

  it("never names the main thread", async () => {
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_5" threadId="sthr_primary" />);
    fireEvent.click(await allowButton());
    await screen.findByText(/^(Allowed|Denied)\./);
    expect(posted().events[0]).not.toHaveProperty("session_thread_id");
  });

  it("goes back from the deny step with Back or Escape", async () => {
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_6" server="Linear" tool="create issue" />);
    await allowButton();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    expect(screen.getByText(/Linear · create issue does not run/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Allow this call" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.keyDown(screen.getByLabelText(/Tell the agent why/), { key: "Escape" });
    expect(screen.getByRole("button", { name: "Allow this call" })).toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });

  it("keeps the controls available after a failed post, and says it failed", async () => {
    failPost = true;
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_4" />);
    fireEvent.click(await allowButton());
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow this call" })).toBeEnabled();
    expect(screen.queryByText(/^Allowed\./)).toBeNull();
  });

  it("goes through the operations endpoint when the server has one", async () => {
    features = ["operations"];
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_7" />);
    fireEvent.click(await allowButton());
    await screen.findByText(/^(Allowed|Denied)\./);
    expect(posts()[0][0]).toBe("/v1/operations/sessions/sess-1/approvals");
    expect(posted()).toEqual({ tool_use_id: "call_7", result: "allow" });
  });

  it("still sends a reason through the session's events, which the operations endpoint would drop", async () => {
    features = ["operations"];
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_8" />);
    await allowButton();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(screen.getByLabelText(/Tell the agent why/), { target: { value: "no" } });
    fireEvent.click(screen.getByRole("button", { name: "Deny this call" }));
    await screen.findByText(/^(Allowed|Denied)\./);
    expect(posts()[0][0]).toBe("/v1/sessions/sess-1/events");
  });

  it("is locked for a viewer when the server reports roles", async () => {
    features = ["workspace_access"];
    role = "viewer";
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_9" />);
    expect(await screen.findByText("Operator access is required to approve tools.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Allow this call" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toBeDisabled();
  });

  it("is open to an operator when the server reports roles", async () => {
    features = ["workspace_access"];
    role = "operator";
    wrap(<ApprovalControls sessionId="sess-1" toolUseId="call_10" />);
    await allowButton();
    expect(screen.queryByText(/Operator access is required/)).toBeNull();
  });
});
