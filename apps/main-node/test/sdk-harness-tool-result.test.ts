import { describe, expect, it } from "vitest";
import { contentOfToolResult } from "../src/lib/claude-agent-sdk-harness.js";

describe("claude-agent-sdk tool results", () => {
  const png = "iVBORw0KGgo=";

  it("stay plain text when there is no picture", () => {
    expect(contentOfToolResult("ok")).toBe("ok");
    expect(contentOfToolResult([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toBe("a\nb");
  });

  it("keep the pictures a tool returned, in either form, beside their text", () => {
    expect(
      contentOfToolResult([
        { type: "text", text: "1280x800" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
        { type: "image", data: png, mimeType: "image/jpeg" },
      ]),
    ).toEqual([
      { type: "text", text: "1280x800" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: png } },
    ]);
    expect(contentOfToolResult([{ type: "image", source: { type: "base64", media_type: "image/png", data: png } }])).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
    ]);
  });

  it("drop an image block with nothing in it", () => {
    expect(contentOfToolResult([{ type: "text", text: "x" }, { type: "image", source: { type: "url", url: "https://x" } }])).toBe("x");
  });
});
