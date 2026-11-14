import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { TelegramOnboarding } from "./TelegramOnboarding";

vi.mock("sonner", () => ({ toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }) }));

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const Wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return render(<TelegramOnboarding />, { wrapper: Wrapper });
}

describe("TelegramOnboarding", () => {
  it("draws nothing when the deployment has no Telegram bot", async () => {
    let asked = false;
    server.use(
      http.get("*/v1/telegram/status", () => {
        asked = true;
        return HttpResponse.json({ enabled: false, connected: false });
      }),
    );
    const { container } = mount();
    await waitFor(() => expect(asked).toBe(true));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing once this person's Telegram is linked", async () => {
    server.use(http.get("*/v1/telegram/status", () => HttpResponse.json({ enabled: true, connected: true })));
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("draws nothing, and raises nothing, on a server without the endpoint", async () => {
    server.use(http.get("*/v1/telegram/status", () => HttpResponse.json({ error: { message: "Not found" } }, { status: 404 })));
    const { container } = mount();
    await new Promise((r) => setTimeout(r, 30));
    expect(container).toBeEmptyDOMElement();
  });

  it("offers Telegram, hands over the start link, and goes away once linked", async () => {
    let connected = false;
    let links = 0;
    server.use(
      http.get("*/v1/telegram/status", () => HttpResponse.json({ enabled: true, connected })),
      http.post("*/v1/telegram/connect", () => {
        links += 1;
        return HttpResponse.json({ url: `https://t.me/orrery_bot?start=token${links}`, connected: false });
      }),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue in Telegram" }));
    const open = await screen.findByRole("link", { name: /Open Telegram and press Start/ });
    expect(open).toHaveAttribute("href", "https://t.me/orrery_bot?start=token1");
    expect(open).toHaveAttribute("target", "_blank");

    // A fresh link replaces the old one.
    fireEvent.click(screen.getByRole("button", { name: "Get a new link" }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: /Open Telegram and press Start/ })).toHaveAttribute("href", "https://t.me/orrery_bot?start=token2"),
    );

    connected = true;
    fireEvent.click(screen.getByRole("button", { name: "I’ve connected" }));
    await waitFor(() => expect(screen.queryByRole("complementary", { name: "Telegram" })).toBeNull());
  });

  it("says why the link could not be made", async () => {
    server.use(
      http.get("*/v1/telegram/status", () => HttpResponse.json({ enabled: true, connected: false })),
      http.post("*/v1/telegram/connect", () => HttpResponse.json({ error: { message: "The bot is not reachable right now." } }, { status: 503 })),
    );
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Continue in Telegram" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Telegram could not be connected");
    expect(screen.getByRole("button", { name: "Continue in Telegram" })).toBeEnabled();
  });
});
