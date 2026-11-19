import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";

import { ACTIVE_TENANT_KEY } from "../../lib/api";
import { DesktopScreen, type DesktopStatus } from "../DesktopViewer";
import { ComputerPane, LIVE_GRACE_MS } from "./ComputerPane";

vi.mock("../../lib/clerk-auth", () => ({
  getClerkBearerToken: vi.fn(async () => "console-session-token"),
}));

// noVNC stands in as an EventTarget that records what the viewer set on it.
const vnc = vi.hoisted(() => ({ list: [] as Array<EventTarget & Record<string, unknown>> }));
vi.mock("@novnc/novnc", () => ({
  default: class extends EventTarget {
    viewOnly = false;
    focusOnClick = true;
    scaleViewport = false;
    disconnected = false;
    focused = 0;
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      super();
      vnc.list.push(this as unknown as EventTarget & Record<string, unknown>);
    }
    disconnect() {
      this.disconnected = true;
    }
    focus() {
      this.focused++;
    }
  },
}));

const machinePath = "/v1/agents/agent_test/machine";
const machine = {
  id: "machine_test",
  state: "running",
  generation: 1,
  workdir: "/workspace",
  browserEnabled: true,
  desktopEnabled: true,
  lastActiveAt: 1_700_000_000_000,
  errorReason: null,
};

const fetchMock = vi.fn<typeof fetch>();
let tickets = 0;
let shots = 0;
let machineBody: unknown = { machine, supported: true };
let visibility: DocumentVisibilityState = "visible";

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function renderPane(props: Partial<ComponentProps<typeof ComputerPane>> = {}) {
  const all = { agentId: "agent_test", sessionRunning: true, onClose: vi.fn(), ...props };
  const view = render(wrap(<ComputerPane {...all} />));
  return { ...view, rerenderPane: (next: Partial<ComponentProps<typeof ComputerPane>>) => view.rerender(wrap(<ComputerPane {...all} {...next} />)) };
}

const last = () => vnc.list[vnc.list.length - 1];
const fire = (rfb: EventTarget, type: string) =>
  act(() => {
    rfb.dispatchEvent(new Event(type));
  });

beforeEach(() => {
  vnc.list.length = 0;
  tickets = 0;
  shots = 0;
  visibility = "visible";
  machineBody = { machine, supported: true };
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${machinePath}/desktop-ticket`) {
      tickets++;
      return Response.json({ url: `/v1/computer-desktop/ws?ticket=t${tickets}`, expiresInSeconds: 30 });
    }
    if (url === `${machinePath}/screenshot`) {
      shots++;
      return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "content-type": "image/png" } });
    }
    if (url === `${machinePath}/start`) return Response.json({ machine: { ...machine, state: "starting" } });
    return Response.json(machineBody);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:computer-shot");
      static revokeObjectURL = vi.fn();
    },
  );
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
  vi.unstubAllGlobals();
  // Back to jsdom's own (always "visible").
  delete (document as { visibilityState?: unknown }).visibilityState;
});

describe("ComputerPane", () => {
  it("shows the live desktop view-only by default, and hands over input only on Take control", async () => {
    renderPane();

    await waitFor(() => expect(vnc.list).toHaveLength(1));
    const rfb = last();
    expect(rfb.url).toMatch(/^wss?:.*\/v1\/computer-desktop\/ws\?ticket=t1$/);
    expect(rfb.viewOnly).toBe(true);
    expect(rfb.focusOnClick).toBe(false);
    expect(rfb.scaleViewport).toBe(true);
    expect(screen.getByRole("img", { name: "Live view of the agent's desktop" })).toBeInTheDocument();

    const take = screen.getByRole("button", { name: "Take control" });
    // Nothing to control until the desktop is there.
    expect(take).toBeDisabled();
    fire(rfb, "connect");
    expect(screen.getByRole("status")).toHaveTextContent("Live. You are watching");

    fireEvent.click(take);
    expect(rfb.viewOnly).toBe(false);
    expect(rfb.focusOnClick).toBe(true);
    expect(rfb.focused).toBe(1);
    expect(screen.getByRole("button", { name: "Release control" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("application", { name: /Your keys and clicks go to it/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Release control" }));
    expect(rfb.viewOnly).toBe(true);
    // The same connection all along: control is switched in place.
    expect(vnc.list).toHaveLength(1);
    expect(tickets).toBe(1);
  });

  it("is a viewer only while the tab is in front, with a fresh ticket each time, and lets go on unmount", async () => {
    const view = renderPane();
    await waitFor(() => expect(vnc.list).toHaveLength(1));
    const first = last();

    setVisibility("hidden");
    expect(first.disconnected).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Paused while this tab is in the background.");

    setVisibility("visible");
    await waitFor(() => expect(vnc.list).toHaveLength(2));
    expect(tickets).toBe(2);
    expect(last().url).toMatch(/ticket=t2$/);

    view.unmount();
    expect(last().disconnected).toBe(true);
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith("/stop"))).toBe(false);
  });

  it("does not connect to a session at rest until asked, so the computer can idle-stop", async () => {
    renderPane({ sessionRunning: false });
    expect(await screen.findByRole("status")).toHaveTextContent("Paused while the session is at rest");
    await new Promise((r) => setTimeout(r, 50));
    expect(vnc.list).toHaveLength(0);
    expect(tickets).toBe(0);
    expect(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Resume live view" }));
    await waitFor(() => expect(vnc.list).toHaveLength(1));
    fire(last(), "connect");
    expect(screen.getByRole("status")).toHaveTextContent("Live. You are watching");
  });

  it("keeps the live view a while after the session comes to rest, then lets go", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const view = renderPane();
      await waitFor(() => expect(vnc.list).toHaveLength(1));
      fire(last(), "connect");

      view.rerenderPane({ sessionRunning: false });
      expect(last().disconnected).toBe(false);
      act(() => {
        vi.advanceTimersByTime(LIVE_GRACE_MS + 10);
      });
      expect(last().disconnected).toBe(true);
      expect(screen.getByRole("status")).toHaveTextContent("Paused while the session is at rest");
      expect(screen.getByRole("button", { name: "Resume live view" })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives control back when the connection drops", async () => {
    renderPane();
    await waitFor(() => expect(vnc.list).toHaveLength(1));
    fire(last(), "connect");
    fireEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(last().viewOnly).toBe(false);

    fire(last(), "disconnect");
    expect(screen.getByRole("button", { name: "Take control" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("status")).toHaveTextContent("Reconnecting");
  });

  it("falls back to pictures when the live desktop cannot be reached, and can try live again", async () => {
    renderPane();
    await waitFor(() => expect(vnc.list).toHaveLength(1));
    fire(last(), "securityfailure");
    fire(last(), "disconnect");

    expect(await screen.findByRole("img", { name: "The agent's desktop, a moment ago" })).toHaveAttribute("src", "blob:computer-shot");
    expect(screen.getByText(/The live desktop could not be reached: The desktop refused the connection/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Take control" })).not.toBeInTheDocument();
    // Retaken every 2 seconds while the session runs.
    await waitFor(() => expect(shots).toBeGreaterThanOrEqual(2), { timeout: 3_500 });

    fireEvent.click(screen.getByRole("button", { name: "Try live view again" }));
    await waitFor(() => expect(vnc.list).toHaveLength(2));
    expect(tickets).toBe(2);
  });

  it("without a desktop, retakes the picture only while the session runs and the tab is in front", async () => {
    machineBody = { machine: { ...machine, desktopEnabled: false }, supported: true };
    const view = renderPane({ sessionRunning: false });

    expect(await screen.findByRole("img", { name: "The agent's browser, a moment ago" })).toBeInTheDocument();
    expect(vnc.list).toHaveLength(0);
    expect(shots).toBe(1);
    await new Promise((r) => setTimeout(r, 2_300));
    expect(shots).toBe(1);

    view.rerenderPane({ sessionRunning: true });
    await waitFor(() => expect(shots).toBeGreaterThanOrEqual(2), { timeout: 3_000 });

    setVisibility("hidden");
    const seen = shots;
    await new Promise((r) => setTimeout(r, 2_300));
    expect(shots).toBe(seen);
  }, 12_000);

  it("offers to start a stopped computer", async () => {
    machineBody = { machine: { ...machine, state: "stopped" }, supported: true };
    renderPane();

    fireEvent.click(await screen.findByRole("button", { name: "Start computer" }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([url, init]) => url === `${machinePath}/start` && init?.method === "POST")).toBe(true),
    );
    expect(vnc.list).toHaveLength(0);
    expect(shots).toBe(0);
  });

  it("closes from its own button", async () => {
    const onClose = vi.fn();
    renderPane({ onClose });
    fireEvent.click(await screen.findByRole("button", { name: "Hide computer" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("DesktopScreen", () => {
  function renderScreen(onStatus: (s: DesktopStatus) => void) {
    return render(
      wrap(<DesktopScreen agentId="agent_test" active viewOnly retryDelaysMs={[5, 5]} onStatusChange={(s) => onStatus(s)} />),
    );
  }

  it("reconnects with a new ticket after a drop, then gives up instead of retrying forever", async () => {
    const statuses: DesktopStatus[] = [];
    renderScreen((s) => statuses.push(s));
    await waitFor(() => expect(vnc.list).toHaveLength(1));

    fire(last(), "disconnect");
    await waitFor(() => expect(vnc.list).toHaveLength(2));
    expect(tickets).toBe(2);
    fire(last(), "disconnect");
    await waitFor(() => expect(vnc.list).toHaveLength(3));
    fire(last(), "disconnect");

    await waitFor(() => expect(statuses.at(-1)).toBe("failed"));
    await new Promise((r) => setTimeout(r, 30));
    expect(vnc.list).toHaveLength(3);
    expect(tickets).toBe(3);
    expect(statuses).toEqual(["connecting", "reconnecting", "reconnecting", "failed"]);
  });

  it("retries when a ticket cannot be had, and stops when it is no longer shown", async () => {
    fetchMock.mockImplementation(async (input) => {
      if (String(input).endsWith("/desktop-ticket")) {
        tickets++;
        return Response.json({ error: "Desktop is not running" }, { status: 409 });
      }
      return Response.json({ machine, supported: true });
    });
    const statuses: DesktopStatus[] = [];
    const view = renderScreen((s) => statuses.push(s));
    await waitFor(() => expect(statuses.at(-1)).toBe("failed"));
    expect(tickets).toBe(3);
    expect(vnc.list).toHaveLength(0);
    view.unmount();
  });
});
