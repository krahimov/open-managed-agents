import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";
import { verifyTelegramInitData } from "../src/lib/telegram-onboarding.js";

const now = 1788900000000;
function sign(entries: Record<string, string>, token = "test-token") {
  const params = new URLSearchParams(entries);
  const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
  const key = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", key).update(check).digest("hex"));
  return params.toString();
}
const fields = { auth_date: String(now / 1000), query_id: "query", user: JSON.stringify({ id: 101, first_name: "Test" }) };
describe("Telegram signed launch verification", () => {
  it("accepts authentic fresh data including Telegram's additional signature field", () => {
    expect(verifyTelegramInitData(sign(fields), "test-token", now)).toBe("101");
    expect(verifyTelegramInitData(sign({ ...fields, signature: "additional-signature" }), "test-token", now)).toBe("101");
  });
  it("rejects another bot, altered user, duplicates, missing hash and oversized input", () => {
    const raw = sign(fields);
    expect(verifyTelegramInitData(raw, "another-bot", now)).toBeNull();
    expect(verifyTelegramInitData(raw.replace("101", "102"), "test-token", now)).toBeNull();
    expect(verifyTelegramInitData(`${raw}&user=101`, "test-token", now)).toBeNull();
    expect(verifyTelegramInitData(new URLSearchParams(fields).toString(), "test-token", now)).toBeNull();
    expect(verifyTelegramInitData("x".repeat(16385), "test-token", now)).toBeNull();
  });
  it.each(["0", "no-date", "1788899099", "1788900031"])("rejects invalid or stale date %s", auth_date => {
    expect(verifyTelegramInitData(sign({ ...fields, auth_date }), "test-token", now)).toBeNull();
  });
  it.each(["null", "broken-json", '{"id":-1}', '{"id":"101"}', '{"id":101,"is_bot":true}'])("rejects invalid users %s", user => {
    expect(verifyTelegramInitData(sign({ ...fields, user }), "test-token", now)).toBeNull();
  });
});
