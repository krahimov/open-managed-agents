import { describe, expect, it } from "vitest";

import { restates } from "./TriggersTab";

describe("a trigger's description", () => {
  const shown = ["Review PRs labelled needs-agent-review", "GitHub: pull request labeled", "GitHub", "pull_request.labeled", "label", "needs-agent-review", "repo", "lumen-hq/platform"];

  it("is left out when it only restates the trigger", () => {
    expect(restates("Wake on GitHub pull_request.labeled with label needs-agent-review.", shown)).toBe(true);
    expect(restates("", shown)).toBe(true);
    expect(restates(undefined, shown)).toBe(true);
  });

  it("is kept when it says something the card does not", () => {
    expect(restates("Only for pull requests that touch billing code.", shown)).toBe(false);
    expect(restates("Checks the warehouse tables against a 14-day baseline.", ["Nightly DQ check", "Every day at 02:00", "Schedule"])).toBe(false);
  });
});
