// The new-session dialog's environment: a persistent agent computer is
// named as one wherever it is picked, an agent's own default applies, and
// an agent without one starts in the first ordinary environment, never in
// an agent computer nobody chose.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { NewSessionDialog } from "./NewSessionDialog";

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

// Prod's list order: the agent-computer environment comes first.
const computer = { id: "env_computer", name: "Agent computer", config: { type: "cloud", sandbox: { provider: "daytona", scope: "agent" } } };
const ordinary = { id: "env_ordinary", name: "Default sandbox", config: { type: "cloud", sandbox: { provider: "daytona" } } };
const other = { id: "env_other", name: "Data sandbox", config: { type: "cloud", sandbox: { provider: "daytona" } } };
const agents = [
  { id: "agent_computer", name: "Computer agent", model: "claude-sonnet-4-6", created_at: "2026-11-01T00:00:00Z", _oma: { default_environment_id: "env_computer" } },
  { id: "agent_plain", name: "Plain agent", model: "claude-sonnet-4-6", created_at: "2026-11-01T00:00:00Z", _oma: {} },
  { id: "agent_other", name: "Data agent", model: "claude-sonnet-4-6", created_at: "2026-11-01T00:00:00Z", _oma: { default_environment_id: "env_other" } },
];

type Env = { id: string; name: string; config: { type: string; sandbox: { provider: string; scope?: string } } };
let envs: Env[] = [];
let created: Array<Record<string, unknown>> = [];

beforeEach(() => {
  envs = [computer, ordinary, other];
  created = [];
  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    /* no storage */
  }
  server.use(
    http.get("*/v1/agents", () => HttpResponse.json({ data: agents, has_more: false })),
    http.get("*/v1/environments", () => HttpResponse.json({ data: envs, has_more: false })),
    http.get("*/v1/environments/:id", ({ params }) => {
      const env = envs.find((e) => e.id === params.id);
      return env ? HttpResponse.json(env) : HttpResponse.json({ error: "not found" }, { status: 404 });
    }),
    http.post("*/v1/sessions", async ({ request }) => {
      created.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({ id: "sess_new" });
    }),
    http.post("*/v1/sessions/sess_new/events", () => HttpResponse.json({ data: [] })),
    http.get("*/v1/*", () => HttpResponse.json({ data: [], has_more: false })),
  );
});

const mount = (agentId: string) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={["/sessions"]}>
        <Routes>
          <Route path="/sessions" element={<NewSessionDialog open initialAgentId={agentId} onClose={() => {}} />} />
          <Route path="/sessions/:id" element={<div>SESSION PAGE</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );

async function environmentField() {
  const dialog = await screen.findByRole("dialog");
  const toggle = await within(dialog).findByRole("button", { name: /^Session options/ });
  if (toggle.getAttribute("aria-expanded") !== "true") fireEvent.click(toggle);
  return within(dialog).findByRole("combobox", { name: /Runs in/ });
}

describe("New session — environment", () => {
  it("names a persistent agent computer as one, on the field and in the list", async () => {
    mount("agent_computer");
    const field = await environmentField();
    await waitFor(() => expect(field).toHaveTextContent("Agent computer · persistent agent computer"));

    fireEvent.click(field);
    const listbox = await screen.findByRole("listbox");
    await waitFor(() => expect(within(listbox).getAllByRole("option")).toHaveLength(3));
    const [computerRow, ordinaryRow] = within(listbox).getAllByRole("option");
    expect(computerRow).toHaveTextContent("A persistent agent computer");
    expect(ordinaryRow).toHaveTextContent("Default sandbox");
    expect(ordinaryRow).not.toHaveTextContent("persistent agent computer");
  });

  it("an agent without a default starts in the first ordinary environment, never the agent computer", async () => {
    mount("agent_plain");
    const field = await environmentField();
    await waitFor(() => expect(field).toHaveTextContent("Default sandbox"));
    expect(field).not.toHaveTextContent("Agent computer");
    expect(screen.queryByText(/has no default environment/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("textbox", { name: "Message to start a new session" }), { target: { value: "Hello" } });
    fireEvent.click(await screen.findByRole("button", { name: /^(Send|Start session)/ }));
    await waitFor(() => expect(created).toHaveLength(1));
    expect(created[0]).toMatchObject({ agent: "agent_plain", environment_id: "env_ordinary" });
  });

  it("asks for a choice when the workspace only has agent computers", async () => {
    envs = [computer];
    mount("agent_plain");
    expect(await screen.findByText("This agent has no default environment. Choose one to send.")).toBeInTheDocument();
  });

  it("switching agents follows each one's own default, and the fallback for one without", async () => {
    mount("agent_computer");
    let field = await environmentField();
    await waitFor(() => expect(field).toHaveTextContent("Agent computer"));

    const pickAgent = async (name: RegExp) => {
      fireEvent.click(screen.getByRole("combobox", { name: /^Agent:/ }));
      fireEvent.click(await screen.findByRole("option", { name }));
    };
    await pickAgent(/Plain agent/);
    field = await environmentField();
    await waitFor(() => expect(field).toHaveTextContent("Default sandbox"));
    expect(field).not.toHaveTextContent("persistent agent computer");

    await pickAgent(/Data agent/);
    field = await environmentField();
    await waitFor(() => expect(field).toHaveTextContent("Data sandbox"));
  });
});
