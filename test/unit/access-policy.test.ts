// Access-control Phase 1: policy evaluator, grant service versioning, and
// buildTools() enforcement (deny = tool absent from the dict; ask = execute
// stripped so the AI SDK surfaces a pending call).

import { describe, it, expect } from "vitest";
import {
  ccToolNameToOma,
  compileSdkDisallowedTools,
  evaluatePolicy,
  matchesSelector,
  selectorSpecificity,
  validatePermissionRules,
} from "@open-managed-agents/shared";
import type { EffectivePolicy, PermissionRule } from "@open-managed-agents/shared";
import type { AgentConfig } from "@open-managed-agents/shared";
import { PermissionGrantService } from "@open-managed-agents/agents-store";
import type {
  NewPermissionGrantInput,
  PermissionGrantRepo,
  PermissionGrantRow,
} from "@open-managed-agents/agents-store";
import { buildTools } from "../../apps/agent/src/harness/tools";
import { TestSandbox } from "../../apps/agent/src/runtime/sandbox";

const policy = (rules: PermissionRule[]): EffectivePolicy => ({ rules });

describe("policy evaluator", () => {
  it("matches exact names and globs", () => {
    expect(matchesSelector("bash", "bash")).toBe(true);
    expect(matchesSelector("bash", "bash2")).toBe(false);
    expect(matchesSelector("mcp__linear__*", "mcp__linear__get_issue")).toBe(true);
    expect(matchesSelector("mcp__linear__*", "mcp__github__get_issue")).toBe(false);
    expect(matchesSelector("*", "anything")).toBe(true);
    expect(matchesSelector("mcp__*__get_*", "mcp__linear__get_issue")).toBe(true);
  });

  it("does not treat selector dots/brackets as regex", () => {
    expect(matchesSelector("a.b", "axb")).toBe(false);
    expect(matchesSelector("a.b", "a.b")).toBe(true);
  });

  it("defaults to allow with no policy or no match", () => {
    expect(evaluatePolicy(null, "bash").effect).toBe("allow");
    expect(evaluatePolicy(policy([]), "bash").effect).toBe("allow");
    expect(
      evaluatePolicy(policy([{ effect: "deny", selector: "web_*" }]), "bash").effect,
    ).toBe("allow");
  });

  it("most-specific selector wins", () => {
    const p = policy([
      { effect: "allow", selector: "mcp__linear__*" },
      { effect: "deny", selector: "mcp__linear__delete_*" },
    ]);
    expect(evaluatePolicy(p, "mcp__linear__get_issue").effect).toBe("allow");
    expect(evaluatePolicy(p, "mcp__linear__delete_issue").effect).toBe("deny");
    expect(selectorSpecificity("mcp__linear__delete_*")).toBeGreaterThan(
      selectorSpecificity("mcp__linear__*"),
    );
  });

  it("deny > ask > allow on specificity ties", () => {
    const p = policy([
      { effect: "allow", selector: "bash" },
      { effect: "deny", selector: "bash" },
      { effect: "ask", selector: "bash" },
    ]);
    expect(evaluatePolicy(p, "bash").effect).toBe("deny");
  });

  it("validatePermissionRules rejects malformed rules", () => {
    expect(() => validatePermissionRules("nope")).toThrow(TypeError);
    expect(() => validatePermissionRules([{ effect: "block", selector: "x" }])).toThrow(
      TypeError,
    );
    expect(() => validatePermissionRules([{ effect: "deny", selector: " " }])).toThrow(
      TypeError,
    );
    const ok = validatePermissionRules([
      { effect: "deny", selector: " bash ", description: "no shell" },
    ]);
    expect(ok).toEqual([{ effect: "deny", selector: "bash", description: "no shell" }]);
  });

  it("compiles exact deny rules to CC disallowedTools; globs need the callback", () => {
    const p = policy([
      { effect: "deny", selector: "bash" },
      { effect: "deny", selector: "mcp__github__create_issue" },
      { effect: "deny", selector: "mcp__linear__*" },
      { effect: "ask", selector: "write" },
    ]);
    expect(compileSdkDisallowedTools(p).sort()).toEqual([
      "Bash",
      "mcp__github__create_issue",
    ]);
    expect(ccToolNameToOma("Bash")).toBe("bash");
    expect(ccToolNameToOma("WebFetch")).toBe("web_fetch");
    expect(ccToolNameToOma("mcp__linear__get_issue")).toBe("mcp__linear__get_issue");
  });
});

class InMemoryGrantRepo implements PermissionGrantRepo {
  rows: PermissionGrantRow[] = [];

  async insert(input: NewPermissionGrantInput): Promise<PermissionGrantRow> {
    const row: PermissionGrantRow = {
      id: input.id,
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      principal_type: input.principalType,
      principal_id: input.principalId,
      rules: input.rules,
      version: input.version,
      enabled: input.enabled,
      approved_by: input.approvedBy,
      created_at: new Date(input.createdAt).toISOString(),
    };
    this.rows.push(row);
    return row;
  }

  async getActive(
    tenantId: string,
    agentId: string,
    principalType: PermissionGrantRow["principal_type"],
    principalId: string | null,
  ): Promise<PermissionGrantRow | null> {
    const versions = await this.listVersions(tenantId, agentId, principalType, principalId);
    return versions[0] ?? null;
  }

  async listVersions(
    tenantId: string,
    agentId: string,
    principalType: PermissionGrantRow["principal_type"],
    principalId: string | null,
  ): Promise<PermissionGrantRow[]> {
    return this.rows
      .filter(
        (r) =>
          r.tenant_id === tenantId &&
          r.agent_id === agentId &&
          r.principal_type === principalType &&
          r.principal_id === principalId,
      )
      .sort((a, b) => b.version - a.version);
  }
}

describe("PermissionGrantService", () => {
  const deps = () => ({
    repo: new InMemoryGrantRepo(),
    clock: { nowMs: () => 1783529000000 },
  });

  it("appends versions and resolves the latest as effective policy", async () => {
    const svc = new PermissionGrantService(deps());
    const v1 = await svc.setBaseline({
      tenantId: "t",
      agentId: "a",
      rules: [{ effect: "deny", selector: "bash" }],
      approvedBy: "user-1",
    });
    expect(v1.version).toBe(1);
    const v2 = await svc.setBaseline({
      tenantId: "t",
      agentId: "a",
      rules: [{ effect: "ask", selector: "bash" }],
      approvedBy: "user-1",
    });
    expect(v2.version).toBe(2);

    const eff = await svc.resolveEffectivePolicy({ tenantId: "t", agentId: "a" });
    expect(eff?.grant_version).toBe(2);
    expect(eff?.rules).toEqual([{ effect: "ask", selector: "bash" }]);
    expect(
      (await svc.listBaselineVersions({ tenantId: "t", agentId: "a" })).map(
        (r) => r.version,
      ),
    ).toEqual([2, 1]);
  });

  it("disabled baseline resolves to null (legacy allow-all)", async () => {
    const svc = new PermissionGrantService(deps());
    await svc.setBaseline({
      tenantId: "t",
      agentId: "a",
      rules: [{ effect: "deny", selector: "*" }],
      enabled: false,
      approvedBy: "user-1",
    });
    expect(await svc.resolveEffectivePolicy({ tenantId: "t", agentId: "a" })).toBeNull();
  });

  it("requires approved_by", async () => {
    const svc = new PermissionGrantService(deps());
    await expect(
      svc.setBaseline({ tenantId: "t", agentId: "a", rules: [], approvedBy: " " }),
    ).rejects.toThrow(TypeError);
  });
});

describe("buildTools policy enforcement", () => {
  const agentWith = (rules: PermissionRule[] | null): AgentConfig =>
    ({
      id: "agent-1",
      name: "t",
      model: "claude-sonnet-5",
      system: "",
      tools: [],
      ...(rules ? { effective_policy: { rules } } : {}),
    }) as AgentConfig;

  it("deny removes the tool from the dict entirely", async () => {
    const tools = await buildTools(
      agentWith([{ effect: "deny", selector: "bash" }]),
      new TestSandbox(),
    );
    expect(tools.bash).toBeUndefined();
    expect(tools.read).toBeDefined();
  });

  it("glob deny removes tool families", async () => {
    const tools = await buildTools(
      agentWith([{ effect: "deny", selector: "web_*" }]),
      new TestSandbox(),
    );
    expect(tools.web_fetch).toBeUndefined();
    expect(tools.web_search).toBeUndefined();
    expect(tools.bash).toBeDefined();
  });

  it("ask strips execute so the call surfaces as pending", async () => {
    const tools = await buildTools(
      agentWith([{ effect: "ask", selector: "bash" }]),
      new TestSandbox(),
    );
    expect(tools.bash).toBeDefined();
    expect(tools.bash.execute).toBeUndefined();
  });

  it("no policy = legacy behavior", async () => {
    const tools = await buildTools(agentWith(null), new TestSandbox());
    expect(tools.bash).toBeDefined();
    expect(tools.bash.execute).toBeDefined();
  });
});
