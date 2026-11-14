import { describe, expect, it } from "vitest";

import { matchRanges, matchTier, NAME_TIER, rank, unmatchedWords, type Rankable } from "./palette-rank";

// A cut of the demo workspace, in the order the palette builds its rows:
// actions, pages, agents, then sessions newest first.
const ROWS: Rankable[] = [
  { name: "New session", more: "start conversation chat compose", weight: 0 },
  { name: "New agent", more: "create", weight: 0 },
  { name: "Sessions", more: "conversations chats runs history", weight: 1 },
  { name: "Operations", more: "approvals failures budgets attention inbox", weight: 1 },
  { name: "Usage", more: "cost spend tokens analytics billing Run", weight: 1 },
  { name: "Skills", more: "catalog capabilities Build", weight: 1 },
  {
    name: "Support Triage",
    more: "agent Triages inbound support tickets from Linear and Slack",
    id: "agent-5ahomh6eio9nv0uv",
    weight: 2,
  },
  {
    name: "Incident Commander",
    more: "agent Runs incident response from PagerDuty: triage, status updates, postmortem",
    id: "agent-rqpb31dz0iuhc5ps",
    weight: 2,
  },
  { name: "PR Reviewer", more: "agent Reviews pull requests", id: "agent-rrtcdqruug4a13d0", weight: 2 },
  { name: "Nightly DQ check — Nov 4", more: "session Data Quality Monitor", id: "sess-nbxxbv7wxa4x1693", weight: 3, many: true },
  {
    name: "Triage: SSO login loop after Okta migration (ACME-4821)",
    more: "session Support Triage",
    id: "sess-viaohveyx42onk5d",
    weight: 3,
    many: true,
  },
  { name: "Review PR #1842 — billing: proration for mid-cycle plan changes", more: "session PR Reviewer", id: "sess-p3rwem0sdct04bgp", weight: 3, many: true },
  { name: "Triage: CSV export times out for >50k rows (GLOBEX-118)", more: "session Support Triage", id: "sess-ua9o5zxny1f352g2", weight: 3, many: true },
];

const names = (query: string) => rank(query, ROWS).map((r) => r.item.name);

describe("palette ranking", () => {
  it("puts the agent named for the query above the sessions titled with it", () => {
    const got = names("triage");
    expect(got.slice(0, 3)).toEqual([
      "Support Triage",
      "Triage: SSO login loop after Okta migration (ACME-4821)",
      "Triage: CSV export times out for >50k rows (GLOBEX-118)",
    ]);
    // A page whose keywords merely contain the letters is not a match at all.
    expect(got).not.toContain("Operations");
    // A description that mentions the word ranks below every name match.
    expect(got.indexOf("Incident Commander")).toBeGreaterThan(got.indexOf("Support Triage"));
  });

  it("ranks an exact name over a prefix, a prefix over a word start, and names over the rest", () => {
    expect(matchTier("sessions", ROWS[2])).toBe(0);
    expect(matchTier("sess", ROWS[2])).toBe(1);
    expect(matchTier("sess", ROWS[0])).toBe(2); // New session
    expect(matchTier("port", ROWS[6])).toBe(3); // Support Triage
    expect(matchTier("billing", ROWS[4])).toBeGreaterThan(NAME_TIER); // Usage, by keyword
    expect(names("sess").slice(0, 2)).toEqual(["Sessions", "New session"]);
  });

  it("matches several words in any order against word starts", () => {
    expect(names("tri sup")[0]).toBe("Support Triage");
    expect(names("pr rev")[0]).toBe("PR Reviewer");
  });

  it("breaks ties inside a tier by kind, then by the order given", () => {
    // "s" starts Sessions and Skills (pages) and Support Triage (an agent).
    expect(names("s").slice(0, 3)).toEqual(["Sessions", "Skills", "Support Triage"]);
  });

  it("ranks any named thing whose name contains the query above every session title, except an exact title", () => {
    // "port" is only inside "Support" (tier 3) while it starts no session title here;
    // "review" starts a session title (tier 1) and a word of the agent's name (tier 2).
    expect(names("review").slice(0, 2)).toEqual(["PR Reviewer", "Review PR #1842 — billing: proration for mid-cycle plan changes"]);
    const rows: Rankable[] = [
      { name: "Triage", more: "session Support Triage", weight: 3, many: true },
      { name: "Support Triage", more: "agent", weight: 2 },
      { name: "Triage: SSO login loop", more: "session Support Triage", weight: 3, many: true },
    ];
    expect(rank("triage", rows).map((r) => r.item.name)).toEqual(["Triage", "Support Triage", "Triage: SSO login loop"]);
  });

  it("matches a name on a keyword or description only after the names", () => {
    const got = names("billing");
    expect(got[0]).toBe("Review PR #1842 — billing: proration for mid-cycle plan changes");
    expect(got).toContain("Usage");
  });

  it("finds a record by a piece of its id, last, and only from five characters", () => {
    expect(names("5ahomh")).toEqual(["Support Triage"]);
    expect(matchTier("5ahomh", ROWS[6])).toBe(6);
    expect(matchTier("5aho", ROWS[6])).toBeNull();
  });

  it("matches nothing for an empty query and ignores case and accents", () => {
    expect(rank("  ", ROWS)).toEqual([]);
    expect(names("TRIÁGE")[0]).toBe("Support Triage");
  });
});

describe("what a query matched", () => {
  const cut = (text: string, query: string) => matchRanges(query, text).map(([a, b]) => text.slice(a, b));

  it("marks each word of the query where it starts a word, else where it first appears", () => {
    expect(cut("Support Triage", "triage")).toEqual(["Triage"]);
    expect(cut("Support Triage", "tri sup")).toEqual(["Sup", "Tri"]);
    expect(cut("Support Triage", "port")).toEqual(["port"]);
    // "re" is inside "Pre" first, but starts "release": the word start wins.
    expect(cut("Prepares release notes", "re")).toEqual(["re"]);
    expect(matchRanges("re", "Prepares release notes")).toEqual([[9, 11]]);
  });

  it("ignores case and accents and still points into the original text", () => {
    expect(cut("Résumé screening", "resume")).toEqual(["Résumé"]);
    expect(cut("Runs incident response from PagerDuty: triage", "PAGERDUTY")).toEqual(["PagerDuty"]);
  });

  it("marks an id as typed and nothing when there is no match", () => {
    expect(cut("agent-5ahomh6eio9nv0uv", "5ahomh")).toEqual(["5ahomh"]);
    expect(cut("sess-viaohveyx42onk5d", "sess-via")).toEqual(["sess-via"]);
    expect(matchRanges("zebra", "Support Triage")).toEqual([]);
    expect(matchRanges("", "Support Triage")).toEqual([]);
  });

  it("merges marks that touch", () => {
    expect(matchRanges("sup support", "Support Triage")).toEqual([[0, 7]]);
  });

  it("says which words a name leaves unexplained", () => {
    expect(unmatchedWords("triage pagerduty", "Incident Commander")).toEqual(["triage", "pagerduty"]);
    expect(unmatchedWords("incident pagerduty", "Incident Commander")).toEqual(["pagerduty"]);
    expect(unmatchedWords("inc", "Incident Commander")).toEqual([]);
  });
});
