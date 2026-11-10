import { describe, expect, it } from "vitest";
import { isAgentComputerEnvironment, pickDefaultEnvironmentId } from "./default-environment";

const computer = { id: "env_computer", config: { sandbox: { provider: "daytona", scope: "agent", browser: true, desktop: true } } };
const ordinary = { id: "env_ordinary", config: { sandbox: { provider: "daytona" } } };
const sessionScoped = { id: "env_session", config: { sandbox: { scope: "session" } } };
const bare = { id: "env_bare" };

describe("default environment for new agents and sessions", () => {
  it("skips an agent-computer environment even when it is first in the list", () => {
    expect(pickDefaultEnvironmentId([computer, ordinary, sessionScoped])).toBe("env_ordinary");
  });

  it("keeps the first environment when none is an agent computer", () => {
    expect(pickDefaultEnvironmentId([ordinary, sessionScoped])).toBe("env_ordinary");
    expect(pickDefaultEnvironmentId([bare, ordinary])).toBe("env_bare");
  });

  it("picks nothing when only agent-computer environments exist", () => {
    expect(pickDefaultEnvironmentId([computer])).toBe("");
    expect(pickDefaultEnvironmentId([])).toBe("");
  });

  it("recognises only an explicit agent scope as an agent computer", () => {
    expect(isAgentComputerEnvironment(computer)).toBe(true);
    expect(isAgentComputerEnvironment(ordinary)).toBe(false);
    expect(isAgentComputerEnvironment(sessionScoped)).toBe(false);
    expect(isAgentComputerEnvironment(bare)).toBe(false);
    expect(isAgentComputerEnvironment({ id: "env_null", config: { sandbox: null } })).toBe(false);
  });
});
