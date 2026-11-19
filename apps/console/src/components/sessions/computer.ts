import { useCallback, useEffect, useState } from "react";

import type { Event } from "@/lib/events";

import { readToolUse } from "./model";

/**
 * The agent's computer, as the session page sees it.
 *
 * An agent with a persistent computer works on it through two families of
 * tools: `browser_*` (Chromium over CDP) and `computer_*` (the desktop, by
 * pixel). SDK harnesses reach the same tools through the platform's own MCP
 * server, so the name may come as `mcp__oma_platform__browser_click`. Any
 * other server's `browser_*` tools (Playwright MCP, say) drive a browser of
 * their own, not the agent's computer, and do not count.
 */

const COMPUTER_TOOL = /^(browser|computer)_[a-z0-9_]+$/;
/** The MCP servers that carry the computer's own tools. */
const PLATFORM_SERVERS = new Set(["oma_platform", "oma_box"]);

/** Whether a tool name (and the MCP server it came through, if any) is one of the computer's own tools. */
export function isComputerTool(name: string | undefined, server?: string): boolean {
  if (!name) return false;
  const prefixed = /^mcp__(.+?)__(.+)$/.exec(name);
  const via = prefixed?.[1] ?? server;
  if (via && !PLATFORM_SERVERS.has(via.toLowerCase())) return false;
  return COMPUTER_TOOL.test((prefixed?.[2] ?? name).toLowerCase());
}

const TOOL_USE = new Set(["agent.tool_use", "agent.mcp_tool_use", "agent.custom_tool_use"]);

/**
 * Whether the turn in progress has used the computer: a browser or desktop
 * call since the last message a person (or a trigger) sent. Callers decide
 * whether the session is running; this only reads the log.
 */
export function turnUsesComputer(events: readonly Event[]): boolean {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === "user.message") return false;
    if (!TOOL_USE.has(e.type)) continue;
    const call = readToolUse(e);
    if (isComputerTool(call.name, call.server)) return true;
  }
  return false;
}

// ── the Computer view's own state ───────────────────────────────────────

/** Whether the person opened or closed the computer view ("open" | "closed"), across sessions. */
export const COMPUTER_CHOICE_KEY = "muse:session:computer";
/** How wide they made it beside the conversation, in px. */
export const COMPUTER_WIDTH_KEY = "muse:session:computer:width";
export const COMPUTER_PANE_MIN = 320;
export const COMPUTER_PANE_MAX = 1400;
export const COMPUTER_PANE_DEFAULT = 520;

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable: the choice just will not persist
  }
}

type Choice = "open" | "closed";

export interface ComputerView {
  /** Shown beside the conversation. */
  inlineOpen: boolean;
  /** Shown at all: beside the conversation, or in its sheet. */
  open: boolean;
  /** The sheet used on narrow screens. */
  sheetOpen: boolean;
  setSheetOpen: (open: boolean) => void;
  toggle: () => void;
  width: number;
  setWidth: (width: number) => void;
}

/**
 * When the Computer view is open.
 *
 * Beside the conversation it opens by itself the first time, in this
 * session, that the agent goes to its computer while running, unless the
 * person closed it before. Opening or closing it is their choice, kept in
 * localStorage for every session after. On a narrow screen it is a sheet
 * and only opens when asked.
 */
export function useComputerView({
  sessionId,
  available,
  inUse,
  inline,
}: {
  sessionId: string | undefined;
  /** The session's agent has a computer to watch. */
  available: boolean;
  /** The turn in progress is using it. */
  inUse: boolean;
  /** There is room beside the conversation. */
  inline: boolean;
}): ComputerView {
  const [choice, setChoiceState] = useState<Choice | null>(() => {
    const v = readStored(COMPUTER_CHOICE_KEY);
    return v === "open" || v === "closed" ? v : null;
  });
  const setChoice = useCallback((next: Choice) => {
    setChoiceState(next);
    writeStored(COMPUTER_CHOICE_KEY, next);
  }, []);
  const [width, setWidthState] = useState(() => {
    const n = Number(readStored(COMPUTER_WIDTH_KEY));
    return Number.isFinite(n) && n >= COMPUTER_PANE_MIN && n <= COMPUTER_PANE_MAX ? n : COMPUTER_PANE_DEFAULT;
  });
  const setWidth = useCallback((next: number) => {
    setWidthState(next);
    writeStored(COMPUTER_WIDTH_KEY, String(next));
  }, []);
  const [autoOpened, setAutoOpened] = useState<string | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  useEffect(() => {
    if (inUse && available && choice !== "closed" && sessionId) setAutoOpened(sessionId);
  }, [inUse, available, choice, sessionId]);

  const inlineOpen = available && inline && (choice === "open" || (choice !== "closed" && autoOpened === sessionId && !!sessionId));
  const open = inline ? inlineOpen : available && sheetOpen;
  const toggle = () => {
    if (inline) setChoice(inlineOpen ? "closed" : "open");
    else setSheetOpen(!sheetOpen);
  };
  return { inlineOpen, open, sheetOpen: available && sheetOpen, setSheetOpen, toggle, width, setWidth };
}
