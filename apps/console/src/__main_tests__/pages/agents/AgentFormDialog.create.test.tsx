import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ModelCard } from "@open-managed-agents/api-types";
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
/** When set, GET /v1/environments waits for this before answering. */
let environmentsGate: Promise<void> | null = null;

beforeEach(() => {
  environmentsGate = null;
  fetchMock.mockImplementation((input) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/v1/composio/status") return Promise.resolve(Response.json({ configured: false }));
    if (url.pathname === "/v1/environments") {
      const answer = () => Response.json({ data: environments });
      return environmentsGate ? environmentsGate.then(answer) : Promise.resolve(answer());
    }
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

const modelCard: ModelCard = {
  id: "mc_1",
  model_id: "sonnet",
  model: "claude-sonnet-4-6",
  provider: "ant",
  is_default: true,
  created_at: "2026-09-01T00:00:00Z",
};

function renderCreate(onClose = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentFormDialog
          open
          onClose={onClose}
          allAgents={[]}
          customSkills={[]}
          modelCards={[modelCard]}
          runtimes={[]}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return onClose;
}

describe("AgentFormDialog create mode — tabs and dismissing", () => {
  const confirmMock = vi.fn<(message?: string) => boolean>();

  beforeEach(() => {
    environments = [computerEnv, ordinaryEnv];
    confirmMock.mockReset();
    vi.stubGlobal("confirm", confirmMock);
    // Radix Select measures and scrolls its listbox; jsdom has neither.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Element.prototype.scrollIntoView ??= () => {};
    Element.prototype.hasPointerCapture ??= () => false;
    Element.prototype.releasePointerCapture ??= () => {};
  });

  it("opens a blank agent on the Basic tab, where name and model live", async () => {
    renderCreate();
    fireEvent.click(await screen.findByText("Blank agent config"));
    expect(screen.getByRole("tab", { name: "Basic" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: /Integrations/ })).toHaveAttribute("aria-selected", "false");
    expect(screen.getByLabelText("Name *")).toBeInTheDocument();
  });

  it("Escape in the open environment list closes only the list", async () => {
    const onClose = renderCreate();
    fireEvent.click(await screen.findByText("Blank agent config"));
    fireEvent.click(screen.getByRole("tab", { name: "Sandbox" }));
    const trigger = await screen.findByRole("combobox", { name: "Select environment..." });
    fireEvent.keyDown(trigger, { key: "Enter" });
    const listbox = await screen.findByRole("listbox");
    expect(screen.getByRole("option", { name: /Agent computer.*persistent agent computer/ })).toBeInTheDocument();

    fireEvent.keyDown(listbox, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New Agent" })).toBeInTheDocument();
  });

  it("Escape closes an untouched form without asking, even after the defaults fill in", async () => {
    let releaseEnvironments!: () => void;
    environmentsGate = new Promise((resolve) => (releaseEnvironments = resolve));
    const onClose = renderCreate();
    // Pick the template before the environment list arrives, so the default
    // environment (and default model card) prefill the form afterwards.
    fireEvent.click(await screen.findByText("Blank agent config"));
    releaseEnvironments();
    await screen.findByText("sandbox selected");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("Escape on a changed form asks first and keeps the draft when the user says no", async () => {
    const onClose = renderCreate();
    fireEvent.click(await screen.findByText("Blank agent config"));
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Invoice helper" } });

    confirmMock.mockReturnValue(false);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(confirmMock).toHaveBeenCalledWith("Discard this agent? Your changes will be lost.");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name *")).toHaveValue("Invoice helper");

    confirmMock.mockReturnValue(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks before a backdrop click throws away YAML edits", async () => {
    const onClose = renderCreate();
    fireEvent.click(await screen.findByText("Blank agent config"));
    fireEvent.click(screen.getByRole("button", { name: "YAML" }));
    const editor = document.querySelector("textarea.font-mono") as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: `${editor.value}\ndescription: edited\n` } });

    confirmMock.mockReturnValue(false);
    fireEvent.click(screen.getByRole("dialog", { name: "New Agent" }).parentElement!);
    expect(confirmMock).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("ignores Escape while an input method is composing text", async () => {
    const onClose = renderCreate();
    fireEvent.click(await screen.findByText("Blank agent config"));
    fireEvent.keyDown(document, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});
