import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

import type { Event } from "@/lib/events";

import { COMPUTER_CHOICE_KEY, COMPUTER_PANE_DEFAULT, COMPUTER_WIDTH_KEY, isComputerTool, turnUsesComputer, useComputerView } from "./computer";

const ev = (e: Record<string, unknown>) => e as Event;

describe("the computer's tools", () => {
  it("are the browser_* and computer_* tools, however the harness names them", () => {
    for (const name of ["browser_navigate", "browser_screenshot", "computer_click", "mcp__oma_platform__computer_screenshot", "Browser_Click"]) {
      expect(isComputerTool(name)).toBe(true);
    }
    for (const name of ["bash", "browser", "web_fetch", "mcp__linear__create_issue", "my_browser_tool", "mcp__playwright__browser_navigate", undefined]) {
      expect(isComputerTool(name)).toBe(false);
    }
    // Another server's browser is not the agent's computer.
    expect(isComputerTool("browser_click", "playwright")).toBe(false);
    expect(isComputerTool("browser_click", "oma_platform")).toBe(true);
  });

  it("count for the turn in progress only", () => {
    const earlier = [
      ev({ type: "user.message", id: "u1" }),
      ev({ type: "agent.tool_use", id: "c1", name: "browser_navigate", input: { url: "https://example.com" } }),
    ];
    expect(turnUsesComputer(earlier)).toBe(true);
    expect(turnUsesComputer([...earlier, ev({ type: "user.message", id: "u2" }), ev({ type: "agent.tool_use", id: "c2", name: "bash", input: {} })])).toBe(false);
    expect(turnUsesComputer([ev({ type: "agent.mcp_tool_use", id: "m1", name: "computer_click", mcp_server_name: "oma_platform", input: {} })])).toBe(true);
    expect(turnUsesComputer([ev({ type: "agent.mcp_tool_use", id: "m2", name: "browser_navigate", mcp_server_name: "playwright", input: {} })])).toBe(false);
    expect(turnUsesComputer([ev({ type: "agent.tool_use", id: "m3", name: "mcp__playwright__browser_click", input: {} })])).toBe(false);
  });
});

describe("when the Computer view is open", () => {
  let values: Map<string, string>;
  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => values.set(k, v),
      removeItem: (k: string) => values.delete(k),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  const view = (props: Partial<Parameters<typeof useComputerView>[0]> = {}) =>
    renderHook((p: Parameters<typeof useComputerView>[0]) => useComputerView(p), {
      initialProps: { sessionId: "s1", available: true, inUse: false, inline: true, ...props },
    });

  it("opens by itself once the agent goes to its computer, and stays open after", () => {
    const { result, rerender } = view();
    expect(result.current.open).toBe(false);
    rerender({ sessionId: "s1", available: true, inUse: true, inline: true });
    expect(result.current.inlineOpen).toBe(true);
    // The turn ends; the view does not snap shut.
    rerender({ sessionId: "s1", available: true, inUse: false, inline: true });
    expect(result.current.inlineOpen).toBe(true);
    // Another session starts closed again.
    rerender({ sessionId: "s2", available: true, inUse: false, inline: true });
    expect(result.current.inlineOpen).toBe(false);
  });

  it("remembers that the person closed it, and does not open by itself after", () => {
    const { result, rerender } = view({ inUse: true });
    expect(result.current.inlineOpen).toBe(true);
    act(() => result.current.toggle());
    expect(result.current.inlineOpen).toBe(false);
    expect(values.get(COMPUTER_CHOICE_KEY)).toBe("closed");

    const again = view({ sessionId: "s9", inUse: true });
    expect(again.result.current.inlineOpen).toBe(false);
    act(() => again.result.current.toggle());
    expect(again.result.current.inlineOpen).toBe(true);
    expect(values.get(COMPUTER_CHOICE_KEY)).toBe("open");
    rerender({ sessionId: "s1", available: false, inUse: false, inline: true });
    expect(result.current.open).toBe(false);
  });

  it("is a sheet on a narrow screen that opens only when asked", () => {
    const { result } = view({ inline: false, inUse: true });
    expect(result.current.open).toBe(false);
    act(() => result.current.toggle());
    expect(result.current.sheetOpen).toBe(true);
    expect(result.current.inlineOpen).toBe(false);
    expect(values.has(COMPUTER_CHOICE_KEY)).toBe(false);
  });

  it("keeps its width, and survives storage that throws", () => {
    values.set(COMPUTER_WIDTH_KEY, "900");
    expect(view().result.current.width).toBe(900);
    values.set(COMPUTER_WIDTH_KEY, "5");
    expect(view().result.current.width).toBe(COMPUTER_PANE_DEFAULT);
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    const { result } = view({ inUse: true });
    expect(result.current.inlineOpen).toBe(true);
    act(() => result.current.setWidth(700));
    expect(result.current.width).toBe(700);
  });
});
