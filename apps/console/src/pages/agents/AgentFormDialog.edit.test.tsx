import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import type { ModelCard } from "@open-managed-agents/api-types";

import { server } from "../../mocks/server";
import type { AgentRecord } from "../../types/agent";
import { AgentFormDialog } from "./AgentFormDialog";

const customTool = {
  type: "custom",
  name: "deploy",
  description: "Deploy the app",
  input_schema: { type: "object", properties: {} },
};
const githubToolset = {
  type: "mcp_toolset",
  mcp_server_name: "github",
  default_config: { permission_policy: { type: "always_ask" } },
};

const agent: AgentRecord = {
  id: "agent_1",
  name: "Triage Bot",
  model: { id: "claude-sonnet-4-6", speed: "fast" },
  system: "You triage issues.",
  description: "Triages GitHub issues",
  version: 3,
  tools: [
    {
      type: "agent_toolset_20260401",
      default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      configs: [{ name: "web_search", enabled: false }],
    },
    githubToolset,
    customTool,
  ],
  mcp_servers: [{ name: "github", type: "url", url: "https://api.githubcopilot.com/mcp/" }],
  skills: [{ type: "anthropic", skill_id: "xlsx" }],
  metadata: { default_environment_id: "env_1", team: "platform" },
  created_at: "2026-09-01T00:00:00Z",
  _oma: { harness: "default", default_environment_id: "env_1" },
};

const modelCard: ModelCard = {
  id: "mc_1",
  model_id: "claude-sonnet-4-6",
  model: "claude-sonnet-4-6",
  provider: "ant",
  created_at: "2026-09-01T00:00:00Z",
};

let saved: Array<Record<string, unknown>> = [];

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
  saved = [];
  server.use(
    http.get("*/v1/composio/status", () => HttpResponse.json({ configured: false })),
    http.get("*/v1/environments", () =>
      HttpResponse.json({ data: [{ id: "env_1", name: "Default" }, { id: "env_2", name: "Other" }] }),
    ),
    http.get("*/v1/sandbox/config", () => HttpResponse.json({ provider: "subprocess" })),
    http.post("*/v1/agents/agent_1", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      saved.push(body);
      return HttpResponse.json({ ...agent, ...body, version: 4 });
    }),
    http.get("*/v1/*", () => HttpResponse.json({ data: [] })),
  );
});

function renderEdit(
  props: { onSaved?: () => void; onOpenSetup?: () => void; onClose?: () => void; editAgent?: AgentRecord } = {},
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentFormDialog
          open
          onClose={props.onClose ?? (() => {})}
          editAgent={props.editAgent ?? agent}
          onSaved={props.onSaved}
          onOpenSetup={props.onOpenSetup}
          allAgents={[]}
          customSkills={[]}
          modelCards={[modelCard]}
          runtimes={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Let the environment read land, so it cannot overwrite the prefill. */
const settle = () => new Promise((r) => setTimeout(r, 30));

async function saveAndRead(onSaved: ReturnType<typeof vi.fn>): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(saved).toHaveLength(1);
  return saved[0];
}

describe("AgentFormDialog edit mode", () => {
  it("starts from the agent's configuration, with no template step", async () => {
    renderEdit();
    expect(screen.getByRole("dialog", { name: "Edit Triage Bot" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back to templates" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Triage Bot");
    expect(screen.getByRole("textbox", { name: "Instructions" })).toHaveValue("You triage issues.");
    expect(screen.getByRole("tab", { name: /Skills\s*1/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /MCP servers\s*1/ })).toBeInTheDocument();
    expect(screen.getByText(/Saving creates version 4/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("saves a new version without dropping what the form cannot edit", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved });
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    const body = await saveAndRead(onSaved);

    expect(body.version).toBe(3);
    expect(body.name).toBe("Triage Bot 2");
    // An unchanged model keeps its {id, speed}.
    expect(body.model).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });
    expect(body.skills).toEqual([{ type: "anthropic", skill_id: "xlsx" }]);
    expect(body.mcp_servers).toEqual(agent.mcp_servers);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual(customTool);
    // A server's own permissions survive instead of being reset.
    expect(tools).toContainEqual(githubToolset);
    expect(tools[0]).toMatchObject({ type: "agent_toolset_20260401", configs: [{ name: "web_search", enabled: false }] });
    // Metadata untouched: not sent (the server merges per key).
    expect(body.metadata).toBeUndefined();
    const oma = body._oma as Record<string, unknown>;
    // Unchanged engine, reasoning, memory and vault servers are not re-sent.
    expect(oma).not.toHaveProperty("harness");
    expect(oma).not.toHaveProperty("reasoning_level");
    expect(oma).not.toHaveProperty("memory");
    expect(oma).not.toHaveProperty("vault_mcp_servers");
  });

  it("keeps _oma.vault_mcp_servers: all through an edit", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved, editAgent: { ...agent, _oma: { ...agent._oma, vault_mcp_servers: "all" } } });
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    const body = await saveAndRead(onSaved);
    // Unchanged: not re-sent, and in particular not cleared back to "declared".
    expect(body._oma as Record<string, unknown>).not.toHaveProperty("vault_mcp_servers");
  });

  it("carries _oma.mcp_tool_loading through the JSON view and sends it only when it changed", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved, editAgent: { ...agent, _oma: { ...agent._oma, mcp_tool_loading: "deferred" } } });
    await settle();
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    const editor = (await screen.findByRole("textbox", { name: "Agent config as JSON" })) as HTMLTextAreaElement;
    const config = JSON.parse(editor.value) as { _oma?: Record<string, unknown> };
    expect(config._oma?.mcp_tool_loading).toBe("deferred");

    fireEvent.change(editor, { target: { value: JSON.stringify({ ...config, _oma: { ...config._oma, mcp_tool_loading: "eager" } }) } });
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    const body = await saveAndRead(onSaved);
    expect((body._oma as Record<string, unknown>).mcp_tool_loading).toBe("eager");
  });

  it("does not re-send an unchanged mcp_tool_loading", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved, editAgent: { ...agent, _oma: { ...agent._oma, mcp_tool_loading: "deferred" } } });
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    const body = await saveAndRead(onSaved);
    expect(body._oma as Record<string, unknown>).not.toHaveProperty("mcp_tool_loading");
  });

  it("keeps an agent's Extra High and its legacy Instant until someone changes them", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved, editAgent: { ...agent, _oma: { ...agent._oma, reasoning_level: "instant" } } });
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: /Model and engine/ }));
    // The legacy value is shown as itself, not mistaken for the default.
    expect(await screen.findByRole("combobox", { name: "Reasoning" })).toHaveTextContent("Instant");
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    const editor = (await screen.findByRole("textbox", { name: "Agent config as JSON" })) as HTMLTextAreaElement;
    expect((JSON.parse(editor.value) as { _oma: Record<string, unknown> })._oma.reasoning_level).toBe("instant");
  });

  it("an Off chosen for memory keeps the agent's store", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved, editAgent: { ...agent, _oma: { ...agent._oma, memory: { mode: "shared", store_id: "memstore_1" } } } });
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: /Model and engine/ }));
    const memory = await screen.findByRole("radiogroup", { name: "Memory" });
    fireEvent.click(within(memory).getByRole("radio", { name: "Off" }));
    const body = await saveAndRead(onSaved);
    expect((body._oma as Record<string, unknown>).memory).toEqual({ mode: "off", store_id: "memstore_1" });
  });

  it("hands off to the setup chat", () => {
    const onOpenSetup = vi.fn();
    renderEdit({ onOpenSetup });
    fireEvent.click(screen.getByRole("button", { name: "Setup chat" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });

  it("closes on Escape when nothing changed, and asks once something did", async () => {
    const onClose = vi.fn();
    renderEdit({ onClose });
    await settle();

    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.getByRole("alert")).toHaveTextContent("Discard your changes to this agent?");
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Triage Bot 2");

    // Cancel asks the same way, and Discard changes leaves.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes without asking once the change is undone", async () => {
    const onClose = vi.fn();
    renderEdit({ onClose });
    await settle();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot 2" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Triage Bot" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
