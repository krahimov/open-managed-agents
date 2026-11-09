import { afterEach, describe, expect, it, vi } from "vitest";
import { probeModelCard } from "../src/lib/model-card-probe";

// Live 2026-11-09: creating gpt-6.1-sol / gpt-6-astra cards with a working
// key toasted "the key didn't work" — the 1-token probe 400s on reasoning
// models because they spend the budget thinking.

const card = { provider: "oai", model: "gpt-6.1-sol", apiKey: "sk-test", baseUrl: null, customHeaders: null };
const reply = (status: number, message: string) =>
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message } }), { status })));

afterEach(() => vi.unstubAllGlobals());

describe("probeModelCard", () => {
  it("passes a reasoning model that ran out of output tokens", async () => {
    reply(400, "Could not finish the message because max_tokens or model output limit was reached. Please try again with higher max_tokens.");
    expect(await probeModelCard(card)).toEqual({ ok: true });
  });

  it("still fails a rejected key", async () => {
    reply(401, "Incorrect API key provided");
    expect(await probeModelCard(card)).toMatchObject({ ok: false, message: expect.stringContaining("401") });
  });

  it("still fails other bad requests", async () => {
    reply(400, "The model `gpt-nope` does not exist");
    expect(await probeModelCard(card)).toMatchObject({ ok: false });
  });
});
