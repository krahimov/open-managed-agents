import { describe, expect, it } from "vitest";
import type { Event } from "../../lib/events";
import { describeModelFailure, supersededAccessRequestIdsOf } from "./SessionChat";

const req = (request_id: string, extra: Record<string, unknown>) =>
  ({ type: "system.access_request", request_id, ...extra }) as unknown as Event;

describe("supersededAccessRequestIdsOf", () => {
  it("keeps only the newest card per server URL (trailing slash and case ignored)", () => {
    const events = [
      req("a", { service: "linear", mcp_server_url: "https://mcp.linear.app/mcp" }),
      req("b", { service: "slack", mcp_server_url: "https://mcp.slack.com/mcp" }),
      { type: "agent.message", content: [] } as unknown as Event,
      req("c", { service: "linear", mcp_server_url: "https://MCP.linear.app/mcp/" }),
    ];
    expect([...supersededAccessRequestIdsOf(events)]).toEqual(["a"]);
  });

  it("keeps cards for endpoints that differ by query or path case", () => {
    const events = [
      req("a", { mcp_server_url: "https://x.example/mcp?workspace=A" }),
      req("b", { mcp_server_url: "https://x.example/mcp?workspace=B" }),
      req("c", { mcp_server_url: "https://x.example/Tenant/mcp" }),
      req("d", { mcp_server_url: "https://x.example/tenant/mcp" }),
    ];
    expect(supersededAccessRequestIdsOf(events).size).toBe(0);
  });

  it("falls back to the service slug for cards without a URL (Composio)", () => {
    const events = [req("a", { service: "gmail" }), req("b", { service: "Gmail" }), req("c", { service: "drive" })];
    expect([...supersededAccessRequestIdsOf(events)]).toEqual(["a"]);
  });
});

describe("describeModelFailure", () => {
  it("turns the OpenAI no-credits retry error into an actionable message", () => {
    const f = describeModelFailure(
      "Failed after 3 attempts. Last error: You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    );
    expect(f.title).toBe("The model provider account is out of credits");
    expect(f.hint).toMatch(/Edit settings/);
  });

  it.each([
    ["Your credit balance is too low to access the Anthropic API", "out of credits"],
    ["insufficient_quota", "out of credits"],
    ["Incorrect API key provided: sk-...", "rejected the API key"],
    ["401 Unauthorized", "rejected the API key"],
    ["Rate limit reached for requests", "rate-limiting"],
    ["The model `gpt-9` does not exist", "isn't available"],
  ])("%s", (cause, title) => {
    expect(describeModelFailure(cause).title).toContain(title);
  });

  it("leaves unknown failures generic", () => {
    expect(describeModelFailure("socket hang up")).toEqual({ title: "Turn failed" });
    expect(describeModelFailure(undefined)).toEqual({ title: "Turn failed" });
  });
});
