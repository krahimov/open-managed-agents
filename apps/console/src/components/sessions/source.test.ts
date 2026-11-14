import { describe, expect, it } from "vitest";

import { findLinearAddress, githubLink, linearIssueLink, linearUrlKey } from "./source";

describe("the address of a Linear issue", () => {
  it("is the one the session's own log gives for that issue", () => {
    const found = findLinearAddress(
      ["# Linear supervisor pickup\n\n**Issue:** ENG-142\n**URL:** https://linear.app/lumen/issue/ENG-142/sso-login-loop-after-okta\n"],
      "ENG-142",
    );
    expect(found).toEqual({ issueUrl: "https://linear.app/lumen/issue/ENG-142/sso-login-loop-after-okta", urlKey: "lumen" });
    expect(linearIssueLink({ issueIdentifier: "ENG-142" }, found)).toBe("https://linear.app/lumen/issue/ENG-142/sso-login-loop-after-okta");
  });

  it("is built from the workspace another issue in the log lives in", () => {
    // The seed's case: the agent linked a duplicate, SUP-455; the session is about SUP-482.
    const found = findLinearAddress(['{"duplicate":"https://linear.app/lumen/issue/SUP-455#comment-c0f1a9e2"}'], "SUP-482");
    expect(found).toEqual({ urlKey: "lumen" });
    expect(linearIssueLink({ issueIdentifier: "sup-482", issueId: "lin_iss_7f3a2c" }, found)).toBe("https://linear.app/lumen/issue/SUP-482");
    // Read twice: the reader keeps no position between calls.
    expect(findLinearAddress(["see https://linear.app/lumen/issue/SUP-455"], "SUP-482").urlKey).toBe("lumen");
  });

  it("is built from the connected workspace when that records a url key, and not from a UUID", () => {
    expect(linearUrlKey("lumen")).toBe("lumen");
    expect(linearUrlKey("3f2a9c1e-7b64-4c1d-9a55-0d6f1e2b3c4d")).toBeUndefined();
    expect(linearUrlKey("Lumen Analytics")).toBeUndefined();
    expect(linearUrlKey(null)).toBeUndefined();
    expect(linearIssueLink({ issueIdentifier: "ENG-7" }, { workspaceKey: "lumen" })).toBe("https://linear.app/lumen/issue/ENG-7");
  });

  it("is not guessed: with no workspace, or no identifier people use, there is no link", () => {
    expect(linearIssueLink({ issueIdentifier: "ENG-7" }, {})).toBeNull();
    expect(linearIssueLink({ issueId: "3f2a9c1e-7b64-4c1d-9a55-0d6f1e2b3c4d" }, { urlKey: "lumen" })).toBeNull();
    expect(linearIssueLink(null, { urlKey: "lumen" })).toBeNull();
    expect(findLinearAddress(["nothing here", "https://linear.app/docs/issue-tracking"], "ENG-7")).toEqual({ urlKey: undefined });
  });
});

describe("where a GitHub session opens", () => {
  it("uses the address the webhook sent", () => {
    expect(
      githubLink({ repository: "lumen-analytics/billing", itemKind: "pull_request", itemNumber: 1842, htmlUrl: "https://github.com/lumen-analytics/billing/pull/1842" }),
    ).toEqual({ href: "https://github.com/lumen-analytics/billing/pull/1842", opens: "pull request", label: "lumen-analytics/billing#1842" });
  });

  it("builds it from the repository, the kind and the number otherwise", () => {
    expect(githubLink({ repository: "lumen-analytics/api", itemKind: "issue", itemNumber: 977, htmlUrl: null })).toEqual({
      href: "https://github.com/lumen-analytics/api/issues/977",
      opens: "issue",
      label: "lumen-analytics/api#977",
    });
    expect(githubLink({ repository: "lumen-analytics/api" })).toMatchObject({ href: "https://github.com/lumen-analytics/api", opens: "repository" });
    expect(githubLink({ repository: "not a repo" })).toBeNull();
    expect(githubLink(null)).toBeNull();
  });
});
