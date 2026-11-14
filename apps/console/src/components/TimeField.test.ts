import { describe, expect, it } from "vitest";

import { readTime } from "./TimeField";

describe("readTime", () => {
  it("reads the ways people write a time of day", () => {
    expect(readTime("09:00")).toBe("09:00");
    expect(readTime("9")).toBe("09:00");
    expect(readTime("9:5")).toBe("09:05");
    expect(readTime("0930")).toBe("09:30");
    expect(readTime("930")).toBe("09:30");
    expect(readTime("9.30")).toBe("09:30");
    expect(readTime("17h45")).toBe("17:45");
    expect(readTime(" 23:59 ")).toBe("23:59");
  });

  it("understands am and pm", () => {
    expect(readTime("9pm")).toBe("21:00");
    expect(readTime("9:30 PM")).toBe("21:30");
    expect(readTime("12am")).toBe("00:00");
    expect(readTime("12 pm")).toBe("12:00");
  });

  it("refuses what is not a time", () => {
    expect(readTime("")).toBeNull();
    expect(readTime("noon")).toBeNull();
    expect(readTime("24:00")).toBeNull();
    expect(readTime("12:60")).toBeNull();
    expect(readTime("13pm")).toBeNull();
    expect(readTime("1234567")).toBeNull();
  });
});
