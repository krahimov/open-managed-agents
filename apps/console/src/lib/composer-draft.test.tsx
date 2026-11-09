import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { DRAFT_PREFIX, collectDrafts, stashDrafts, takeDraft, useComposerDraft } from "./composer-draft";
import { reloadKeepingDrafts } from "./update-prompt";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
    data,
  };
}

function composers(values: Record<string, string>) {
  const root = document.createElement("div");
  for (const [key, value] of Object.entries(values)) {
    const ta = document.createElement("textarea");
    ta.setAttribute("data-draft-key", key);
    ta.value = value;
    root.appendChild(ta);
  }
  const untagged = document.createElement("textarea");
  untagged.value = "not a composer";
  root.appendChild(untagged);
  return root;
}

afterEach(() => sessionStorage.clear());

describe("stashDrafts / takeDraft", () => {
  it("stashes only tagged, non-empty composers", () => {
    const root = composers({ "session:a": "half a thought", "session:b": "   " });
    expect(collectDrafts(root)).toEqual([{ key: "session:a", text: "half a thought" }]);
    const store = memoryStorage();
    expect(stashDrafts(root, store)).toBe(true);
    expect([...store.data.entries()]).toEqual([[`${DRAFT_PREFIX}session:a`, "half a thought"]]);
  });

  it("reports text it could not keep", () => {
    const root = composers({ "session:a": "hello" });
    expect(stashDrafts(root, null)).toBe(false);
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(stashDrafts(root, full)).toBe(false);
    // Nothing typed → nothing to lose.
    expect(stashDrafts(composers({}), null)).toBe(true);
  });

  it("takeDraft reads once", () => {
    const store = memoryStorage({ [`${DRAFT_PREFIX}session:a`]: "hello" });
    expect(takeDraft("session:a", store)).toBe("hello");
    expect(takeDraft("session:a", store)).toBeNull();
  });
});

describe("useComposerDraft", () => {
  function Composer({ id, onRestore }: { id: string; onRestore?: (t: string) => void }) {
    const draft = useComposerDraft(`session:${id}`, onRestore);
    return <textarea aria-label="composer" {...draft} />;
  }

  it("restores and clears the stashed draft on mount", () => {
    sessionStorage.setItem(`${DRAFT_PREFIX}session:s1`, "unsent message");
    const onRestore = vi.fn();
    const { getByLabelText } = render(<Composer id="s1" onRestore={onRestore} />);
    const ta = getByLabelText("composer") as HTMLTextAreaElement;
    expect(ta.value).toBe("unsent message");
    expect(ta.getAttribute("data-draft-key")).toBe("session:s1");
    expect(onRestore).toHaveBeenCalledWith("unsent message");
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}session:s1`)).toBeNull();
  });

  it("leaves other sessions' drafts alone", () => {
    sessionStorage.setItem(`${DRAFT_PREFIX}session:other`, "x");
    const { getByLabelText } = render(<Composer id="s1" />);
    expect((getByLabelText("composer") as HTMLTextAreaElement).value).toBe("");
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}session:other`)).toBe("x");
  });
});

describe("reloadKeepingDrafts", () => {
  function fakeWindow(doc: Document, confirmResult: boolean, storage: unknown = sessionStorage) {
    const reload = vi.fn();
    const confirm = vi.fn(() => confirmResult);
    const win = { document: doc, confirm, location: { reload }, sessionStorage: storage } as unknown as Window;
    return { win, reload, confirm };
  }

  it("stashes the composer text, then reloads without asking", () => {
    const doc = document.implementation.createHTMLDocument("t");
    doc.body.appendChild(composers({ "session:s1": "keep me" }));
    const { win, reload, confirm } = fakeWindow(doc, false);
    expect(reloadKeepingDrafts(win)).toBe(true);
    expect(sessionStorage.getItem(`${DRAFT_PREFIX}session:s1`)).toBe("keep me");
    expect(confirm).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("asks before reloading when the text can't be kept", () => {
    const doc = document.implementation.createHTMLDocument("t");
    doc.body.appendChild(composers({ "session:s1": "keep me" }));
    const full = {
      ...memoryStorage(),
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    const stay = fakeWindow(doc, false, full);
    expect(reloadKeepingDrafts(stay.win)).toBe(false);
    expect(stay.confirm).toHaveBeenCalledTimes(1);
    expect(stay.reload).not.toHaveBeenCalled();
    const go = fakeWindow(doc, true, full);
    expect(reloadKeepingDrafts(go.win)).toBe(true);
    expect(go.reload).toHaveBeenCalledTimes(1);
  });
});
