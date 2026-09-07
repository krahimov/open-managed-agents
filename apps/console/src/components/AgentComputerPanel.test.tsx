import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AgentComputerPanel } from "./AgentComputerPanel";
import { ACTIVE_TENANT_KEY } from "../lib/api";

vi.mock("../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => "console-session-token"),
}));

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

const fetchMock = vi.fn<typeof fetch>();
const createObjectURL = vi.fn(() => "blob:computer-preview");
const revokeObjectURL = vi.fn();

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AgentComputerPanel agentId="agent_test" />
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
  it("explains unsupported instances without offering controls or fetching a screenshot", async () => {
    fetchMock.mockResolvedValue(Response.json({ machine: null, supported: false }));

    renderPanel();

    expect(await screen.findByText(/Cloud computers are not enabled/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start computer" })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
