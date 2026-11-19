import { describe, expect, it } from "vitest";

import { presentTool } from "@/components/sessions/tools";

import { actionWords, parseToolSlug, readComposioCall } from "./composio-calls";

describe("Composio tool slugs", () => {
  it("names the app and the action in words", () => {
    expect(parseToolSlug("HUBSPOT_SEARCH_DEALS")).toMatchObject({ toolkit: "hubspot", action: "Search deals" });
    expect(parseToolSlug("SLACK_SEND_MESSAGE", '{"channel":"C1"}')).toMatchObject({
      toolkit: "slack",
      action: "Send message",
      arguments: { channel: "C1" },
    });
  });

  it("drops the app's name when the action repeats it, and keeps acronyms", () => {
    expect(actionWords("LIST_LINEAR_ISSUES", "linear")).toBe("List issues");
    expect(actionWords("SEARCH_CRM_OBJECTS_BY_CRITERIA", "hubspot")).toBe("Search CRM objects by criteria");
    expect(actionWords("GET_PR_URLS", "github")).toBe("Get PR URLs");
  });

  it("rejects what isn't a slug", () => {
    expect(parseToolSlug("hubspot")).toBeNull();
    expect(parseToolSlug("_SEND")).toBeNull();
    expect(parseToolSlug(42)).toBeNull();
  });
});

describe("reading a Composio router call", () => {
  it("unwraps multi-execute, with or without the mcp__ prefix", () => {
    const input = { tools: [{ tool_slug: "HUBSPOT_SEARCH_DEALS", arguments: { query: "renewal" } }], sync_response_to_workbench: false };
    for (const name of ["COMPOSIO_MULTI_EXECUTE_TOOL", "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL"]) {
      expect(readComposioCall(name, input)).toEqual({
        kind: "execute",
        actions: [{ slug: "HUBSPOT_SEARCH_DEALS", toolkit: "hubspot", action: "Search deals", arguments: { query: "renewal" } }],
      });
    }
  });

  it("reads tools sent as a JSON string", () => {
    const call = readComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: JSON.stringify([{ tool_slug: "LINEAR_GET_ISSUE", arguments: {} }]) });
    expect(call).toMatchObject({ kind: "execute", actions: [{ toolkit: "linear", action: "Get issue" }] });
  });

  it("leaves an execute call that names no action alone", () => {
    expect(readComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] })).toBeNull();
    expect(readComposioCall("COMPOSIO_MULTI_EXECUTE_TOOL", {})).toBeNull();
  });

  it("reads searches, connection checks, schemas and the workbench", () => {
    expect(readComposioCall("COMPOSIO_SEARCH_TOOLS", { queries: [{ use_case: "find deals closing soon" }] })).toEqual({
      kind: "search",
      queries: ["find deals closing soon"],
      toolkits: [],
    });
    expect(readComposioCall("COMPOSIO_MANAGE_CONNECTIONS", { toolkits: ["hubspot", "slack"] })).toEqual({
      kind: "connections",
      toolkits: ["hubspot", "slack"],
    });
    expect(readComposioCall("COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: ["SLACK_SEND_MESSAGE"] })).toMatchObject({
      kind: "schemas",
      actions: [{ toolkit: "slack" }],
    });
    expect(readComposioCall("COMPOSIO_REMOTE_WORKBENCH", { code_to_execute: "print(1)" })).toEqual({ kind: "workbench" });
  });

  it("ignores every other tool", () => {
    expect(readComposioCall("mcp__linear__create_issue", {})).toBeNull();
    expect(readComposioCall("bash", { command: "ls" })).toBeNull();
    expect(readComposioCall(undefined, {})).toBeNull();
  });
});

describe("a Composio call's row", () => {
  it("is the app call it ran", () => {
    const p = presentTool({
      name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL",
      server: "composio",
      flavor: "mcp",
      input: { tools: [{ tool_slug: "SLACK_SEND_MESSAGE", arguments: { channel: "C1", markdown_text: "Redrock renews Dec 7" } }] },
    });
    expect(p).toMatchObject({ source: "Slack", title: "Send message", preview: "Redrock renews Dec 7", kind: "mcp", plain: true });
  });

  it("names every app a batch touched", () => {
    const p = presentTool({
      name: "COMPOSIO_MULTI_EXECUTE_TOOL",
      server: "composio",
      flavor: "mcp",
      input: {
        tools: [
          { tool_slug: "HUBSPOT_SEARCH_DEALS", arguments: {} },
          { tool_slug: "LINEAR_LIST_LINEAR_ISSUES", arguments: {} },
        ],
      },
    });
    expect(p).toMatchObject({ source: "HubSpot + Linear", title: "Search deals, List issues" });
  });

  it("says what a search looked for", () => {
    const p = presentTool({ name: "COMPOSIO_SEARCH_TOOLS", server: "composio", flavor: "mcp", input: { queries: [{ use_case: "post to slack" }] } });
    expect(p).toMatchObject({ title: "Searched app tools", preview: "“post to slack”" });
  });

  it("never shows the mcp__ prefix for a plain MCP call either", () => {
    const p = presentTool({ name: "mcp__linear__get_issue", server: "linear", flavor: "mcp", input: { id: "LHL-1" } });
    expect(p).toMatchObject({ source: "Linear", title: "get_issue" });
  });
});
