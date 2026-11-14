import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ComponentProps } from "react";
import {
  AgentComputerPanel,
  agentMachineQueryKey,
  deleteAgentConfirmText,
  loadAgentMachine,
} from "./AgentComputerPanel";
import { ACTIVE_TENANT_KEY } from "../lib/api";

vi.mock("../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => "console-session-token"),
}));

const desktop = vi.hoisted(() => ({ connect: vi.fn(), disconnect: vi.fn() }));
vi.mock('@novnc/novnc', () => ({ default: class extends EventTarget {
  constructor(target: HTMLElement, url: string) { super(); desktop.connect(target, url); }
  disconnect() { desktop.disconnect(); }
} }));

const machinePath = "/v1/agents/agent_test/machine";
const runningMachine = {
  id: "machine_test",
  state: "running",
  generation: 1,
  workdir: "/workspace",
  browserEnabled: true,
  lastActiveAt: 1_700_000_000_000,
  errorReason: null,
};

const sessionSandboxEnv = { id: "env_session", config: { sandbox: { provider: "subprocess" } } };
const agentComputerEnv = { id: "env_computer", config: { sandbox: { provider: "daytona", scope: "agent" } } };

const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => "blob:computer-preview");
const revokeObjectURL = vi.fn();

function renderPanel(props: Partial<ComponentProps<typeof AgentComputerPanel>> = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentComputerPanel agentId="agent_test" defaultEnvironment={sessionSandboxEnv} {...props} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  fetchMock.mockReset();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = createObjectURL;
    static revokeObjectURL = revokeObjectURL;
  });
  for (const name of ["localStorage", "sessionStorage"]) {
    const values = new Map<string, string>();
    vi.stubGlobal(name, {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
  }
  localStorage.setItem(ACTIVE_TENANT_KEY, "tenant_test");
});

afterEach(() => {
  localStorage.removeItem(ACTIVE_TENANT_KEY);
  vi.unstubAllGlobals();
});

describe("AgentComputerPanel", () => {
  it("tells an agent on a session sandbox how to get a computer, without offering controls", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    renderPanel();

    expect(await screen.findByText(/runs each session in a fresh sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/edit the agent, open All settings and, under Sandbox/)).toHaveTextContent(
      "choose a default environment marked “persistent agent computer”",
    );
    expect(screen.queryByText(/not enabled/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Linux computer runs in the cloud/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start computer" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives the same advice to an agent without a default environment", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    renderPanel({ defaultEnvironment: null });

    expect(await screen.findByText(/runs each session in a fresh sandbox/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start computer" })).not.toBeInTheDocument();
  });

  it("says an agent-computer environment creates the computer on the next session", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    renderPanel({ defaultEnvironment: agentComputerEnv });

    expect(await screen.findByText("Its computer is created when its next session starts.")).toBeInTheDocument();
    expect(screen.getByText(/Linux computer runs in the cloud/)).toBeInTheDocument();
    expect(screen.queryByText(/fresh sandbox/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start computer" })).not.toBeInTheDocument();
  });

  it("waits for the default environment before choosing what to say", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    renderPanel({ defaultEnvironment: undefined });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("region", { name: "Computer" })).toHaveAttribute("aria-busy", "true"));
    expect(screen.queryByText(/fresh sandbox/)).not.toBeInTheDocument();
    expect(screen.queryByText(/next session starts/)).not.toBeInTheDocument();
  });

  it("offers the agent's settings where it says how to get a computer", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));
    const onEdit = vi.fn();

    renderPanel({ onEdit });

    fireEvent.click(await screen.findByRole("button", { name: "Edit agent" }));
    expect(onEdit).toHaveBeenCalledOnce();
  });

  it("renders nothing on a server without agent computers", async () => {
    // A server whose console fallback answers unknown paths with the app page.
    fetchMock.mockResolvedValue(new Response("<!doctype html><html></html>", { headers: { "content-type": "text/html" } }));

    const view = renderPanel();

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument();
  });

  it("renders nothing for an agent on a local runtime without a computer", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    const view = renderPanel({ localRuntime: true });

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.container).toBeEmptyDOMElement());
  });

  it("keeps the computer view for an agent that has a computer, whatever its environment", async () => {
    // The endpoint reports supported whenever a computer exists.
    fetchMock.mockResolvedValue(Response.json({
      machine: { ...runningMachine, browserEnabled: false },
      supported: true,
    }));

    renderPanel({ defaultEnvironment: sessionSandboxEnv, localRuntime: true });

    expect(await screen.findByText("Running")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop computer" })).toBeInTheDocument();
    expect(screen.getByText(/Linux computer runs in the cloud/)).toBeInTheDocument();
    expect(screen.queryByText(/fresh sandbox/)).not.toBeInTheDocument();
  });

  it("starts a computer and fetches its preview with session and workspace authentication", async () => {
    let machine: typeof runningMachine | null = null;
    fetchMock.mockImplementation(async (input, init) => {
      if (input === `${machinePath}/start` && init?.method === "POST") {
        machine = runningMachine;
        return Response.json({ machine });
      }
      if (input === `${machinePath}/screenshot`) {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "content-type": "image/png" },
        });
      }
      if (input === machinePath) return Response.json({ machine, supported: true });
      throw new Error(`Unexpected request: ${input}`);
    });

    const view = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Start computer" }));

    expect(await screen.findByText("Running")).toBeInTheDocument();
    const image = await screen.findByRole("img", { name: /Current Chromium browser/ });
    expect(image).toHaveAttribute("src", "blob:computer-preview");
    expect(fetchMock).toHaveBeenCalledWith(`${machinePath}/start`, expect.objectContaining({
      method: "POST",
      body: "{}",
    }));
    expect(fetchMock).toHaveBeenCalledWith(`${machinePath}/screenshot`, expect.objectContaining({
      credentials: "include",
      cache: "no-store",
      headers: {
        authorization: "Bearer console-session-token",
        "x-active-tenant": "tenant_test",
      },
      signal: expect.any(AbortSignal),
    }));

    fireEvent.click(await screen.findByRole("button", { name: "Refresh screenshot" }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalledTimes(2));
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it("keeps the computer running and explains a rejected stop while a session is active", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (input === `${machinePath}/stop`) {
        return Response.json({
          type: "error",
          error: { type: "machine_busy", message: "A session is still working. Try again when it finishes." },
        }, { status: 409 });
      }
      return Response.json({ machine: { ...runningMachine, browserEnabled: false }, supported: true });
    });

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Stop computer" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("A session is still working");
    expect(screen.getByText("Running")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Stop computer" })).toBeEnabled());
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("does not show a browser preview or allow another start while setup is in progress", async () => {
    fetchMock.mockResolvedValue(Response.json({
      machine: { ...runningMachine, state: "bootstrapping" },
      supported: true,
    }));

    renderPanel();

    expect(await screen.findByText("Setting up")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start computer" })).toBeDisabled();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

it('opens the native desktop with an authenticated ticket and disconnects the viewer without stopping work', async () => {
  desktop.connect.mockClear(); desktop.disconnect.mockClear();
  fetchMock.mockImplementation(async input => {
    if (input === `${machinePath}/desktop-ticket`) return Response.json({url: '/v1/computer-desktop/ws?ticket=one-use'});
    if (input === `${machinePath}/screenshot`) return new Response(new Uint8Array([137,80,78,71]), {headers: {'content-type':'image/png'}});
    return Response.json({machine: {...runningMachine, desktopEnabled: true}, supported: true});
  });
  const view = renderPanel();
  fireEvent.click(await screen.findByRole('button', {name:'Open desktop'}));
  await waitFor(() => expect(desktop.connect).toHaveBeenCalledOnce());
  expect(desktop.connect.mock.calls[0][1]).toMatch(/^wss?:.*ticket=one-use$/);
  fireEvent.click(screen.getByRole('button', {name:'Close desktop'}));
  expect(desktop.disconnect).toHaveBeenCalledOnce();
  expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/stop'))).toBe(false);
  view.unmount();
});

describe("agent delete confirmation", () => {
  it("says for certain whether the computer and its files go too", () => {
    expect(deleteAgentConfirmText("Ops", { machine: runningMachine, supported: true })).toBe(
      'Delete agent "Ops"? Its computer and all files on its disk will be deleted too. This cannot be undone.',
    );
    expect(deleteAgentConfirmText("Ops", { machine: null, supported: true })).toBe(
      'Delete agent "Ops"? It has no computer, so there is no computer or disk to delete. This cannot be undone.',
    );
    expect(deleteAgentConfirmText("Ops", null)).toMatch(/^Delete agent "Ops"\? If it has a computer/);
  });

  it("asks the server even when the panel has an older answer cached", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
    // The panel saw no computer; a session has since created one.
    client.setQueryData(agentMachineQueryKey("agent_test"), { machine: null, supported: false });
    const api = vi.fn(async () => ({ machine: runningMachine, supported: false }));

    expect(await loadAgentMachine(client, api as never, "agent_test")).toEqual({ machine: runningMachine, supported: false });
    expect(api).toHaveBeenCalledWith(machinePath, expect.objectContaining({ silentErrors: true }));
    expect(client.getQueryData(agentMachineQueryKey("agent_test"))).toEqual({ machine: runningMachine, supported: false });
  });

  it("reuses a status fetch already in flight under the panel's key", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const api = vi.fn(async () => ({ machine: null, supported: false }));
    const panelFetch = client.fetchQuery({ queryKey: agentMachineQueryKey("agent_test"), queryFn: () => api() });

    expect(await loadAgentMachine(client, api as never, "agent_test")).toEqual({ machine: null, supported: false });
    await panelFetch;
    expect(api).toHaveBeenCalledTimes(1);
  });
});
