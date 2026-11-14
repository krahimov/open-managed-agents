import { describe, expect, it } from "vitest";

import { ApiError } from "./api";
import { failureSentence, withReason } from "./failure-text";

const api = (message: string, status: number) => new ApiError({ code: "", message, status });

describe("failureSentence", () => {
  it("never shows a bare server token", () => {
    expect(failureSentence(api("unavailable", 500))).toBe("The server had a problem (“unavailable”). Try again in a moment.");
    expect(failureSentence(api("internal_error", 502))).toBe("The server had a problem (“internal_error”). Try again in a moment.");
    expect(failureSentence(api("Bad Gateway", 502))).toBe("The server had a problem (“Bad Gateway”). Try again in a moment.");
    expect(failureSentence(api("Internal Server Error", 500))).toBe("The server had a problem (“Internal Server Error”). Try again in a moment.");
    expect(failureSentence(api("upstream unavailable", 503))).toBe("The server had a problem (“upstream unavailable”). Try again in a moment.");
    expect(failureSentence(api("HTTP 500", 500))).toBe("The server had a problem. Try again in a moment.");
    expect(failureSentence(api("forbidden", 403))).toBe("You do not have access to that (“forbidden”).");
    expect(failureSentence(api("invalid", 422))).toBe("The request was refused (“invalid”).");
    expect(failureSentence(api("Not Found", 404))).toBe("That could not be found. It may have been deleted.");
    expect(failureSentence(api("rate_limited", 429))).toBe("Too many requests at once. Wait a moment and try again.");
  });

  it("keeps a server sentence in the server's words, with a capital and a full stop", () => {
    expect(failureSentence(api("Insufficient balance to start a session.", 402))).toBe("Insufficient balance to start a session.");
    expect(failureSentence(api("Insufficient balance.", 402))).toBe("Insufficient balance.");
    expect(failureSentence(api("vault is archived and cannot be changed", 409))).toBe("Vault is archived and cannot be changed.");
  });

  it("reads a request that never arrived as a connection problem", () => {
    const unreachable = "The server could not be reached. Check your connection and try again.";
    expect(failureSentence(new TypeError("Failed to fetch"))).toBe(unreachable);
    expect(failureSentence(new TypeError("Load failed"))).toBe(unreachable);
    expect(failureSentence(new Error("NetworkError when attempting to fetch resource."))).toBe(unreachable);
  });

  it("has something to say when it is given nothing", () => {
    expect(failureSentence(undefined)).toBe("Something went wrong.");
    expect(failureSentence(new Error("boom"))).toBe("Something went wrong (“boom”).");
  });
});

describe("withReason", () => {
  it("puts a full stop between our sentence and the reason", () => {
    expect(withReason("The rubric could not be drafted", new TypeError("Failed to fetch"))).toBe(
      "The rubric could not be drafted. The server could not be reached. Check your connection and try again.",
    );
    expect(withReason("It was not saved.", api("unavailable", 503))).toBe(
      "It was not saved. The server had a problem (“unavailable”). Try again in a moment.",
    );
  });
});
