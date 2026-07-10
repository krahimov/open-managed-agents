// Mission supervisor decision logic — pure-function coverage for the
// wait|verify|spawn|succeed|exhaust|stuck contract the pump executes
// (apps/main-node/src/lib/node-mission-supervisor.ts).
import { describe, it, expect } from "vitest";
import {
  decideMissionAction,
  validateMissionInput,
  verdictSignature,
  type MissionDecisionInput,
  type MissionVerdict,
} from "../../apps/main-node/src/lib/mission-decision";

const T0 = 1_700_000_000_000;
const MIN = 60_000;

function verdict(opts: {
  iteration?: number;
  results?: Array<{ command: string; pass: boolean; output_snippet?: string }>;
  all_pass?: boolean;
}): MissionVerdict {
  const results = (opts.results ?? [{ command: "make test", pass: false }]).map((r) => ({
    command: r.command,
    pass: r.pass,
    output_snippet: r.output_snippet ?? "",
  }));
  return {
    iteration: opts.iteration ?? 1,
    results,
    all_pass: opts.all_pass ?? results.every((r) => r.pass),
    judge: "skipped",
    at: new Date(T0).toISOString(),
  };
}

function input(overrides: Partial<MissionDecisionInput>): MissionDecisionInput {
  return {
    status: "running",
    iteration: 1,
    budget: { max_iterations: 5, wall_clock_minutes: 60 },
    createdAt: T0,
    now: T0 + 5 * MIN,
    activeSession: null,
    verdictHistory: [],
    ...overrides,
  };
}

describe("decideMissionAction — session lifecycle", () => {
  it("waits while the active session is still working", () => {
    expect(
      decideMissionAction(input({ activeSession: { state: "working" } })),
    ).toBe("wait");
  });

  it("verifies when the active session finished its turn", () => {
    expect(
      decideMissionAction(input({ activeSession: { state: "finished" } })),
    ).toBe("verify");
  });

  it("spawns when there is no active session and budget remains", () => {
    expect(decideMissionAction(input({ iteration: 0 }))).toBe("spawn");
  });
});

describe("decideMissionAction — stopped / terminal missions never act", () => {
  it("stopped mission never spawns", () => {
    expect(decideMissionAction(input({ status: "stopped", iteration: 0 }))).toBe("wait");
  });

  it("stopped mission never verifies a finished session", () => {
    expect(
      decideMissionAction(
        input({ status: "stopped", activeSession: { state: "finished" } }),
      ),
    ).toBe("wait");
  });

  for (const status of ["succeeded", "budget_exhausted", "stuck"] as const) {
    it(`${status} mission stays inert`, () => {
      expect(decideMissionAction(input({ status, iteration: 0 }))).toBe("wait");
    });
  }
});

describe("decideMissionAction — fresh verdict outcomes", () => {
  it("succeeds when every verifier passed", () => {
    const v = verdict({ results: [{ command: "make test", pass: true }] });
    expect(
      decideMissionAction(
        input({
          activeSession: { state: "finished" },
          freshVerdict: v,
          verdictHistory: [v],
        }),
      ),
    ).toBe("succeed");
  });

  it("succeeds even on the final budgeted iteration (all_pass wins over exhaust)", () => {
    const v = verdict({ results: [{ command: "make test", pass: true }] });
    expect(
      decideMissionAction(
        input({
          iteration: 5,
          activeSession: { state: "finished" },
          freshVerdict: v,
          verdictHistory: [v],
        }),
      ),
    ).toBe("succeed");
  });

  it("respawns on failure while budget remains", () => {
    const v = verdict({});
    expect(
      decideMissionAction(
        input({
          activeSession: { state: "finished" },
          freshVerdict: v,
          verdictHistory: [v],
        }),
      ),
    ).toBe("spawn");
  });
});

describe("decideMissionAction — iteration budget edge", () => {
  it("exhausts when the failing iteration is exactly max_iterations", () => {
    const v = verdict({ iteration: 5 });
    expect(
      decideMissionAction(
        input({
          iteration: 5,
          freshVerdict: v,
          verdictHistory: [v],
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("exhaust");
  });

  it("spawns when the failing iteration is one below max_iterations", () => {
    const v = verdict({ iteration: 4 });
    expect(
      decideMissionAction(
        input({
          iteration: 4,
          freshVerdict: v,
          verdictHistory: [v],
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("spawn");
  });

  it("exhausts instead of spawning when iterations are already spent (no fresh verdict)", () => {
    expect(decideMissionAction(input({ iteration: 5, activeSession: null }))).toBe("exhaust");
  });
});

describe("decideMissionAction — wall-clock edge", () => {
  it("exhausts at exactly the wall-clock boundary", () => {
    const v = verdict({});
    expect(
      decideMissionAction(
        input({
          now: T0 + 60 * MIN,
          freshVerdict: v,
          verdictHistory: [v],
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("exhaust");
  });

  it("spawns one millisecond before the wall-clock boundary", () => {
    const v = verdict({});
    expect(
      decideMissionAction(
        input({
          now: T0 + 60 * MIN - 1,
          freshVerdict: v,
          verdictHistory: [v],
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("spawn");
  });

  it("exhausts between iterations when the window elapsed while idle", () => {
    expect(
      decideMissionAction(
        input({ iteration: 2, now: T0 + 61 * MIN, activeSession: null }),
      ),
    ).toBe("exhaust");
  });
});

describe("decideMissionAction — stuck rule (3 identical failures)", () => {
  const fail = () =>
    verdict({
      results: [
        { command: "make test", pass: false },
        { command: "make lint", pass: true },
      ],
    });

  it("goes stuck after 3 identical failing verdicts", () => {
    const history = [fail(), fail(), fail()];
    expect(
      decideMissionAction(
        input({
          freshVerdict: history[2],
          verdictHistory: history,
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("stuck");
  });

  it("keeps spawning with only 2 identical failures", () => {
    const history = [fail(), fail()];
    expect(
      decideMissionAction(
        input({
          freshVerdict: history[1],
          verdictHistory: history,
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("spawn");
  });

  it("keeps spawning when the failure signature changed within the last 3", () => {
    const different = verdict({
      results: [
        { command: "make test", pass: true },
        { command: "make lint", pass: false },
      ],
    });
    const history = [fail(), different, fail()];
    expect(
      decideMissionAction(
        input({
          freshVerdict: history[2],
          verdictHistory: history,
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("spawn");
  });

  it("a pass inside the last 3 resets the stuck window", () => {
    const pass = verdict({ results: [{ command: "make test", pass: true }] });
    const history = [fail(), pass, fail()];
    expect(
      decideMissionAction(
        input({
          freshVerdict: history[2],
          verdictHistory: history,
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("spawn");
  });

  it("exhaust wins over stuck at the budget boundary (spec order)", () => {
    const history = [fail(), fail(), fail()];
    expect(
      decideMissionAction(
        input({
          iteration: 5,
          freshVerdict: history[2],
          verdictHistory: history,
          activeSession: { state: "finished" },
        }),
      ),
    ).toBe("exhaust");
  });

  it("signature ignores output snippets (noisy logs don't defeat stuck)", () => {
    const a = verdict({
      results: [{ command: "make test", pass: false, output_snippet: "run 1" }],
    });
    const b = verdict({
      results: [{ command: "make test", pass: false, output_snippet: "run 2" }],
    });
    expect(verdictSignature(a)).toBe(verdictSignature(b));
  });
});

describe("validateMissionInput", () => {
  const ok = {
    goal: "make the tests pass",
    verifiers: [{ kind: "command", command: "make test" }],
    budget: { max_iterations: 10, wall_clock_minutes: 60 },
  };

  it("accepts a sane mission and normalizes it", () => {
    const v = validateMissionInput(ok);
    expect(v.goal).toBe("make the tests pass");
    expect(v.verifiers).toEqual([{ kind: "command", command: "make test" }]);
    expect(v.budget).toEqual({ max_iterations: 10, wall_clock_minutes: 60 });
  });

  it("rejects an empty goal", () => {
    expect(() => validateMissionInput({ ...ok, goal: "  " })).toThrow(/goal/);
  });

  it("rejects zero verifiers", () => {
    expect(() => validateMissionInput({ ...ok, verifiers: [] })).toThrow(/verifier/);
  });

  it("rejects a non-command verifier kind", () => {
    expect(() =>
      validateMissionInput({ ...ok, verifiers: [{ kind: "llm", command: "x" }] }),
    ).toThrow(/kind/);
  });

  it("rejects budget outside 1..200 iterations / 1..1440 minutes", () => {
    for (const budget of [
      { max_iterations: 0, wall_clock_minutes: 60 },
      { max_iterations: 201, wall_clock_minutes: 60 },
      { max_iterations: 10, wall_clock_minutes: 0 },
      { max_iterations: 10, wall_clock_minutes: 1441 },
    ]) {
      expect(() => validateMissionInput({ ...ok, budget })).toThrow(/budget/);
    }
  });

  it("accepts the budget boundaries themselves", () => {
    expect(() =>
      validateMissionInput({
        ...ok,
        budget: { max_iterations: 200, wall_clock_minutes: 1440 },
      }),
    ).not.toThrow();
    expect(() =>
      validateMissionInput({ ...ok, budget: { max_iterations: 1, wall_clock_minutes: 1 } }),
    ).not.toThrow();
  });
});
