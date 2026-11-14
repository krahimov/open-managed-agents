import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import type { ModelCard } from "@open-managed-agents/api-types";

import { server } from "../../mocks/server";
import { AgentFormDialog } from "./AgentFormDialog";

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

const modelCard: ModelCard = {
  id: "mc_1",
  model_id: "sonnet",
  model: "claude-sonnet-4-6",
  provider: "ant",
  is_default: true,
  created_at: "2026-09-01T00:00:00Z",
};

let environments: unknown[] = [];
/** When set, GET /v1/environments waits for this before answering. */
let environmentsGate: Promise<void> | null = null;
let created: Array<Record<string, unknown>> = [];

beforeAll(() => {
  // Radix Select measures and scrolls its listbox; jsdom has neither.
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
  environments = [computerEnv, ordinaryEnv];
  environmentsGate = null;
  created = [];
  window.localStorage.clear();
  server.use(
    http.get("*/v1/composio/status", () => HttpResponse.json({ configured: false })),
    http.get("*/v1/environments", async () => {
      if (environmentsGate) await environmentsGate;
      return HttpResponse.json({ data: environments });
    }),
    http.get("*/v1/sandbox/config", () => HttpResponse.json({ provider: "daytona" })),
    http.get("*/v1/model_cards", () => HttpResponse.json({ data: [modelCard] })),
    http.post("*/v1/agents", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      created.push(body);
      return HttpResponse.json({ ...body, id: "agent_new", version: 1, created_at: "2026-11-13T00:00:00Z" });
    }),
    http.post("*/v1/sessions", () => HttpResponse.json({ id: "sess_setup" })),
    http.post("*/v1/sessions/sess_setup/events", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/*", () => HttpResponse.json({ data: [] })),
  );
});

afterEach(() => {
  window.localStorage.clear();
});

function renderCreate({ onClose = vi.fn(), cards = [modelCard] }: { onClose?: () => void; cards?: ModelCard[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const ui = (open: boolean) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentFormDialog open={open} onClose={onClose} allAgents={[]} customSkills={[]} modelCards={cards} runtimes={[]} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(ui(true));
  return { onClose, close: () => view.rerender(ui(false)), open: () => view.rerender(ui(true)) };
}

async function pickBlank() {
  fireEvent.click(await screen.findByRole("button", { name: /Blank agent/ }));
}

/** The config the form would submit, as the JSON editor shows it. */
async function currentConfig(): Promise<Record<string, unknown>> {
  fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
  const editor = (await screen.findByRole("textbox", { name: "Agent config as JSON" })) as HTMLTextAreaElement;
  return JSON.parse(editor.value) as Record<string, unknown>;
}

describe("New agent — default environment", () => {
  it("does not default a new agent to the agent-computer environment listed first", async () => {
    renderCreate();
    await pickBlank();
    await waitFor(async () => expect((await currentConfig()).metadata).toMatchObject({ default_environment_id: "env_ordinary" }));
  });

  it("leaves the environment unset when only agent-computer environments exist", async () => {
    environments = [computerEnv];
    renderCreate();
    await pickBlank();
    await new Promise((r) => setTimeout(r, 20));
    const config = await currentConfig();
    expect((config.metadata as Record<string, unknown> | undefined)?.default_environment_id).toBeUndefined();
  });

  it("names a persistent agent computer as one in the Sandbox list", async () => {
    renderCreate();
    await pickBlank();
    fireEvent.click(screen.getByRole("tab", { name: /Sandbox/ }));
    const trigger = await screen.findByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    expect(await screen.findByRole("option", { name: /^Agent computer/ })).toHaveTextContent("A persistent agent computer");
    expect(screen.getByRole("option", { name: /Default Daytona sandbox/ })).not.toHaveTextContent("persistent agent computer");
  });
});

describe("New agent — reasoning and memory", () => {
  it("stores no reasoning level for the default (Medium) and offers no Instant", async () => {
    renderCreate();
    await pickBlank();
    fireEvent.click(screen.getByRole("tab", { name: /Model and engine/ }));
    const reasoning = await screen.findByRole("combobox", { name: "Reasoning" });
    expect(reasoning).toHaveTextContent("Medium (default)");
    fireEvent.keyDown(reasoning, { key: "Enter" });
    const labels = (await screen.findAllByRole("option")).map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.startsWith("Extra High"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Instant"))).toBe(false);
    fireEvent.keyDown(await screen.findByRole("listbox"), { key: "Escape" });
    const config = await currentConfig();
    expect((config._oma as Record<string, unknown> | undefined)?.reasoning_level).toBeUndefined();
  });

  it("keeps a pasted Extra High through the form and back", async () => {
    renderCreate();
    await pickBlank();
    const config = await currentConfig();
    const editor = screen.getByRole("textbox", { name: "Agent config as JSON" });
    fireEvent.change(editor, { target: { value: JSON.stringify({ ...config, _oma: { reasoning_level: "xhigh" } }) } });
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    expect(((await currentConfig())._oma as Record<string, unknown>).reasoning_level).toBe("xhigh");
  });

  it("an Off someone chose is written, so a trigger does not turn memory on", async () => {
    renderCreate();
    await pickBlank();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Morning digest" } });
    fireEvent.click(screen.getByRole("tab", { name: /Model and engine/ }));
    const memory = await screen.findByRole("radiogroup", { name: "Memory" });
    // Untouched, nothing is stored: the server's own default applies.
    expect(((await currentConfig())._oma as Record<string, unknown> | undefined)?.memory).toBeUndefined();
    fireEvent.click(screen.getByRole("radio", { name: "Form" }));
    fireEvent.click(within(await screen.findByRole("radiogroup", { name: "Memory" })).getByRole("radio", { name: "Shared" }));
    fireEvent.click(within(screen.getByRole("radiogroup", { name: "Memory" })).getByRole("radio", { name: "Off" }));
    expect(memory).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect((created[0]._oma as Record<string, unknown>).memory).toEqual({ mode: "off" });
  });

  it("with a trigger and no choice, says memory comes on with it and leaves the field to the server", async () => {
    renderCreate();
    await pickBlank();
    fireEvent.click(screen.getByRole("tab", { name: /Triggers/ }));
    fireEvent.click(await screen.findByRole("switch"));
    fireEvent.click(screen.getByRole("tab", { name: /Model and engine/ }));
    expect(await screen.findByText(/On because this agent has a trigger/)).toBeInTheDocument();
    expect(within(screen.getByRole("radiogroup", { name: "Memory" })).getByRole("radio", { name: "Shared" })).toBeChecked();
    expect(((await currentConfig())._oma as Record<string, unknown> | undefined)?.memory).toBeUndefined();
  });
});

describe("New agent — sections and leaving", () => {
  it("opens a blank agent on Basics, where the name is", async () => {
    renderCreate();
    await pickBlank();
    expect(screen.getByRole("tab", { name: /Basics/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("textbox", { name: "Name" })).toBeInTheDocument();
  });

  it("Escape in the open environment list closes only the list", async () => {
    const { onClose } = renderCreate();
    await pickBlank();
    fireEvent.click(screen.getByRole("tab", { name: /Sandbox/ }));
    const trigger = await screen.findByRole("combobox");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const listbox = await screen.findByRole("listbox");
    fireEvent.keyDown(listbox, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "New agent" })).toBeInTheDocument();
  });

  it("Escape closes an untouched form, even after the defaults filled in, and keeps no draft", async () => {
    let release!: () => void;
    environmentsGate = new Promise((r) => (release = r));
    const { onClose } = renderCreate();
    // The template is picked before the environments arrive, so the default
    // environment (and model key) fill the form in afterwards.
    await pickBlank();
    await act(async () => release());
    await new Promise((r) => setTimeout(r, 20));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith("oma-agent-draft"))).toEqual([]);
  });

  it("Escape on a changed form keeps it as a draft that comes back on the next open", async () => {
    const view = renderCreate();
    await pickBlank();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Invoice helper" } });

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(view.onClose).toHaveBeenCalledOnce();

    view.close();
    view.open();
    expect(await screen.findByText("Picking up where you left off")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue("Invoice helper");

    // Start over throws it away.
    fireEvent.click(screen.getByRole("button", { name: "Start over" }));
    expect(await screen.findByRole("button", { name: /Blank agent/ })).toBeInTheDocument();
    view.close();
    view.open();
    expect(await screen.findByRole("button", { name: /Blank agent/ })).toBeInTheDocument();
  });

  it("Cancel keeps YAML edits as a draft too", async () => {
    const view = renderCreate();
    await pickBlank();
    fireEvent.click(screen.getByRole("radio", { name: "YAML" }));
    const editor = (await screen.findByRole("textbox", { name: "Agent config as YAML" })) as HTMLTextAreaElement;
    fireEvent.change(editor, { target: { value: editor.value.replace(/^name: .*$/m, "name: From YAML") } });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(view.onClose).toHaveBeenCalledOnce();
    view.close();
    view.open();
    expect(await screen.findByRole("textbox", { name: "Name" })).toHaveValue("From YAML");
  });

  it("a created agent leaves no draft behind", async () => {
    const view = renderCreate();
    await pickBlank();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Invoice helper" } });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    view.close();
    view.open();
    await screen.findByText("Picking up where you left off");
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() => expect(created).toHaveLength(1));
    await waitFor(() => expect(Object.keys(window.localStorage).filter((k) => k.startsWith("oma-agent-draft"))).toEqual([]));
  });

  it("ignores Escape while an input method is composing text", async () => {
    const { onClose } = renderCreate();
    await pickBlank();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape", isComposing: true });
    expect(onClose).not.toHaveBeenCalled();
  });
});
