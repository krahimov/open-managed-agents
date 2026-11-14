// The agent in the session bar (ported from main's SessionDetail.agent-link
// test, rewritten for Muse): its name is a real link to the agent's page, so
// cmd- and middle-click work, and the raw configuration stays one click
// away, from the details panel, without leaving the session.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route } from "react-router";

import { installDomShims, mountSession, newRig, rigApi, type PageRig } from "./session-detail/test-page";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(installDomShims);

let rig: PageRig;
beforeEach(() => {
  rig = newRig();
  rig.onGet = (path) =>
    path === "/v1/agents/agent-1" ? { id: "agent-1", name: "QA agent", model: "claude-sonnet-4-5", version: 3 } : undefined;
  rigApi(api, rig);
});

const mount = () => mountSession(<Route path="/agents/:id" element={<div>AGENT PAGE</div>} />);
const bar = () => document.querySelector<HTMLElement>('[data-slot="session-bar"]')!;

describe("SessionDetail agent link", () => {
  it("links the agent's name in the session bar straight to the agent page", async () => {
    mount();
    await waitFor(() => expect(within(bar()).getByRole("link", { name: "QA agent" })).toBeInTheDocument());
    const link = within(bar()).getByRole("link", { name: "QA agent" });
    expect(link).toHaveAttribute("href", "/agents/agent-1");
    // No detour through the configuration on the way there.
    expect(api).not.toHaveBeenCalledWith("/v1/agents/agent-1", expect.anything());

    fireEvent.click(link);
    expect(await screen.findByText("AGENT PAGE")).toBeInTheDocument();
  });

  it("keeps the agent's configuration one click away in the details panel, on the session page", async () => {
    mount();
    const panel = await screen.findByRole("complementary", { name: "Session details" });
    fireEvent.click(within(panel).getByRole("button", { name: "View the agent's configuration" }));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/agents/agent-1", expect.objectContaining({ silentErrors: true })));
    // The sheet shows the agent, and the session page stays put.
    expect(await screen.findByRole("dialog")).toHaveTextContent("QA agent");
    expect(screen.queryByText("AGENT PAGE")).toBeNull();
    expect(screen.getByTestId("where")).toHaveTextContent("/sessions/sess-1");
  });
});
