// Agent computers: the browser is on by default, the system prompt steers web
// work into it, and browser_* / computer_* calls are built-in tool uses.

import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_NAMES, COMPUTER_TOOL_NAMES, type BrowserHarness } from "@open-managed-agents/browser-harness";
import {
  browserExplicitlyDisabled,
  buildTools,
  getEnabledTools,
} from "@open-managed-agents/agent/harness/tools";
import { isBuiltinTool, toolCallEvents } from "@open-managed-agents/agent/harness/default-loop";
import {
  agentComputerGuidanceFor,
  composeSystemPrompt,
  platformGuidanceFor,
} from "@open-managed-agents/agent/harness/platform-guidance";
import { agentComputerPromptOptions } from "../src/lib/agent-computer-config";

const toolset = (extra: Record<string, unknown> = {}) => [{ type: "agent_toolset_20260401", ...extra }] as never;
const agent = (tools: unknown) => ({
  id: "agent_computer", name: "Computer", model: "claude-sonnet-4-6", system: "", tools,
  version: 1, created_at: new Date().toISOString(),
}) as never;
const browser: BrowserHarness = {
  launch: async () => { throw new Error("not launched in this test"); },
};
const desktop = { screenshot: async () => "", click: async () => {}, type: async () => {}, press: async () => {}, scroll: async () => {} };
const writes: Array<{ path: string; size: number }> = [];
const sandbox = {
  exec: async () => "",
  readFile: async () => "",
  writeFile: async (p: string) => p,
  writeFileBytes: async (p: string, b: Uint8Array) => { writes.push({ path: p, size: b.byteLength }); return p; },
} as never;

describe("browser on by default on an agent computer", () => {
  it("adds the browser to the default set only on an agent computer", () => {
    expect(getEnabledTools(toolset()).has("browser")).toBe(false);
    expect(getEnabledTools(toolset(), { browserByDefault: true }).has("browser")).toBe(true);
    expect(getEnabledTools(undefined, { browserByDefault: true }).has("browser")).toBe(true);
  });

  it("respects an agent that turned the browser off", () => {
    const off = toolset({ configs: [{ name: "browser", enabled: false }] });
    expect(browserExplicitlyDisabled(off)).toBe(true);
    expect(getEnabledTools(off, { browserByDefault: true }).has("browser")).toBe(false);
    // "Start from nothing" without naming the browser is also off.
    const nothing = toolset({ default_config: { enabled: false } });
    expect(getEnabledTools(nothing, { browserByDefault: true }).has("browser")).toBe(false);
    const onlyBrowser = toolset({ default_config: { enabled: false }, configs: [{ name: "browser", enabled: true }] });
    expect(getEnabledTools(onlyBrowser, { browserByDefault: true }).has("browser")).toBe(true);
    // MCP toolsets never decide it.
    const mcpOff = [{ type: "mcp_toolset", mcp_server_name: "x", default_config: { enabled: false } }, ...toolset()] as never;
    expect(browserExplicitlyDisabled(mcpOff)).toBe(false);
  });

  it("registers browser_* and computer_* tools without the opt-in", async () => {
    const tools = await buildTools(agent(toolset()), sandbox, { browser, browserByDefault: true, computer: desktop });
    for (const name of [...BROWSER_TOOL_NAMES, ...COMPUTER_TOOL_NAMES]) expect(tools).toHaveProperty(name);
  });

  it("registers no browser tools off a computer, or when the agent turned it off", async () => {
    const plain = await buildTools(agent(toolset()), sandbox, { browser });
    expect(plain).not.toHaveProperty("browser_navigate");
    const off = await buildTools(agent(toolset({ configs: [{ name: "browser", enabled: false }] })), sandbox, { browser, browserByDefault: true, computer: desktop });
    expect(off).not.toHaveProperty("browser_navigate");
    expect(off).not.toHaveProperty("computer_screenshot");
  });

  it("points web_fetch at quick static reads when the computer's browser is there", async () => {
    const onComputer = await buildTools(agent(toolset()), sandbox, { browser, browserByDefault: true });
    expect(onComputer.web_fetch.description).toMatch(/only for quick reads of static pages/);
    expect(onComputer.web_fetch.description).toMatch(/browser_\* tools so the work happens in your computer's browser/);
    const elsewhere = await buildTools(agent(toolset({ configs: [{ name: "browser", enabled: true }] })), sandbox, { browser });
    expect(elsewhere.web_fetch.description).toMatch(/default way to read web pages/);
  });

  it("saves browser screenshots through the sandbox's file writes", async () => {
    const page = { goto: async () => null, url: () => "", screenshot: async () => new Uint8Array([1, 2, 3]), locator: () => ({}), evaluate: async () => null, content: async () => "" };
    const live: BrowserHarness = { launch: async () => ({ page: async () => page, close: async () => {}, isOpen: () => true }) };
    const tools = await buildTools(agent(toolset()), sandbox, { browser: live, browserByDefault: true });
    writes.length = 0;
    const out = await tools.browser_screenshot.execute({ save_path: "/mnt/sessions/s1/outputs/page.png" }, { toolCallId: "t", messages: [] });
    expect(writes).toEqual([{ path: "/mnt/sessions/s1/outputs/page.png", size: 3 }]);
    expect(out).toMatchObject({ saved_path: "/mnt/sessions/s1/outputs/page.png" });
  });

  it("refuses save_path unless the write tool could write unasked", async () => {
    const page = { goto: async () => null, url: () => "", screenshot: async () => new Uint8Array([1, 2, 3]), locator: () => ({}), evaluate: async () => null, content: async () => "" };
    const live: BrowserHarness = { launch: async () => ({ page: async () => page, close: async () => {}, isOpen: () => true }) };
    const policyDeniesWrite = {
      ...(agent(toolset()) as object),
      effective_policy: { rules: [{ effect: "deny", selector: "write" }] },
    } as never;
    const cases = [
      agent(toolset({ configs: [{ name: "write", enabled: false }] })),
      agent(toolset({ configs: [{ name: "write", enabled: true, permission_policy: { type: "always_ask" } }] })),
      agent(toolset({ default_config: { enabled: true, permission_policy: { type: "always_ask" } } })),
      policyDeniesWrite,
    ];
    for (const config of cases) {
      const tools = await buildTools(config, sandbox, { browser: live, browserByDefault: true });
      writes.length = 0;
      const out = await tools.browser_screenshot.execute?.({ save_path: "/workspace/app/config.json" }, { toolCallId: "t", messages: [] });
      expect(writes).toEqual([]);
      if (out !== undefined) expect(String(out)).toMatch(/save_path is not available/);
      expect(tools.browser_screenshot.description).not.toMatch(/save_path/);
    }
  });
});

describe("browser and computer calls are built-in tool uses", () => {
  it("classifies every registered browser_* / computer_* name as built-in", () => {
    for (const name of [...BROWSER_TOOL_NAMES, ...COMPUTER_TOOL_NAMES, "general_subagent"]) {
      expect(isBuiltinTool(name)).toBe(true);
    }
    // The config group name is not a tool, and real custom tools stay custom.
    expect(isBuiltinTool("lookup_customer")).toBe(false);
  });

  it("emits agent.tool_use, not a client-owned custom tool use", () => {
    for (const toolName of ["browser_navigate", "computer_click"]) {
      const [ev] = toolCallEvents({ toolCallId: `c_${toolName}`, toolName, input: {} });
      expect(ev).toMatchObject({ type: "agent.tool_use", name: toolName });
    }
    const [custom] = toolCallEvents({ toolCallId: "c_custom", toolName: "lookup_customer", input: {} });
    expect(custom.type).toBe("agent.custom_tool_use");
  });
});

describe("agent computer prompt steering", () => {
  const OUT = "/mnt/sessions/s1/outputs/";

  it("says the computer persists and sends web work to the browser", () => {
    const text = agentComputerGuidanceFor({ browser: true, desktop: true }, OUT);
    expect(text).toMatch(/your own persistent computer: a Linux desktop with a Chromium browser/);
    expect(text).toContain("`/workspace/` is not scratch");
    expect(text).toContain(`\`${OUT}\``);
    expect(text).toMatch(/use the browser_\* tools/);
    expect(text).toMatch(/computer_\* tools for pixel-level control.*native dialogs.*canvas/);
    expect(text).toMatch(/web_fetch only for quick reads of static pages/);
  });

  it("names only what the session can call", () => {
    const headless = agentComputerGuidanceFor({ browser: true, desktop: false }, OUT);
    expect(headless).not.toMatch(/computer_\*/);
    const noBrowser = agentComputerGuidanceFor({ browser: false, desktop: false }, OUT);
    expect(noBrowser).not.toMatch(/browser_\*/);
    expect(noBrowser).toContain("/workspace/");
  });

  it("is appended only for agent-computer sessions, leaving every other prompt byte-identical", () => {
    const withComputer = composeSystemPrompt("Be useful.", [], { outputsPath: OUT, agentComputer: { browser: true, desktop: false } });
    expect(withComputer).toContain(agentComputerGuidanceFor({ browser: true, desktop: false }, OUT));
    expect(composeSystemPrompt("Be useful.", [], { outputsPath: OUT })).toBe(`Be useful.\n\n${platformGuidanceFor({ outputsPath: OUT })}`);
    expect(platformGuidanceFor({ outputsPath: OUT })).not.toContain("persistent computer");
  });

  it("reads the section's options off the session's sandbox and registered tools", () => {
    const computer = { sandboxCapabilities: () => ({ scope: "agent" as const, browser: true }) };
    expect(agentComputerPromptOptions(computer, { browser_navigate: {}, computer_screenshot: {} })).toEqual({ browser: true, desktop: true });
    expect(agentComputerPromptOptions(computer, { bash: {} })).toEqual({ browser: false, desktop: false });
    expect(agentComputerPromptOptions({ sandboxCapabilities: () => ({ scope: "session" as const, browser: false }) }, { browser_navigate: {} })).toBeUndefined();
    expect(agentComputerPromptOptions({}, {})).toBeUndefined();
  });
});
