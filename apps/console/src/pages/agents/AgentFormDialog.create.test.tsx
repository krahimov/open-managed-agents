import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { AgentFormDialog } from "./AgentFormDialog";

vi.mock("../../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => null),
}));

// Prod's list order: the agent-computer environment comes first.
const computerEnv = {
  id: "env_computer",
  name: "Agent computer",
  config: { type: "cloud", sandbox: { provider: "daytona", scope: "agent", browser: true, desktop: true } },
};
const ordinaryEnv = {
  id: "env_ordinary",
  name: "Default Daytona sandbox",
  config: { type: "cloud", sandbox: { provider: "daytona" } },
};

const fetchMock = vi.fn<typeof fetch>();
let environments: unknown[] = [];

beforeEach(() => {
  fetchMock.mockImplementation((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/v1/composio/status") return Promise.resolve(Response.json({ configured: false }));
    if (url.pathname === "/v1/environments") return Promise.resolve(Response.json({ data: environments }));
    if (url.pathname === "/v1/sandbox/config") return Promise.resolve(Response.json({ provider: "daytona" }));
    return Promise.resolve(Response.json({ data: [] }));
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

/** Open the create dialog, pick the blank template and return the config
 *  the form would submit (the JSON editor shows exactly that). */
async function newAgentConfig(): Promise<Record<string, unknown>> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentFormDialog open onClose={() => {}} allAgents={[]} customSkills={[]} modelCards={[]} runtimes={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await waitFor(() =>
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/v1/environments"))).toBe(true),
  );
  fireEvent.click(await screen.findByText("Blank agent config"));
  fireEvent.click(screen.getByRole("button", { name: "JSON" }));
  const editor = await waitFor(() => {
    const el = document.querySelector("textarea.font-mono") as HTMLTextAreaElement | null;
    expect(el?.value).toContain("{");
    return el!;
  });
  return JSON.parse(editor.value) as Record<string, unknown>;
}

describe("AgentFormDialog create mode — default environment", () => {
  it("does not default a new agent to the agent-computer environment listed first", async () => {
    environments = [computerEnv, ordinaryEnv];
    const config = await newAgentConfig();
    expect(config.metadata).toMatchObject({ default_environment_id: "env_ordinary" });
  });

  it("leaves the environment unset when only agent-computer environments exist", async () => {
    environments = [computerEnv];
    const config = await newAgentConfig();
    expect((config.metadata as Record<string, unknown> | undefined)?.default_environment_id).toBeUndefined();
  });
});
