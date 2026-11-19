// The Triggers tab: "Run now" / "Send test event" fire a rule once and lead
// to the new session, a rule whose source this server never fires says so
// instead of waiting forever, and adding a trigger refetches the agent (the
// server may have switched its memory on, which saves a new version).
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../../mocks/server";
import type { AmbientRule } from "../../../components/agents/triggers";
import { AddTriggerDialog, TriggersTab } from "./TriggersTab";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("../../../lib/clerk-auth", () => ({ getClerkBearerToken: vi.fn(async () => null) }));

beforeAll(() => {
  Element.prototype.scrollIntoView ??= function () {};
});

const rule = (over: Partial<AmbientRule>): AmbientRule => ({
  type: "ambient_rule",
  id: "amb_1",
  agent_id: "agent_1",
  name: "Morning sweep",
  enabled: true,
  trigger: { source: "schedule", config: { cron: "0 9 * * *", timezone: "UTC" } },
  wake_mode: "act",
  created_at: "2026-11-18T08:00:00.000Z",
  next_wake_at: "2026-11-19T09:00:00.000Z",
  ...over,
});

let runs: Array<{ ruleId: string; body: unknown }> = [];

function features(list: string[], sources?: string[]) {
  server.use(
    http.get("*/v1/server_features", () =>
      HttpResponse.json({ features: list, ...(sources ? { ambient_trigger_sources: sources } : {}) }),
    ),
  );
}

beforeEach(() => {
  runs = [];
  toast.success.mockReset();
  server.use(
    http.post("*/v1/agents/agent_1/ambient-rules/:ruleId/run", async ({ params, request }) => {
      runs.push({ ruleId: String(params.ruleId), body: await request.json() });
      return HttpResponse.json({ event_id: "run-1", session_id: "sess_run", duplicate: false }, { status: 202 });
    }),
    http.get("*/v1/agents/agent_1/ambient-rules", () => HttpResponse.json({ data: [] })),
  );
});

function show(rules: AmbientRule[], client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TriggersTab
          agentId="agent_1"
          agentName="Ops agent"
          rules={rules}
          loading={false}
          error={null}
          retry={() => {}}
          archived={false}
          onAdd={() => {}}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Run now", () => {
  it("fires a schedule trigger once and offers the new session", async () => {
    features(["ambient_run_now"], ["schedule", "webhook"]);
    const user = userEvent.setup();
    show([rule({})]);
    await user.click(await screen.findByRole("button", { name: "Run now" }));
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0]).toEqual({ ruleId: "amb_1", body: {} });
    expect(toast.success).toHaveBeenCalledWith(
      "Run started",
      expect.objectContaining({ action: expect.objectContaining({ label: "Open session" }) }),
    );
  });

  it("is not offered where the server cannot run triggers on demand", async () => {
    features([]);
    show([rule({})]);
    await screen.findByText("Morning sweep");
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  });

  it("is not offered for a paused trigger", async () => {
    features(["ambient_run_now"]);
    show([rule({ enabled: false })]);
    await screen.findByText("Paused");
    expect(screen.queryByRole("button", { name: "Run now" })).not.toBeInTheDocument();
  });

  it("sends a webhook trigger a test event with the JSON given", async () => {
    features(["ambient_run_now"], ["schedule", "webhook"]);
    const user = userEvent.setup();
    show([rule({ name: "Deploys", trigger: { source: "webhook", config: { method: "POST" } }, next_wake_at: undefined })]);
    await user.click(await screen.findByRole("button", { name: "Send test event" }));
    const dialog = await screen.findByRole("dialog");
    const field = within(dialog).getByLabelText("Event data");
    expect((field as HTMLTextAreaElement).value).toContain("Test event from the console");

    await user.clear(field);
    await user.type(field, "not json");
    await user.click(within(dialog).getByRole("button", { name: "Send test event" }));
    expect(await within(dialog).findByText("Event data is not valid JSON")).toBeInTheDocument();
    expect(runs).toHaveLength(0);

    await user.clear(field);
    await user.type(field, '{{"window_id":"w05"}');
    await user.click(within(dialog).getByRole("button", { name: "Send test event" }));
    await waitFor(() => expect(runs).toHaveLength(1));
    expect(runs[0].body).toEqual({ data: { window_id: "w05" } });
    expect(toast.success).toHaveBeenCalledWith("Test event sent", expect.anything());
  });
});

describe("a trigger this deployment never fires", () => {
  it("says so instead of waiting for the next event", async () => {
    features(["ambient_run_now"], ["schedule", "webhook"]);
    show([rule({ name: "PR reviews", trigger: { source: "github", config: { event: "pull_request" } }, next_wake_at: undefined })]);
    expect(await screen.findByText("Not available on this deployment")).toBeInTheDocument();
    expect(screen.queryByText("Waiting for the next event")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Run now|Send test event/ })).not.toBeInTheDocument();
  });

  it("keeps the old reading where the server does not list its sources", async () => {
    features([]);
    show([rule({ name: "PR reviews", trigger: { source: "github", config: { event: "pull_request" } }, next_wake_at: undefined })]);
    expect(await screen.findByText("Waiting for the next event")).toBeInTheDocument();
    expect(screen.queryByText("Not available on this deployment")).not.toBeInTheDocument();
  });
});

describe("Add trigger", () => {
  function showDialog(client: QueryClient) {
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <AddTriggerDialog agentId="agent_1" agentName="Ops agent" open onClose={() => {}} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it("offers only the sources this server fires", async () => {
    features([], ["schedule", "webhook"]);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    showDialog(client);
    const group = await screen.findByRole("radiogroup", { name: "Trigger source" });
    await waitFor(() => expect(within(group).queryByRole("radio", { name: /Slack/ })).not.toBeInTheDocument());
    expect(within(group).getAllByRole("radio").map((r) => r.textContent?.trim())).toEqual(["Schedule", "Webhook"]);
  });

  it("refetches the agent after creating one, so an edit opened next is not a stale version", async () => {
    features([]);
    server.use(
      http.post("*/v1/agents/agent_1/ambient-rules", () => HttpResponse.json(rule({}), { status: 201 })),
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    client.setQueryData(["/v1/agents/agent_1"], { id: "agent_1", version: 3 });
    const user = userEvent.setup();
    showDialog(client);
    await user.type(await screen.findByLabelText("Name"), "Morning sweep");
    await user.click(screen.getByRole("button", { name: "Create trigger" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith("Trigger added"));
    expect(client.getQueryState(["/v1/agents/agent_1"])?.isInvalidated).toBe(true);
  });
});
