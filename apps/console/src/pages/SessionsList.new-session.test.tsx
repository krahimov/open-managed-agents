// The Start-session modal's Environment picker: agent-computer environments
// are labelled the same way as in the New agent form, and the picked
// agent's own default environment is preselected whichever of the agent
// details / environment list / deep link happens first.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SessionsList } from "./SessionsList";

const api = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  useApi: () => ({ api, streamEvents: vi.fn() }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

beforeAll(() => {
  // cmdk (Combobox list) needs these in jsdom.
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});

// Prod's list order: the agent-computer environment comes first.
const envs = [
  { id: "env_computer", name: "Agent computer", config: { type: "cloud", sandbox: { provider: "daytona", scope: "agent" } } },
  { id: "env_ordinary", name: "Default sandbox", config: { type: "cloud", sandbox: { provider: "daytona" } } },
  { id: "env_other", name: "Data sandbox", config: { type: "cloud", sandbox: { provider: "daytona" } } },
];
const agents = [
  { id: "agent_computer", name: "Computer agent", _oma: { default_environment_id: "env_computer" } },
  { id: "agent_plain", name: "Plain agent", _oma: {} },
  { id: "agent_other", name: "Data agent", _oma: { default_environment_id: "env_other" } },
];

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** Hold back a response until the test releases it. */
let gates: { lists?: Promise<void>; detail: Record<string, Promise<void>> };

beforeEach(() => {
  gates = { detail: {} };
  api.mockReset();
  api.mockImplementation(async (path: string) => {
    const { pathname } = new URL(path, "http://localhost");
    if (pathname === "/v1/sessions") return { data: [], has_more: false };
    if (pathname === "/v1/agents") {
      await gates.lists;
      return { data: agents, has_more: false };
    }
    if (pathname.startsWith("/v1/agents/")) {
      const id = pathname.split("/")[3];
      await gates.detail[id];
      return { ...agents.find((a) => a.id === id), mcp_servers: [] };
    }
    if (pathname === "/v1/environments") {
      await gates.lists;
      return { data: envs, has_more: false };
    }
    if (pathname.startsWith("/v1/environments/")) return envs.find((e) => e.id === pathname.split("/")[3]);
    if (["/v1/vaults", "/v1/files", "/v1/memory_stores"].includes(pathname)) return { data: [] };
    throw new Error(`unexpected ${path}`);
  });
});

const mount = (entry = "/sessions") =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/sessions" element={<SessionsList />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

/** [agent picker, environment picker] inside the open modal. */
async function pickers() {
  const dialog = await screen.findByRole("dialog");
  const [agent, environment] = within(dialog).getAllByRole("combobox");
  return { agent, environment };
}

async function expectEnvironment(text: string) {
  await waitFor(async () => expect((await pickers()).environment).toHaveTextContent(text));
}

async function choose(trigger: HTMLElement, optionText: RegExp) {
  fireEvent.click(trigger);
  fireEvent.click(await screen.findByRole("option", { name: optionText }));
}

const COMPUTER_LABEL = "Agent computer (env_computer) · persistent agent computer";

describe("Start session modal — environment picker", () => {
  it("labels agent-computer environments in the list and in the picker once chosen", async () => {
    mount("/sessions?new=1&agent_id=agent_computer");
    // Trigger label comes from GET /v1/environments/:id (value not on a loaded page).
    await expectEnvironment(COMPUTER_LABEL);

    fireEvent.click((await pickers()).environment);
    const computer = await screen.findByRole("option", { name: /Agent computer/ });
    expect(computer).toHaveTextContent(COMPUTER_LABEL);
    const ordinary = screen.getByRole("option", { name: /Default sandbox/ });
    expect(ordinary).toHaveTextContent("Default sandbox (env_ordinary)");
    expect(ordinary).not.toHaveTextContent("persistent agent computer");
  });

  it("deep link: keeps the agent's default when its details load before the lists", async () => {
    const lists = deferred();
    gates.lists = lists.promise;
    mount("/sessions?new=1&agent_id=agent_computer");
    await expectEnvironment(COMPUTER_LABEL);
    lists.resolve();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/environments?limit=200"));
    await new Promise((r) => setTimeout(r, 0));
    await expectEnvironment(COMPUTER_LABEL);
  });

  it("deep link: applies the agent's default when its details load after the lists", async () => {
    const detail = deferred();
    gates.detail.agent_other = detail.promise;
    mount("/sessions?new=1&agent_id=agent_other");
    // Lists are in, the agent isn't: no fallback flashes in meanwhile.
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/memory_stores"));
    await new Promise((r) => setTimeout(r, 0));
    expect((await pickers()).environment).toHaveTextContent("Select environment...");
    detail.resolve();
    await expectEnvironment("Data sandbox (env_other)");
  });

  it("an agent without a default gets the first ordinary environment, never the agent computer", async () => {
    mount("/sessions?new=1&agent_id=agent_plain");
    await expectEnvironment("Default sandbox (env_ordinary)");
  });

  it("+ New session preselects the first agent with its own default", async () => {
    mount();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/environments?limit=200"));
    fireEvent.click(await screen.findByRole("button", { name: "+ New session" }));
    const { agent } = await pickers();
    await waitFor(() => expect(agent).toHaveTextContent("Computer agent (agent_computer)"));
    await expectEnvironment(COMPUTER_LABEL);
  });

  it("switching to an agent without a default drops the previous agent's default", async () => {
    mount("/sessions?new=1&agent_id=agent_computer");
    await expectEnvironment(COMPUTER_LABEL);
    await choose((await pickers()).agent, /Plain agent/);
    await expectEnvironment("Default sandbox (env_ordinary)");
    // …and switching to one with a default applies it.
    await choose((await pickers()).agent, /Data agent/);
    await expectEnvironment("Data sandbox (env_other)");
  });

  it("keeps the user's own pick over a late agent default, a re-pick, and a switch to an agent without one", async () => {
    const detail = deferred();
    gates.detail.agent_other = detail.promise;
    mount("/sessions?new=1&agent_id=agent_other");
    await choose((await pickers()).environment, /Default sandbox/);
    await expectEnvironment("Default sandbox (env_ordinary)");

    detail.resolve();
    await waitFor(() => expect(api).toHaveBeenCalledWith("/v1/agents/agent_other"));
    await new Promise((r) => setTimeout(r, 0));
    await expectEnvironment("Default sandbox (env_ordinary)");

    await choose((await pickers()).agent, /Data agent/);
    await expectEnvironment("Default sandbox (env_ordinary)");

    await choose((await pickers()).agent, /Plain agent/);
    await expectEnvironment("Default sandbox (env_ordinary)");
  });
});
