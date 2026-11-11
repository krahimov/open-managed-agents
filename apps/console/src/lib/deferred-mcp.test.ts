import { describe, expect, it } from "vitest";
import { parseMcpToolName, parseSearchMcpTools, unwrapCallMcpTool } from "./deferred-mcp";

describe("parseMcpToolName", () => {
  it("splits mcp__<server>__<tool>", () => {
    expect(parseMcpToolName("mcp__linear__create_issue")).toEqual({ server: "linear", tool: "create_issue" });
    expect(parseMcpToolName("mcp__google_drive__search")).toEqual({ server: "google_drive", tool: "search" });
  });

  it("keeps later double underscores in the tool name", () => {
    expect(parseMcpToolName("mcp__github__repos__create_pr")).toEqual({ server: "github", tool: "repos__create_pr" });
    expect(parseMcpToolName("mcp__notion__a__b__c")).toEqual({ server: "notion", tool: "a__b__c" });
  });

  it("rejects malformed names", () => {
    for (const bad of [undefined, null, 42, "", "linear__create_issue", "mcp__", "mcp__linear", "mcp__linear__", "mcp____create_issue", "mcp_linear_create"]) {
      expect(parseMcpToolName(bad)).toBeNull();
    }
  });
});

describe("unwrapCallMcpTool", () => {
  it("returns the target and its object arguments", () => {
    expect(
      unwrapCallMcpTool("call_mcp_tool", { name: "mcp__linear__create_issue", arguments: { title: "Bug", teamId: "T1" } }),
    ).toEqual({
      name: "mcp__linear__create_issue",
      server: "linear",
      tool: "create_issue",
      arguments: { title: "Bug", teamId: "T1" },
    });
  });

  it("decodes JSON-string arguments", () => {
    expect(
      unwrapCallMcpTool("call_mcp_tool", { name: "mcp__slack__post_message", arguments: '{"channel":"#eng","text":"hi"}' })?.arguments,
    ).toEqual({ channel: "#eng", text: "hi" });
  });

  it("treats missing or blank arguments as empty and keeps undecodable ones as sent", () => {
    expect(unwrapCallMcpTool("call_mcp_tool", { name: "mcp__linear__list_teams" })?.arguments).toEqual({});
    expect(unwrapCallMcpTool("call_mcp_tool", { name: "mcp__linear__list_teams", arguments: "  " })?.arguments).toEqual({});
    expect(unwrapCallMcpTool("call_mcp_tool", { name: "mcp__linear__list_teams", arguments: "{oops" })?.arguments).toEqual({ arguments: "{oops" });
    expect(unwrapCallMcpTool("call_mcp_tool", { name: "mcp__linear__list_teams", arguments: "[1]" })?.arguments).toEqual({ arguments: "[1]" });
  });

  it("returns null for other tools and missing or malformed target names", () => {
    expect(unwrapCallMcpTool("bash", { name: "mcp__linear__create_issue" })).toBeNull();
    expect(unwrapCallMcpTool("call_mcp_tool", {})).toBeNull();
    expect(unwrapCallMcpTool("call_mcp_tool", { name: 7 })).toBeNull();
    expect(unwrapCallMcpTool("call_mcp_tool", { name: "create_issue", arguments: {} })).toBeNull();
    expect(unwrapCallMcpTool("call_mcp_tool", undefined)).toBeNull();
  });
});

describe("parseSearchMcpTools", () => {
  it("reads query and optional server", () => {
    expect(parseSearchMcpTools("search_mcp_tools", { query: " create issue ", server: "linear", limit: 3 })).toEqual({ query: "create issue", server: "linear" });
    expect(parseSearchMcpTools("search_mcp_tools", { query: "pages" })).toEqual({ query: "pages" });
  });

  it("returns null without a query or for other tools", () => {
    expect(parseSearchMcpTools("search_mcp_tools", { server: "linear" })).toBeNull();
    expect(parseSearchMcpTools("search_mcp_tools", { query: "  " })).toBeNull();
    expect(parseSearchMcpTools("grep", { query: "x" })).toBeNull();
  });
});
