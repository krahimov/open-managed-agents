import { describe, expect, it } from "vitest";

import { INITIAL_FORM, withEnvironment, type EnvironmentLite } from "./model";

const environments: EnvironmentLite[] = [
  { id: "env_session", name: "Sandbox", config: { sandbox: { provider: "daytona" } } },
  { id: "env_computer", name: "Computer", config: { sandbox: { provider: "daytona", scope: "agent", browser: true, desktop: true } } },
  { id: "env_headless", name: "No browser", config: { sandbox: { provider: "daytona", scope: "agent", browser: false } } },
];

describe("withEnvironment", () => {
  it("turns the browser tool on when a persistent agent computer is chosen", () => {
    const next = withEnvironment(INITIAL_FORM, "env_computer", environments);
    expect(next.environmentId).toBe("env_computer");
    expect(next.toolOverrides.browser).toBe("always_allow");
    // Ask first by default carries over to the browser.
    const asking = withEnvironment({ ...INITIAL_FORM, toolDefaultPermission: "always_ask" }, "env_computer", environments);
    expect(asking.toolOverrides.browser).toBe("always_ask");
  });

  it("leaves tools alone for a session sandbox or a computer without a browser", () => {
    expect(withEnvironment(INITIAL_FORM, "env_session", environments).toolOverrides).toEqual({});
    expect(withEnvironment(INITIAL_FORM, "env_headless", environments).toolOverrides).toEqual({});
  });

  it("keeps a browser setting the person chose, and an agent that starts from nothing", () => {
    const off = withEnvironment({ ...INITIAL_FORM, toolOverrides: { browser: "disabled" } }, "env_computer", environments);
    expect(off.toolOverrides.browser).toBe("disabled");
    const nothing = withEnvironment({ ...INITIAL_FORM, toolDefaultEnabled: false }, "env_computer", environments);
    expect(nothing.toolOverrides).toEqual({});
  });

  it("takes back the browser it turned on when a non-computer environment is chosen", () => {
    const computer = withEnvironment(INITIAL_FORM, "env_computer", environments);
    const back = withEnvironment(computer, "env_session", environments);
    expect(back.environmentId).toBe("env_session");
    expect(back.toolOverrides).toEqual({});
    expect(back.browserAutoOverride).toBeNull();
    // Back to the computer turns it on again.
    expect(withEnvironment(back, "env_computer", environments).toolOverrides.browser).toBe("always_allow");
    // Computer → computer keeps it, still tracked as automatic.
    const again = withEnvironment(computer, "env_computer", environments);
    expect(again.toolOverrides.browser).toBe("always_allow");
    expect(withEnvironment(again, "env_headless", environments).toolOverrides).toEqual({});
  });

  it("keeps a browser the person changed after it was turned on", () => {
    const computer = withEnvironment(INITIAL_FORM, "env_computer", environments);
    const asked = { ...computer, toolOverrides: { ...computer.toolOverrides, browser: "always_ask" as const } };
    expect(withEnvironment(asked, "env_session", environments).toolOverrides.browser).toBe("always_ask");
    // An explicit browser on an agent loaded that way is not automatic.
    const loaded = { ...INITIAL_FORM, environmentId: "env_computer", toolOverrides: { browser: "always_allow" as const } };
    expect(withEnvironment(loaded, "env_session", environments).toolOverrides.browser).toBe("always_allow");
  });
});
