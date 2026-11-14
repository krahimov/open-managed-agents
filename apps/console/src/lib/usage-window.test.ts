import { describe, expect, it } from "vitest";

import { usageWindow, utcDayKey } from "./usage-window";

const DAY = 86_400_000;

describe("usageWindow", () => {
  // 2026-11-10T19:22:41Z, mid-afternoon UTC.
  const now = Date.UTC(2026, 10, 10, 19, 22, 41);

  it("covers whole UTC days, today included", () => {
    const win = usageWindow(30, now);
    expect(new Date(win.until).toISOString()).toBe("2026-11-11T00:00:00.000Z");
    expect(new Date(win.since).toISOString()).toBe("2026-10-12T00:00:00.000Z");
    expect(win.dayKeys).toHaveLength(30);
    expect(win.dayKeys[0]).toBe("2026-10-12");
    expect(win.dayKeys[29]).toBe("2026-11-10");
  });

  it("is the same window whenever it is asked for during one day", () => {
    const morning = usageWindow(30, Date.UTC(2026, 10, 10, 0, 0, 0));
    const night = usageWindow(30, Date.UTC(2026, 10, 10, 23, 59, 59));
    expect(night.params).toEqual(morning.params);
    expect(night.previousParams).toEqual(morning.previousParams);
  });

  it("compares like with like: the period before is the same length and ends where this one starts", () => {
    for (const days of [7, 30, 90]) {
      const win = usageWindow(days, now);
      expect(win.until - win.since).toBe(days * DAY);
      expect(win.previous.until).toBe(win.since);
      expect(win.previous.until - win.previous.since).toBe(days * DAY);
      expect(win.previousParams).toEqual({ since: String(win.since - days * DAY), until: String(win.since) });
    }
  });

  it("keeps 24 hours rolling, to the minute", () => {
    const win = usageWindow(1, now);
    expect(new Date(win.until).toISOString()).toBe("2026-11-10T19:23:00.000Z");
    expect(win.until - win.since).toBe(DAY);
    expect(win.dayKeys).toEqual(["2026-11-09", "2026-11-10"]);
  });

  it("names a day the way the report does", () => {
    expect(utcDayKey("2026-11-06T23:41:00.000Z")).toBe("2026-11-06");
    expect(utcDayKey(now)).toBe("2026-11-10");
  });
});
