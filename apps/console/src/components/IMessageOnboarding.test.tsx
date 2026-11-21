import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { IMessageOnboarding } from "./IMessageOnboarding";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<IMessageOnboarding />, { wrapper: Wrapper });
}

describe("IMessageOnboarding", () => {
  it("draws nothing when the deployment has no iMessage configuration", async () => {
    let asked = false;
    server.use(
      http.get("*/v1/imessage/status", () => {
        asked = true;
        return HttpResponse.json({ enabled: false, connected: false });
      }),
    );
    const { container } = mount();
    await waitFor(() => expect(asked).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing once this person's iMessage is linked", async () => {
    server.use(http.get("*/v1/imessage/status", () => HttpResponse.json({ enabled: true, connected: true })));
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing, and raises nothing, on a server without the endpoint", async () => {
    server.use(http.get("*/v1/imessage/status", () => HttpResponse.json({ error: { message: "Not found" } }, { status: 404 })));
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers iMessage, hands over the start link, and goes away once linked", async () => {
    let connected = false;
    let links = 0;
    server.use(
      http.get("*/v1/imessage/status", () => HttpResponse.json({ enabled: true, connected })),
      http.post("*/v1/imessage/connect", () => {
        links += 1;
        return HttpResponse.json({ url: `sms:+15550009999?&body=ORRERY%20token${links}`, number: "+15550009999", code: `ORRERY token${links}`, connected: false });
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue in iMessage" }));
    const open = await screen.findByRole("link", { name: /Open Messages/ });
    expect(open).toHaveAttribute("href", "sms:+15550009999?&body=ORRERY%20token1");
    expect(screen.getByText("+15550009999")).toBeInTheDocument();
    expect(screen.getByText("ORRERY token1")).toBeInTheDocument();

    // A fresh link replaces the old one.
    fireEvent.click(screen.getByRole("button", { name: "Get a new code" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Open Messages/ })).toHaveAttribute("href", "sms:+15550009999?&body=ORRERY%20token2"),
    );

    connected = true;
    fireEvent.click(screen.getByRole("button", { name: "I’ve connected" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "iMessage" })).toBeNull());
  });

  it("says why the link could not be made", async () => {
    server.use(
      http.get("*/v1/imessage/status", () => HttpResponse.json({ enabled: true, connected: false })),
      http.post("*/v1/imessage/connect", () => HttpResponse.json({ error: { message: "The bot is not reachable right now." } }, { status: 503 })),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue in iMessage" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not connect iMessage");
    expect(screen.getByRole("button", { name: "Continue in iMessage" })).toBeEnabled();
  });
});
