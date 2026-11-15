import { describe, expect, it } from "vitest";
import { appLogo, appLogoKey } from "./app-logos";

describe("app logos", () => {
  it("finds the bundled logo by id or by name", () => {
    for (const key of ["gmail", "Google Docs", "googledrive", "Notion", "slack", "Jira", "linear", "microsoft_teams"]) {
      expect(appLogo(key)?.src, key).toBeTruthy();
    }
    expect(appLogoKey("Google Drive")).toBe("googledrive");
    expect(appLogoKey("notion-mcp")).toBe("notion");
    expect(appLogoKey("X")).toBe("twitter");
  });

  it("has no logo for an app outside the set", () => {
    expect(appLogo("acme-internal")).toBeUndefined();
    expect(appLogo("")).toBeUndefined();
  });

  it("draws the all-black logos in white in dark mode", () => {
    expect(appLogo("github")?.invertInDark).toBe(true);
    expect(appLogo("gmail")?.invertInDark).toBe(false);
  });
});
