// Evidence export: capability-statement computation and grant version
// diffing (pure functions behind /v1/agents/:id/evidence/*).

import { describe, it, expect } from "vitest";
import type { AgentConfig, PermissionRule } from "@open-managed-agents/shared";
import {
  buildApprovalHistory,
  computeCapabilityStatement,
  diffPermissionRules,
  formatActivityCsv,
  summarizeActivityEvent,
  type GrantVersionInput,
} from "../../apps/main-node/src/lib/evidence";
import { ALL_TOOLS, getEnabledTools } from "../../apps/agent/src/harness/tools";

const BUILTINS = ["bash", "read", "web_fetch"] as const;

const agentWith = (
  overrides: Partial<Pick<AgentConfig, "tools" | "mcp_servers">> = {},
): Pick<AgentConfig, "tools" | "mcp_servers"> => ({
  tools: [],
  ...overrides,
});

describe("computeCapabilityStatement", () => {
  it("no policy = allow-all with the legacy note and null selectors", () => {
    const { entries, notes } = computeCapabilityStatement({
      builtinTools: BUILTINS,
      agent: agentWith(),
      policy: null,
    });
    expect(entries.map((e) => e.tool)).toEqual(["bash", "read", "web_fetch"]);
    expect(entries.every((e) => e.effect === "allow" && e.selector === null)).toBe(
      true,
    );
    expect(notes.some((n) => n.includes("No enabled baseline grant"))).toBe(true);
  });

  it("evaluates each tool through the pinned rules and reports the winning selector", () => {
    const { entries } = computeCapabilityStatement({
      builtinTools: BUILTINS,
      agent: agentWith(),
      policy: {
        rules: [
          { effect: "deny", selector: "bash" },
          { effect: "ask", selector: "web_*" },
        ],
      },
    });
    const byTool = Object.fromEntries(entries.map((e) => [e.tool, e]));
    expect(byTool.bash).toMatchObject({ effect: "deny", selector: "bash" });
    expect(byTool.web_fetch).toMatchObject({ effect: "ask", selector: "web_*" });
    expect(byTool.read).toMatchObject({ effect: "allow", selector: null });
  });

  it("adds one mcp__<server>__* row per MCP server plus the granularity note", () => {
    const { entries, notes } = computeCapabilityStatement({
      builtinTools: BUILTINS,
      agent: agentWith({
        mcp_servers: [
          { name: "linear", type: "url", url: "https://mcp.linear.app" },
          { name: "github", type: "url", url: "https://mcp.github.com" },
        ],
      }),
      policy: { rules: [{ effect: "deny", selector: "mcp__linear__*" }] },
    });
    const byTool = Object.fromEntries(entries.map((e) => [e.tool, e]));
    expect(byTool["mcp__linear__*"]).toMatchObject({
      effect: "deny",
      selector: "mcp__linear__*",
    });
    expect(byTool["mcp__github__*"]).toMatchObject({ effect: "allow", selector: null });
    expect(notes.some((n) => n.includes("session runtime"))).toBe(true);
  });

  it("includes custom tools and dedupes repeated names", () => {
    const { entries } = computeCapabilityStatement({
      builtinTools: ["bash", "bash"],
      agent: agentWith({
        tools: [
          {
            type: "custom",
            name: "lookup_invoice",
            description: "",
            input_schema: {},
          },
        ],
      }),
      policy: null,
    });
    expect(entries.filter((e) => e.tool === "bash")).toHaveLength(1);
    expect(entries.some((e) => e.tool === "lookup_invoice")).toBe(true);
  });

  it("route composition: getEnabledTools-derived surface honors toolset config", () => {
    // Mirrors the /evidence/capability route: builtinTools comes from
    // getEnabledTools ∩ ALL_TOOLS so a disabled default never shows up as
    // a capability and an opted-in browser does.
    const tools: AgentConfig["tools"] = [
      {
        type: "agent_toolset_20260401",
        configs: [
          { name: "bash", enabled: false },
          { name: "browser", enabled: true },
          { name: "not_a_real_tool", enabled: true },
        ],
      },
    ];
    const builtinTools = [...getEnabledTools(tools)].filter((n) =>
      ALL_TOOLS.includes(n),
    );
    const { entries } = computeCapabilityStatement({
      builtinTools,
      agent: agentWith({ tools }),
      policy: null,
    });
    const names = entries.map((e) => e.tool);
    expect(names).not.toContain("bash");
    expect(names).not.toContain("not_a_real_tool");
    expect(names).toContain("browser");
    expect(names).toContain("read");
  });
});

describe("diffPermissionRules", () => {
  const deny = (selector: string): PermissionRule => ({ effect: "deny", selector });

  it("identity is effect+selector; description changes are not a diff", () => {
    const prev: PermissionRule[] = [
      { effect: "deny", selector: "bash", description: "old wording" },
      { effect: "ask", selector: "write" },
    ];
    const next: PermissionRule[] = [
      { effect: "deny", selector: "bash", description: "new wording" },
      { effect: "deny", selector: "write" },
    ];
    const diff = diffPermissionRules(prev, next);
    expect(diff.added).toEqual([{ effect: "deny", selector: "write" }]);
    expect(diff.removed).toEqual([{ effect: "ask", selector: "write" }]);
  });

  it("first version diffs against the empty rule set", () => {
    const diff = diffPermissionRules(undefined, [deny("bash")]);
    expect(diff.added).toEqual([deny("bash")]);
    expect(diff.removed).toEqual([]);
  });
});

describe("buildApprovalHistory", () => {
  const version = (
    v: number,
    rules: PermissionRule[],
    approvedBy = "user-1",
  ): GrantVersionInput => ({
    id: `pg-${v}`,
    version: v,
    enabled: true,
    rules,
    approved_by: approvedBy,
    created_at: new Date(1783529000000 + v).toISOString(),
  });

  it("returns newest-first with per-version diffs against the predecessor", () => {
    // Deliberately unsorted input — the repo returns newest-first but the
    // function must not depend on it.
    const history = buildApprovalHistory([
      version(2, [
        { effect: "deny", selector: "bash" },
        { effect: "ask", selector: "write" },
      ]),
      version(1, [{ effect: "deny", selector: "bash" }]),
      version(3, [{ effect: "ask", selector: "write" }], "user-2"),
    ]);
    expect(history.map((h) => h.version)).toEqual([3, 2, 1]);
    expect(history[0].approved_by).toBe("user-2");
    expect(history[0].diff).toEqual({
      added: [],
      removed: [{ effect: "deny", selector: "bash" }],
    });
    expect(history[1].diff).toEqual({
      added: [{ effect: "ask", selector: "write" }],
      removed: [],
    });
    expect(history[2].diff).toEqual({
      added: [{ effect: "deny", selector: "bash" }],
      removed: [],
    });
  });
});

describe("activity summaries + CSV", () => {
  it("summarizes each audit frame type", () => {
    expect(
      summarizeActivityEvent("system.policy_pinned", {
        grant_id: "pg-1",
        grant_version: 3,
        rules: [{ effect: "deny", selector: "bash" }],
      }),
    ).toBe("policy pinned: grant pg-1 v3, 1 rule");
    expect(summarizeActivityEvent("system.policy_pinned", {})).toBe(
      "policy pinned: no grant (allow-all), 0 rules",
    );
    expect(
      summarizeActivityEvent("system.policy_decision", {
        tool_name: "bash",
        effect: "deny",
        selector: "bash",
      }),
    ).toBe("policy deny: bash (rule bash)");
    expect(
      summarizeActivityEvent("system.skill_request", {
        skill_name: "xlsx",
        resolution: "catalog",
      }),
    ).toBe("skill requested: xlsx (catalog)");
    expect(summarizeActivityEvent("system.access_request", { service: "gmail" })).toBe(
      "access requested: gmail",
    );
  });

  it("escapes commas and quotes in CSV cells", () => {
    const csv = formatActivityCsv([
      {
        ts: 1783529000000,
        ts_iso: "2026-07-08T12:03:20.000Z",
        session_id: "sess-1",
        event_type: "system.access_request",
        summary: 'access requested: crm, "sales"',
      },
    ]);
    expect(csv).toBe(
      'ts_iso,session_id,event_type,summary\n' +
        '2026-07-08T12:03:20.000Z,sess-1,system.access_request,"access requested: crm, ""sales"""\n',
    );
  });
});
