import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import type { AgentRecord } from "../../types/agent";
import { EditAgentDialog } from "./EditAgentDialog";

const agent: AgentRecord = {
  id: "agent_1",
  name: "Triage Bot",
  model: { id: "claude-sonnet-4-6", speed: "fast" },
  system: "You triage issues.",
  version: 3,
  tools: [{ type: "agent_toolset_20260401" }],
  skills: [
    { type: "anthropic", skill_id: "xlsx" },
    { type: "custom", skill_id: "skill_a" },
  ],
  created_at: "2026-09-01T00:00:00Z",
  _oma: { harness: "default", reasoning_level: "xhigh", memory: { mode: "shared", store_id: "memstore_1" } },
};

let posts: Array<Record<string, unknown>> = [];

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
});

beforeEach(() => {
  posts = [];
  server.use(
    http.get("*/v1/skills", () =>
      HttpResponse.json({ data: [{ id: "skill_a", name: "Release notes", description: "Writes release notes" }] }),
    ),
    http.get("*/v1/model_cards", () =>
      HttpResponse.json({ data: [{ id: "mc_1", model_id: "claude-sonnet-4-6", model: "claude-sonnet-4-6", provider: "ant" }] }),
    ),
    http.post("*/v1/agents/agent_1", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posts.push(body);
      return HttpResponse.json({ ...agent, ...body, version: 4 });
    }),
    http.get("*/v1/*", () => HttpResponse.json({ data: [] })),
  );
});

function renderDialog(onClose = vi.fn(), editAgent: AgentRecord = agent) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EditAgentDialog agent={editAgent} open onClose={onClose} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe("Edit agent", () => {
  it("sends only what changed, guarded by the version, keeping the model's speed and the document skills", async () => {
    const onClose = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    const body = posts[0];
    expect(body).toMatchObject({ version: 3, name: "Triage Bot 2", model: { id: "claude-sonnet-4-6", speed: "fast" } });
    // Skills, metadata and the engine settings were not touched: not sent.
    expect(body).not.toHaveProperty("skills");
    expect(body).not.toHaveProperty("metadata");
    expect(body).not.toHaveProperty("_oma");
    expect(body).not.toHaveProperty("tools");
  });

  it("shows the agent's reasoning level as itself and offers the five levels", async () => {
    renderDialog();
    const reasoning = await screen.findByRole("combobox", { name: "Reasoning" });
    expect(reasoning).toHaveTextContent("Extra High");
    fireEvent.keyDown(reasoning, { key: "Enter" });
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(labels).toHaveLength(5);
    for (const [i, name] of ["Low", "Medium (default)", "High", "Extra High", "Max"].entries()) {
      expect(labels[i]?.startsWith(name)).toBe(true);
    }
    fireEvent.click(screen.getByRole("option", { name: /^Medium/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    // The default is stored as unset.
    expect(posts[0]._oma).toEqual({ reasoning_level: null });
  });

  it("turning memory off keeps the store, so it comes back with its notes", async () => {
    renderDialog();
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Memory" })).getByRole("radio", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]._oma).toEqual({ memory: { mode: "off", store_id: "memstore_1" } });
  });

  it("an explicit Off on an agent that never chose is written, never null", async () => {
    renderDialog(vi.fn(), { ...agent, _oma: { harness: "default" } });
    const memory = screen.getByRole("radiogroup", { name: "Memory" });
    fireEvent.click(within(memory).getByRole("radio", { name: "Shared" }));
    fireEvent.click(within(memory).getByRole("radio", { name: "Off" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]._oma).toEqual({ memory: { mode: "off" } });
  });

  it("changing the custom skills keeps the document skills attached", async () => {
    renderDialog();
    fireEvent.click(await screen.findByRole("checkbox", { name: /Release notes/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].skills).toEqual([{ type: "anthropic", skill_id: "xlsx" }]);
  });

  it("offers Pi among the engines", async () => {
    renderDialog();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "Runs on" }), { key: "Enter" });
    expect(await screen.findByRole("option", { name: /Pi agent/ })).toBeInTheDocument();
  });

  it("asks before throwing changes away, and closes at once when there are none", async () => {
    const onClose = renderDialog();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape on a changed form asks first", async () => {
    const onClose = renderDialog();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByRole("alert")).toHaveTextContent("Discard your changes to this agent?");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("All settings opens the full form for the same agent", async () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "All settings" }));
    expect(await screen.findByRole("dialog", { name: "Edit Triage Bot" })).toBeInTheDocument();
    expect(await screen.findByRole("tab", { name: /Model and engine/ })).toBeInTheDocument();
  });
});
