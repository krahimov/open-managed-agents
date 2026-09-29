import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AgentFormDialog } from "./AgentFormDialog";
import type { AgentRecord } from "../../types/agent";

vi.mock("../../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => null),
}));

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

const fetchMock = vi.fn<typeof fetch>();

function json(body: unknown) {
  return Promise.resolve(Response.json(body));
}

beforeEach(() => {
  fetchMock.mockImplementation((input, init) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/v1/composio/status") return json({ configured: false });
    if (url.pathname === "/v1/vaults") return json({ data: [] });
    if (url.pathname === "/v1/environments") return json({ data: [{ id: "env_1", name: "Default" }, { id: "env_2", name: "Other" }] });
    if (url.pathname === "/v1/sandbox/config") return json({ provider: "subprocess" });
    if (url.pathname === "/v1/agents/agent_1" && init?.method === "POST") {
      return json({ ...agent, ...JSON.parse(String(init.body)), version: 4 });
    }
    return json({ data: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

function renderEdit(props: { onSaved?: () => void; onOpenSetup?: () => void } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentFormDialog
          open
          onClose={() => {}}
          editAgent={agent}
          onSaved={props.onSaved}
          onOpenSetup={props.onOpenSetup}
          allAgents={[]}
          customSkills={[]}
          modelCards={[]}
          runtimes={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function savedBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find(
    ([input, init]) => String(input).endsWith("/v1/agents/agent_1") && init?.method === "POST",
  );
  expect(call).toBeDefined();
  return JSON.parse(String(call![1]!.body));
}

describe("AgentFormDialog edit mode", () => {
  it("prefills the agent's config and skips the template picker", async () => {
    renderEdit();
    expect(screen.getByRole("heading", { name: "Edit Triage Bot" })).toBeInTheDocument();
    expect(screen.queryByText("← Templates")).toBeNull();
    expect(screen.getByDisplayValue("Triage Bot")).toBeInTheDocument();
    expect(screen.getByDisplayValue("You triage issues.")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Skills \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /MCP Servers \(1\)/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("saves a new version without dropping config the form can't edit", async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved });
    // Let the environments fetch settle so it can't overwrite the prefill.
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/v1/environments"))).toBe(true),
    );
    fireEvent.change(screen.getByDisplayValue("Triage Bot"), { target: { value: "Triage Bot 2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());

    const body = savedBody();
    expect(body.version).toBe(3);
    expect(body.name).toBe("Triage Bot 2");
    // Unchanged model keeps its {id, speed} object.
    expect(body.model).toEqual({ id: "claude-sonnet-4-6", speed: "fast" });
    expect(body.skills).toEqual([{ type: "anthropic", skill_id: "xlsx" }]);
    expect(body.mcp_servers).toEqual(agent.mcp_servers);
    const tools = body.tools as Array<Record<string, unknown>>;
    expect(tools).toContainEqual(customTool);
    // Existing per-server MCP policy survives instead of being reset.
    expect(tools).toContainEqual(githubToolset);
    expect(tools[0]).toMatchObject({
      type: "agent_toolset_20260401",
      configs: [{ name: "web_search", enabled: false }],
    });
    // Metadata untouched → not sent (server merges per key).
    expect(body.metadata).toBeUndefined();
    // Harness unchanged → not re-sent.
    expect((body._oma as Record<string, unknown>).harness).toBeUndefined();
  });

  it("hands off to the setup chat", () => {
    const onOpenSetup = vi.fn();
    renderEdit({ onOpenSetup });
    fireEvent.click(screen.getByRole("button", { name: "Setup chat" }));
    expect(onOpenSetup).toHaveBeenCalledOnce();
  });
});
