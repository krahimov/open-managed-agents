import { describe, expect, it } from "vitest";

import { askFromInstructions, askFromTitle, asksFromDescription, buildStarters, shortLabel, STARTER_LABEL_MAX, withArticle } from "./starters";

describe("asksFromDescription", () => {
  it("turns each thing an agent does into an ask", () => {
    expect(asksFromDescription("Classifies inbound support tickets, matches known issues, and drafts first replies.")).toEqual([
      "Classify inbound support tickets",
      "Match known issues",
      "Draft first replies",
    ]);
    expect(asksFromDescription("Builds onboarding plans for new customers and keeps the Notion tracker up to date.")).toEqual([
      "Build onboarding plans for new customers",
      "Keep the Notion tracker up to date",
    ]);
  });

  it("does not split a list of nouns into separate asks", () => {
    expect(
      asksFromDescription("Reviews pull requests for correctness, edge cases and test coverage; posts inline GitHub reviews."),
    ).toEqual(["Review pull requests for correctness, edge cases and test coverage", "Post inline GitHub reviews"]);
    expect(asksFromDescription("Turns merged pull requests and closed Linear issues into customer-facing release notes.")).toEqual([
      "Turn merged pull requests and closed Linear issues into customer-facing release notes",
    ]);
  });

  it("asks for a job that is named by its schedule", () => {
    expect(
      asksFromDescription("Nightly checks on warehouse tables against a 14-day baseline; flags anomalies with likely upstream cause."),
    ).toEqual(["Run nightly checks on warehouse tables against a 14-day baseline", "Flag anomalies with likely upstream cause"]);
  });

  it("stops at a colon that introduces a list", () => {
    expect(
      asksFromDescription("Runs SEV-2/3 incident response: triage, comms cadence, mitigation proposals and postmortems."),
    ).toEqual(["Run SEV-2/3 incident response"]);
  });

  it("leaves out anything that does not open with a verb it knows", () => {
    expect(asksFromDescription("Experimental batch scorer for churn risk; flags accounts with likely drivers.")).toEqual([
      "Flag accounts with likely drivers",
    ]);
    expect(
      asksFromDescription("Reconciles Stripe payouts against the ledger and flags duplicate vendor invoices. Posting requires approval."),
    ).toEqual(["Reconcile Stripe payouts against the ledger", "Flag duplicate vendor invoices"]);
    expect(asksFromDescription("Sales assistant for the EMEA team.")).toEqual([]);
    expect(asksFromDescription("")).toEqual([]);
    expect(asksFromDescription(undefined)).toEqual([]);
  });
});

describe("askFromTitle", () => {
  it("never offers an old title with its date", () => {
    expect(askFromTitle("Nightly DQ check — Nov 4")).toEqual({
      label: "Run the nightly DQ check",
      text: "Run the nightly DQ check",
      open: false,
    });
    expect(askFromTitle("Nightly DQ check — orders_fact anomaly (Nov 3)")?.label).toBe("Run the nightly DQ check");
    expect(askFromTitle("Weekly revenue cohort analysis — Q4 retention by plan")?.label).toBe("Run the weekly revenue cohort analysis");
    expect(askFromTitle("Flag duplicate vendor invoices — September")?.text).toBe("Flag duplicate vendor invoices");
    expect(askFromTitle("Reconcile vendor payouts - 2026-11-04")?.text).toBe("Reconcile vendor payouts");
  });

  it("keeps a title that is already an ask", () => {
    expect(askFromTitle("Coordinate v2.14 release readiness")).toEqual({
      label: "Coordinate v2.14 release readiness",
      text: "Coordinate v2.14 release readiness",
      open: false,
    });
    expect(askFromTitle("Reconcile October Stripe payouts vs. ledger")?.open).toBe(false);
    expect(askFromTitle("How do I rotate an API key?")?.text).toBe("How do I rotate an API key?");
    expect(askFromTitle("Review the billing module — focus on proration")?.text).toBe("Review the billing module — focus on proration");
  });

  it("leaves the case open when the title names a kind of work and one case of it", () => {
    // The chip asks for a new one, whole; the composer gets the work's own words to finish.
    expect(askFromTitle("Call summary — Initech discovery (Nov 3)")).toEqual({ label: "New call summary…", text: "Call summary — ", open: true });
    expect(askFromTitle("Release notes — v2.14.0 (Nov 4 train)")?.label).toBe("New release notes…");
    expect(askFromTitle("Pricing teardown: Acme Analytics Enterprise tier")).toEqual({
      label: "New pricing teardown…",
      text: "Pricing teardown: ",
      open: true,
    });
    expect(askFromTitle("Onboarding plan for Globex Corp (42 seats, SSO + SCIM)")).toEqual({
      label: "New onboarding plan…",
      text: "Onboarding plan for ",
      open: true,
    });
    expect(askFromTitle("Nightly DQ check — orders_fact anomaly (Nov 3)")?.label).toBe("Run the nightly DQ check");
    // The work, then one case of it: asked by what the case is.
    expect(askFromTitle("Triage: SSO login loop after Okta migration (ACME-4821)")).toEqual({
      label: "Triage a ticket…",
      text: "Triage: ",
      open: true,
    });
    expect(askFromTitle("Triage: checkout latency spike")?.label).toBe("Triage a new case…");
    // A numbered case is over; the ask is not.
    expect(askFromTitle("Review PR #1842 — billing: proration for mid-cycle plan changes")).toEqual({
      label: "Review a PR…",
      text: "Review PR #",
      open: true,
    });
    expect(askFromTitle("Investigate ticket ACME-4821")).toEqual({
      label: "Investigate a ticket…",
      text: "Investigate ticket ACME-",
      open: true,
    });
    expect(askFromTitle("Escalate incident #88")?.label).toBe("Escalate an incident…");
  });

  it("never offers a chip that reads as cut off", () => {
    const labels = [
      "Call summary — Initech discovery (Nov 3)",
      "Release notes — v2.14.0 (Nov 4 train)",
      "Pricing teardown: Acme Analytics Enterprise tier",
      "Onboarding plan for Globex Corp (42 seats, SSO + SCIM)",
      "Triage: SSO login loop after Okta migration (ACME-4821)",
      "Review PR #1842 — billing: proration for mid-cycle plan changes",
      "Investigate ticket ACME-4821",
    ].map((t) => askFromTitle(t)!.label);
    for (const label of labels) {
      // Not "Review PR #…", "Triage: …", "Onboarding plan for …".
      expect(label).not.toMatch(/[#:—–-]\s*…$|\s…$|\b(for|of|on|about|the|and)…$/);
      expect(label).toMatch(/^[A-Z]/);
    }
  });

  it("puts the right article before what is asked for", () => {
    expect(withArticle("PR")).toBe("a PR");
    expect(withArticle("SLA breach")).toBe("an SLA breach");
    expect(withArticle("incident")).toBe("an incident");
    expect(withArticle("user report")).toBe("a user report");
    expect(withArticle("update")).toBe("an update");
    expect(withArticle("the ticket")).toBe("the ticket");
  });

  it("leaves out a title that cannot be read as an ask", () => {
    expect(askFromTitle("SEV-2: elevated 5xx on api-gateway (eu-west-1)")).toBeNull();
    expect(askFromTitle("Ad-hoc: top 20 accounts by query volume")).toBeNull();
    expect(askFromTitle("Quarterly numbers")).toEqual({ label: "Run the quarterly numbers", text: "Run the quarterly numbers", open: false });
    expect(askFromTitle("Miscellaneous notes")).toBeNull();
  });
});

describe("askFromInstructions", () => {
  it("reads the job from the line the instructions open with", () => {
    expect(askFromInstructions("You review pull requests for the lumen-hq/platform monorepo. Check out the branch.")).toBe(
      "Review pull requests for the lumen-hq/platform monorepo",
    );
    expect(askFromInstructions("Summarize sales call transcripts for Lumen's AEs: attendees, pain, current stack.")).toBe(
      "Summarize sales call transcripts for Lumen's AEs",
    );
  });

  it("does not read a rule of behaviour as an ask", () => {
    expect(askFromInstructions("You are an on-call incident commander. When handed a Sentry issue ID, pull the payload.")).toBeNull();
    expect(askFromInstructions("Never promise ship dates. Be decisive.")).toBeNull();
  });
});

describe("shortLabel", () => {
  it("keeps what fits", () => {
    expect(shortLabel("Release notes — v2.14.0 (Nov 4 train)")).toBe("Release notes — v2.14.0 (Nov 4 train)");
  });

  it("shortens to something that still reads whole", () => {
    expect(shortLabel("Triage: SSO login loop after Okta migration (ACME-4821) and the follow-up")).not.toMatch(/\($/);
    expect(shortLabel("Onboarding plan for Globex Corp (42 seats, SSO + SCIM)")).toBe("Onboarding plan for Globex Corp");
    expect(shortLabel("Review PR #1842 — billing: proration for mid-cycle plan changes")).toBe("Review PR #1842");
    expect(shortLabel("Review pull requests for correctness, edge cases and test coverage")).toBe("Review pull requests");
  });

  it("stops after the first whole action when a second one is joined on", () => {
    expect(shortLabel("Sweep the untriaged queue and triage anything older than 2 hours.")).toBe("Sweep the untriaged queue…");
  });

  it("falls back to an ellipsis at a word, never mid-word, never on a word that leads somewhere", () => {
    const text = "Summarize yesterday's warehouse anomalies into a digest of the likely upstream causes";
    const label = shortLabel(text);
    expect(label.endsWith("…")).toBe(true);
    expect(label.length).toBeLessThanOrEqual(STARTER_LABEL_MAX);
    expect(text.startsWith(label.slice(0, -1))).toBe(true);
    expect(label).not.toMatch(/\s…$/);
    expect(label).not.toMatch(/\b(a|an|the|and|of|into|to)…$/);
  });
});

describe("buildStarters", () => {
  const triage = {
    id: "agent-triage",
    name: "Support Triage",
    description: "Classifies inbound support tickets, matches known issues, and drafts first replies.",
    system: "You are Lumen's support triage agent. For every inbound ticket: classify severity.",
  };
  const now = Date.parse("2026-11-10T12:00:00Z");
  const session = (id: string, title: string | null, agentId = "agent-triage", metadata: Record<string, unknown> = {}) => ({
    id,
    title,
    created_at: "2026-11-04T10:58:00Z",
    agent: { id: agentId },
    metadata,
  });

  it("mixes what the agent does, what its schedule asks and what it was asked before", () => {
    const starters = buildStarters({
      agent: triage,
      now,
      rules: [
        {
          id: "r1",
          name: "Morning queue sweep",
          trigger: { source: "schedule", config: { prompt: "Sweep the untriaged queue and triage anything older than 2 hours." } },
        },
        { id: "r2", name: "New Linear bug from customer", trigger: { source: "linear", config: { event: "issue.created" } } },
      ],
      sessions: [
        session("s0", "hey"),
        session("s1", "Triage: SSO login loop after Okta migration (ACME-4821)"),
        session("s2", "Review PR #1842", "agent-other"),
      ],
    });
    expect(starters.map((s) => [s.kind, s.label])).toEqual([
      ["job", "Classify inbound support tickets"],
      ["job", "Match known issues"],
      ["trigger", "Sweep the untriaged queue…"],
      ["recent", "Triage a ticket…"],
    ]);
    // The chip is short; the composer gets the whole ask.
    expect(starters[2].text).toBe("Sweep the untriaged queue and triage anything older than 2 hours.");
    // History is offered as the work with its case left open, and says where it came from.
    expect(starters[3].text).toBe("Triage: ");
    expect(starters[3].hint).toContain("Triage: SSO login loop after Okta migration (ACME-4821)");
    expect(starters[3].hint).toContain("6 days ago");
  });

  it("never names the agent on a chip", () => {
    const starters = buildStarters({ agent: triage, now });
    for (const s of starters) expect(s.label).not.toContain("Support Triage");
  });

  it("does not offer the same ask twice", () => {
    const starters = buildStarters({
      agent: {
        id: "agent-dq",
        name: "Data Quality Monitor",
        description: "Nightly checks on warehouse tables against a 14-day baseline; flags anomalies with likely upstream cause.",
      },
      now,
      rules: [
        {
          id: "r1",
          name: "Nightly warehouse DQ check",
          trigger: { source: "schedule", config: { prompt: "Scheduled run: nightly data-quality check for the analytics warehouse." } },
        },
      ],
      sessions: [
        session("s0", "hey", "agent-dq"),
        session("s1", "Nightly DQ check — Nov 4", "agent-dq"),
        session("s2", "Nightly DQ check — orders_fact anomaly (Nov 3)", "agent-dq"),
        session("s3", "Nightly DQ check — Nov 2", "agent-dq"),
      ],
    });
    // The schedule asks what the first job already says, and so do the three
    // nightly runs ("Run the nightly DQ check"): the job is offered once.
    expect(starters.map((s) => [s.kind, s.label])).toEqual([
      ["job", "Run nightly checks on warehouse tables"],
      ["job", "Flag anomalies with likely upstream cause"],
    ]);
    // No chip is an old title with a date in it.
    for (const s of starters) expect(s.label).not.toMatch(/Nov \d/);
    expect(starters[0].text).toBe("Run nightly checks on warehouse tables against a 14-day baseline");
  });

  it("does not repeat a job with a dated copy of it from history", () => {
    const starters = buildStarters({
      agent: {
        id: "agent-fin",
        name: "Finance Ops Reconciler",
        description: "Reconciles Stripe payouts against the ledger and flags duplicate vendor invoices.",
      },
      now,
      sessions: [
        session("s1", "Reconcile October Stripe payouts vs. ledger", "agent-fin"),
        session("s2", "Flag duplicate vendor invoices — September", "agent-fin"),
      ],
    });
    expect(starters.map((s) => s.label)).toEqual(["Reconcile Stripe payouts against the ledger", "Flag duplicate vendor invoices"]);
  });

  it("skips sessions that were not a person's ask", () => {
    const starters = buildStarters({
      agent: { id: "agent-x", name: "X", description: "Reviews pull requests." },
      now,
      sessions: [
        session("s1", null, "agent-x"),
        session("s2", "Walk me through setting up your harness", "agent-x", { oma_setup: true }),
        session("s3", "sso-loop-known-issue trial one", "agent-x", { eval: { run_id: "r" } }),
      ],
    });
    expect(starters.map((s) => s.key)).not.toContain("recent-s1");
    expect(starters.some((s) => s.kind === "recent")).toBe(false);
  });

  it("pairs a lone job with a question, not with a near copy of it from history", () => {
    const starters = buildStarters({
      agent: { id: "agent-eng", name: "Engineering Coordinator", system: "You coordinate engineering release readiness." },
      now,
      sessions: [session("s1", "Coordinate v2.14 release readiness", "agent-eng")],
    });
    expect(starters.map((s) => s.label)).toEqual(["Coordinate engineering release readiness", "What can you help me with?"]);
  });

  it("offers a kind of work from history once, with the case left open", () => {
    const starters = buildStarters({
      agent: { id: "agent-sales", name: "Sales Call Summarizer", description: "Summarizes sales call transcripts." },
      now,
      sessions: [
        session("s1", "Call summary — Initech discovery (Nov 3)", "agent-sales"),
        session("s2", "Call summary — Initech discovery (Nov 3)", "agent-sales"),
        session("s3", "Call summary — Hooli renewal negotiation", "agent-sales"),
      ],
    });
    expect(starters.map((s) => s.label)).toEqual(["Summarize sales call transcripts", "New call summary…"]);
    expect(starters[1].text).toBe("Call summary — ");
  });

  it("says a long job the short way its instructions do", () => {
    const starters = buildStarters({
      agent: {
        id: "agent-rn",
        name: "Release Notes Writer",
        description: "Turns merged pull requests and closed Linear issues into customer-facing release notes.",
        system: "You write Lumen's customer-facing release notes. Given a version range, list merged PRs.",
      },
      now,
    });
    expect(starters[0].label).toBe("Write Lumen's customer-facing release notes");
  });

  it("still has something to offer for an agent nothing is known about", () => {
    const starters = buildStarters({ agent: { id: "agent-new", name: "New agent" }, now });
    expect(starters.length).toBeGreaterThan(0);
    expect(starters[0].text.length).toBeGreaterThan(10);
  });

  it("offers nothing without an agent", () => {
    expect(buildStarters({ agent: null })).toEqual([]);
  });
});
