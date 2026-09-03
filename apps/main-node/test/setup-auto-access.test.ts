import { describe, expect, it } from "vitest";
import {
  autoRequestAccessForNewServers,
  describeAutoAccess,
  newlyAddedMcpServers,
} from "../src/lib/setup-harness";

// update_harness must post connect cards for newly added MCP servers ITSELF.
// Live 2026-09-02: the setup agent added sentry/linear/slack/github in one
// update, requested access only for railway, and told the user it was
// "ready to run" — the prompt instruction was the only guard.

const sentry = { name: "sentry", type: "url", url: "https://mcp.sentry.dev/mcp" };
const slack = { name: "Slack", type: "url", url: "https://mcp.slack.com/mcp/" };
const linear = { name: "linear", type: "url", url: "https://mcp.linear.app/mcp" };
const stdio = { name: "local", type: "stdio", command: "foo" };

describe("newlyAddedMcpServers", () => {
  it("returns only url servers not present before, normalizing URLs and names", () => {
    expect(newlyAddedMcpServers([sentry], [sentry, slack, linear, stdio])).toEqual([
      { name: "slack", url: "https://mcp.slack.com/mcp/" },
      { name: "linear", url: "https://mcp.linear.app/mcp" },
    ]);
  });
  it("treats a trailing-slash variant of an existing server as unchanged", () => {
    expect(
      newlyAddedMcpServers([sentry], [{ ...sentry, url: "https://mcp.sentry.dev/mcp/" }]),
    ).toEqual([]);
  });
  it("handles undefined before/after", () => {
    expect(newlyAddedMcpServers(undefined, undefined)).toEqual([]);
    expect(newlyAddedMcpServers(undefined, [slack])).toEqual([{ name: "slack", url: slack.url }]);
  });
});

describe("autoRequestAccessForNewServers", () => {
  it("posts one connect card per new server, with its URL, and skips existing ones", async () => {
    const calls: Array<{ service: string; mcp_server_url?: string }> = [];
    const r = await autoRequestAccessForNewServers([sentry], [sentry, slack, linear], {
      requestAccess: async (a) => {
        calls.push({ service: a.service, mcp_server_url: a.mcp_server_url });
        return { request_id: `acreq-${a.service}`, status: "pending", note: a.service === "slack" ? "requires a one-time OAuth app registration" : undefined };
      },
    });
    expect(calls).toEqual([
      { service: "slack", mcp_server_url: slack.url },
      { service: "linear", mcp_server_url: linear.url },
    ]);
    expect(r.requested.map((x) => x.name)).toEqual(["slack", "linear"]);
    const line = describeAutoAccess(r);
    expect(line).toContain("Connect cards were posted automatically for: slack, linear");
    expect(line).toContain("Do not tell the user you're ready");
    expect(line).toContain("slack: requires a one-time OAuth app registration");
  });

  it("attaches the vault instead of posting a card when a credential already exists", async () => {
    const requested: string[] = [];
    const attached: string[] = [];
    const r = await autoRequestAccessForNewServers([], [sentry, slack], {
      requestAccess: async (a) => {
        requested.push(a.service);
        return { request_id: "x", status: "pending" };
      },
      findCredentialVault: async (url) => (url.includes("sentry") ? "vlt-connected" : null),
      attachVault: async (id) => {
        attached.push(id);
      },
    });
    expect(requested).toEqual(["slack"]);
    expect(attached).toEqual(["vlt-connected"]);
    expect(r.connected).toEqual(["sentry"]);
    expect(describeAutoAccess(r)).toContain("Already connected via an existing vault credential (vault attached): sentry");
  });

  it("reports servers whose card could not be posted instead of throwing", async () => {
    const r = await autoRequestAccessForNewServers([], [linear], {
      requestAccess: async () => {
        throw new Error("router down");
      },
    });
    expect(r.failed).toEqual(["linear"]);
    expect(describeAutoAccess(r)).toContain("Could not post a connect card for: linear");
  });

  it("does nothing when the server list is unchanged", async () => {
    let n = 0;
    const r = await autoRequestAccessForNewServers([sentry, slack], [slack, sentry], {
      requestAccess: async () => {
        n++;
        return { request_id: "x", status: "pending" };
      },
    });
    expect(n).toBe(0);
    expect(describeAutoAccess(r)).toBe("");
  });
});

import { buildSetupPrompt, describeSetupAccessStatus } from "../src/lib/setup-harness";

describe("setup preamble connection status", () => {
  const agent = { id: "agent-1", name: "Incident commander", mcp_servers: [sentry, slack] } as never;

  it("renders one line per server and the readiness rule when a status is supplied", () => {
    const status = describeSetupAccessStatus({
      connected: ["sentry"],
      requested: [{ name: "slack", note: "requires a one-time OAuth app registration first" }, { name: "linear" }],
      failed: ["github"],
    });
    expect(status.split("\n")).toEqual([
      "- sentry: connected (existing credential verified, vault attached)",
      "- slack: connect card posted — waiting for the user (needs a one-time app setup; the card guides them)",
      "- linear: connect card posted — waiting for the user",
      "- github: could not post a connect card — call request_access for it",
    ]);
    const prompt = buildSetupPrompt(agent, { accessStatus: status });
    expect(prompt).toContain("CONNECTION STATUS of the MCP servers already on your harness");
    expect(prompt).toContain("- slack: connect card posted");
    expect(prompt).toContain("never claim you're ready to run");
  });

  it("omits the block when there is nothing to report", () => {
    expect(buildSetupPrompt(agent)).not.toContain("CONNECTION STATUS");
    expect(describeSetupAccessStatus({ connected: [], requested: [], failed: [] })).toBe("");
  });

  it("reconciling pre-existing servers treats every url server as new", async () => {
    const requested: string[] = [];
    const r = await autoRequestAccessForNewServers(undefined, [sentry, slack, stdio], {
      requestAccess: async (a) => {
        requested.push(a.service);
        return { request_id: "x", status: "pending" };
      },
    });
    expect(requested).toEqual(["sentry", "slack"]);
    expect(r.requested.map((x) => x.name)).toEqual(["sentry", "slack"]);
  });
});


import { buildSetupTools } from "../src/lib/setup-harness";

describe("setup toolset: create_ambient_rule", () => {
  const agent = { id: "agent-1", name: "Incident commander", mcp_servers: [] } as never;
  const base = {
    updateAgent: async () => agent,
    appendEvent: async () => undefined,
    requestAccess: async () => ({ request_id: "x", status: "pending" }),
  };

  it("is offered only when the dep is wired, and reports the created rule", async () => {
    expect(buildSetupTools(agent, "sess-1", base)).not.toHaveProperty("create_ambient_rule");
    const created: unknown[] = [];
    const tools = buildSetupTools(agent, "sess-1", {
      ...base,
      createAmbientRule: async (a) => {
        created.push(a);
        return { id: "amb_1", next_wake_at: "2026-09-02T18:00:00.000Z" };
      },
    });
    expect(tools).toHaveProperty("create_ambient_rule");
    const out = await tools.create_ambient_rule.execute(
      { name: "Incident sweep", cron: "*/15 * * * *", prompt: "Check Sentry and Railway." },
      { toolCallId: "t1", messages: [] },
    );
    expect(created).toHaveLength(1);
    expect(String(out)).toContain('Ambient rule "Incident sweep" created (id amb_1');
    expect(String(out)).toContain("first run 2026-09-02T18:00:00.000Z");
  });

  it("the setup prompt tells the agent to create the rule itself, not point at a UI toggle", () => {
    const p = buildSetupPrompt(agent);
    expect(p).toContain("create_ambient_rule");
    expect(p).toContain("there is no toggle for it in the setup UI");
  });
});
