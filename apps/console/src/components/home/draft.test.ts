import { describe, expect, it } from "vitest";

import {
  blankDraft,
  createDraftStore,
  draftHasContent,
  draftIsKept,
  draftPreview,
  restoreDrafts,
  serialiseDrafts,
  withoutSecrets,
  type Draft,
  type DraftStorage,
} from "./draft";
import type { ResourceRow } from "./session-options";

const image = (name: string) => new File(["x"], name, { type: "image/png" });

function draft(agentId: string, over: Partial<Draft> = {}): Draft {
  return { ...blankDraft(agentId), ...over };
}

/** A storage that behaves like a tab: a string store, and an image store that can be told to fail. */
function memoryStorage(opts: { imagesFail?: boolean; noImages?: boolean } = {}) {
  const strings = new Map<string, string>();
  const images = new Map<string, File[]>();
  const storage: DraftStorage = {
    session: {
      getItem: (k) => strings.get(k) ?? null,
      setItem: (k, v) => void strings.set(k, v),
      removeItem: (k) => void strings.delete(k),
    },
    images: opts.noImages
      ? null
      : {
          put: async (k, files) => void images.set(k, files),
          get: async (k) => {
            if (opts.imagesFail) throw new Error("no database");
            return images.get(k) ?? null;
          },
          remove: async (k) => void images.delete(k),
        },
  };
  return { storage, strings, images };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

const GITHUB: ResourceRow = {
  kind: "github",
  url: "https://github.com/lumen-hq/platform",
  token: "ghp_secret",
  checkout_type: "none",
  checkout_name: "",
  mount_path: "",
};
const ENV: ResourceRow = { kind: "env", name: "API_BASE_URL", value: "https://internal" };
const FILE: ResourceRow = { kind: "file", file_id: "file_1", mount_path: "" };

describe("what counts as a draft", () => {
  it("is the person's own words, images or options", () => {
    expect(draftHasContent(draft("a"))).toBe(false);
    expect(draftHasContent(draft("a", { text: "Summarise the queue" }))).toBe(true);
    expect(draftHasContent(draft("a", { text: "   " }))).toBe(false);
    expect(draftHasContent(draft("a", { files: [image("a.png")] }))).toBe(true);
    expect(draftHasContent(draft("a", { options: { ...blankDraft().options, title: "Refunds" } }))).toBe(true);
    expect(draftHasContent(draft("a", { options: { ...blankDraft().options, resources: [FILE] } }))).toBe(true);
    expect(draftHasContent(draft("a", { options: { ...blankDraft().options, vault_ids: [] } }))).toBe(true);
    expect(draftHasContent(draft("a", { options: { ...blankDraft().options, environment_id: "env-gpu" } }))).toBe(true);
    expect(draftHasContent(null)).toBe(false);
  });

  it("does not count a starter chip nobody typed over", () => {
    const chip = draft("a", { text: "Classify inbound support tickets", filledBy: "job-0" });
    expect(draftHasContent(chip)).toBe(false);
    // …but it is kept, so the box reopens the way it was left.
    expect(draftIsKept(chip)).toBe(true);
  });

  it("does not count the environment the starter was opened from", () => {
    const pinned = draft("a", { options: { ...blankDraft().options, environment_id: "env-gpu" } });
    expect(draftHasContent(pinned, "env-gpu")).toBe(false);
    expect(draftIsKept(pinned, "env-gpu")).toBe(false);
    expect(draftHasContent(pinned, "env-other")).toBe(true);
  });

  it("previews the first line, or the title when there are no words", () => {
    expect(draftPreview(draft("a", { text: "  Summarise the queue\nGroup by cause" }))).toBe("Summarise the queue");
    expect(draftPreview(draft("a", { options: { ...blankDraft().options, title: "Refunds" } }))).toBe("Refunds");
    expect(draftPreview(draft("a", { text: "x".repeat(100) }), 20)).toHaveLength(20);
    expect(draftPreview(draft("a"))).toBe("");
  });
});

describe("the draft store", () => {
  it("keeps one draft per agent and never mixes them", () => {
    const store = createDraftStore(memoryStorage().storage);
    store.save(draft("triage", { text: "Summarise refunds", files: [image("queue.png")] }));
    store.save(draft("reviewer", { text: "Review the billing PRs" }));
    expect(store.get("triage")?.text).toBe("Summarise refunds");
    expect(store.get("triage")?.files.map((f) => f.name)).toEqual(["queue.png"]);
    expect(store.get("reviewer")?.text).toBe("Review the billing PRs");
    expect(store.get("reviewer")?.files).toEqual([]);
    expect(store.get("nobody")).toBeNull();
  });

  it("opens on the draft touched last, and can skip one agent or drafts with nothing of the person's own", () => {
    let t = 100;
    const store = createDraftStore(memoryStorage().storage, () => (t += 1));
    store.save(draft("triage", { text: "Summarise refunds" }));
    store.save(draft("reviewer", { text: "Review the billing PRs" }));
    store.save(draft("monitor", { text: "Run nightly checks", filledBy: "job-0" }));
    expect(store.latest()?.agentId).toBe("monitor");
    expect(store.latest({ withContent: true })?.agentId).toBe("reviewer");
    expect(store.latest({ withContent: true, except: "reviewer" })?.agentId).toBe("triage");
    // Editing an older draft makes it the latest again.
    store.save(draft("triage", { text: "Summarise refunds, by cause" }));
    expect(store.latest()?.agentId).toBe("triage");
    // Saving it unchanged does not.
    store.save(draft("reviewer", { text: "Review the billing PRs" }));
    expect(store.latest()?.agentId).toBe("triage");
  });

  it("forgets a draft once nothing is left in it", () => {
    const { storage, strings } = memoryStorage();
    const store = createDraftStore(storage);
    store.save(draft("triage", { text: "Summarise refunds" }));
    expect(strings.size).toBe(1);
    store.save(draft("triage", { text: "" }));
    expect(store.get("triage")).toBeNull();
    expect(strings.size).toBe(0);
    // A starter opened from an environment and closed untouched leaves nothing behind.
    store.save(draft("triage", { options: { ...blankDraft().options, environment_id: "env-gpu" } }), { pinnedEnvironmentId: "env-gpu" });
    expect(store.get("triage")).toBeNull();
  });

  it("keeps the session a failed start already created, so it is not created twice", () => {
    const store = createDraftStore(memoryStorage().storage);
    const made = { key: "{}", id: "sess-1", uploads: new Map() };
    store.save(draft("triage", { text: "Summarise refunds", made, problem: { stage: "send", reason: "offline", sessionId: "sess-1" } }));
    expect(store.get("triage")?.made).toBe(made);
    expect(store.get("triage")?.problem?.stage).toBe("send");
  });

  it("remembers the agent chosen last even when the box is empty", () => {
    const { storage } = memoryStorage();
    const store = createDraftStore(storage);
    expect(store.recipient).toBeNull();
    store.setRecipient("reviewer");
    expect(createDraftStore(storage).recipient).toBe("reviewer");
  });

  it("tells listeners which draft changed and who changed it", () => {
    const store = createDraftStore(memoryStorage().storage);
    const seen: Array<[string, unknown]> = [];
    const stop = store.subscribe((agentId, source) => seen.push([agentId, source]));
    store.save(draft("triage", { text: "a" }), { source: "home" });
    store.save(draft("triage", { text: "a" }), { source: "home" }); // unchanged: silent
    store.remove("triage", "dialog");
    stop();
    store.save(draft("triage", { text: "b" }));
    expect(seen).toEqual([
      ["triage", "home"],
      ["triage", "dialog"],
    ]);
  });
});

describe("a reload", () => {
  it("brings back the words, the agent, the options and the images", async () => {
    const { storage } = memoryStorage();
    const before = createDraftStore(storage);
    before.save(
      draft("triage", {
        text: "Summarise refunds\nGroup by cause",
        files: [image("queue.png"), image("chart.png")],
        options: { environment_id: "env-gpu", vault_ids: ["vlt-1", "vlt-2"], title: "Refunds", resources: [FILE] },
        made: { key: "{}", id: "sess-1", uploads: new Map() },
      }),
    );
    await tick();

    const after = createDraftStore(storage);
    const first = after.get("triage");
    expect(first?.text).toBe("Summarise refunds\nGroup by cause");
    expect(first?.options).toEqual({ environment_id: "env-gpu", vault_ids: ["vlt-1", "vlt-2"], title: "Refunds", resources: [FILE] });
    expect(first?.made).toMatchObject({ key: "{}", id: "sess-1" });
    // Images are read back a moment later, and whoever shows the draft is told.
    const told: string[] = [];
    after.subscribe((agentId) => told.push(agentId));
    await tick();
    expect(after.get("triage")?.files.map((f) => f.name)).toEqual(["queue.png", "chart.png"]);
    expect(after.get("triage")?.lostFiles).toEqual([]);
    expect(told).toEqual(["triage"]);
  });

  it("never writes a secret to storage, and says how many it dropped", async () => {
    const { storage, strings } = memoryStorage();
    const before = createDraftStore(storage);
    before.save(draft("triage", { text: "x", options: { ...blankDraft().options, resources: [GITHUB, ENV, FILE] } }));
    const written = [...strings.values()].join("");
    expect(written).not.toContain("ghp_secret");
    expect(written).not.toContain("https://internal");
    expect(written).toContain("https://github.com/lumen-hq/platform");
    // In memory (dialog closed and reopened) the secrets are still there.
    expect(before.get("triage")?.options.resources[0]).toEqual(GITHUB);

    const after = createDraftStore(storage).get("triage");
    expect(after?.secretsDropped).toBe(2);
    expect(after?.options.resources).toEqual([{ ...GITHUB, token: "" }, { ...ENV, value: "" }, FILE]);
  });

  it("names the images it could not read back instead of dropping them silently", async () => {
    for (const opts of [{ imagesFail: true }, { noImages: true }]) {
      const { storage } = memoryStorage(opts);
      createDraftStore(storage).save(draft("triage", { text: "x", files: [image("queue.png")] }));
      await tick();
      const after = createDraftStore(storage);
      after.get("triage");
      await tick();
      expect(after.get("triage")?.files).toEqual([]);
      expect(after.get("triage")?.lostFiles).toEqual(["queue.png"]);
      expect(after.get("triage")?.text).toBe("x");
    }
  });

  it("does not put back images the person replaced while they were being read", async () => {
    const { storage } = memoryStorage();
    createDraftStore(storage).save(draft("triage", { text: "x", files: [image("old.png")] }));
    await tick();
    const after = createDraftStore(storage);
    const loaded = after.get("triage")!;
    after.save({ ...loaded, files: [image("new.png")] });
    await tick();
    expect(after.get("triage")?.files.map((f) => f.name)).toEqual(["new.png"]);
  });

  it("carries over the words kept by the earlier, text-only draft", () => {
    const { storage, strings } = memoryStorage();
    strings.set("muse:new-session:draft", "Half a sentence");
    const store = createDraftStore(storage);
    expect(store.latest()?.text).toBe("Half a sentence");
    expect(strings.has("muse:new-session:draft")).toBe(false);
  });

  it("ignores storage it cannot read", () => {
    expect(restoreDrafts("not json").drafts).toEqual([]);
    expect(restoreDrafts(JSON.stringify({ v: 1, drafts: {} })).drafts).toEqual([]);
    expect(restoreDrafts(null).drafts).toEqual([]);
    const odd = restoreDrafts(
      JSON.stringify({ v: 2, recipient: 7, drafts: { a: { text: 5, options: { resources: [{ kind: "nope" }, FILE], vault_ids: "x" } } } }),
    );
    expect(odd.recipient).toBeNull();
    expect(odd.drafts[0]).toMatchObject({ agentId: "a", text: "", options: { vault_ids: null, resources: [FILE] } });
  });

  it("round-trips through its own format", () => {
    const d = draft("triage", { text: "x", filledBy: "job-1", files: [image("a.png")], touchedAt: 5 });
    const back = restoreDrafts(serialiseDrafts([d], "triage"));
    expect(back.recipient).toBe("triage");
    expect(back.drafts[0]).toMatchObject({ agentId: "triage", text: "x", filledBy: "job-1", pendingFiles: ["a.png"], touchedAt: 5 });
    expect(withoutSecrets([FILE])).toEqual({ rows: [FILE], dropped: 0 });
  });
});
