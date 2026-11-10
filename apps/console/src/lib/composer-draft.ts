import { useCallback } from "react";

/**
 * Unsent composer text that survives a reload. The composers keep their
 * text only in the DOM / React state, so reloading for a new deploy would
 * silently drop a half-written message. Composers tag their textarea with
 * `data-draft-key`; right before an app-initiated reload `stashDrafts()`
 * copies every non-empty one into sessionStorage (per tab), and the
 * composer's ref restores — and removes — its draft when it mounts again.
 */

export const DRAFT_ATTR = "data-draft-key";
export const DRAFT_PREFIX = "oma-draft:";

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** `win.sessionStorage`, or null when it's missing or access throws. */
export function sessionStoreOf(win: { sessionStorage?: Storage } = globalThis): DraftStorage | null {
  try {
    return win.sessionStorage ?? null;
  } catch {
    return null;
  }
}

const sessionStore = () => sessionStoreOf();

/** Every tagged composer that holds unsent text. */
export function collectDrafts(root: ParentNode = document): Array<{ key: string; text: string }> {
  const out: Array<{ key: string; text: string }> = [];
  for (const el of root.querySelectorAll<HTMLTextAreaElement>(`textarea[${DRAFT_ATTR}]`)) {
    const key = el.getAttribute(DRAFT_ATTR);
    if (key && el.value.trim()) out.push({ key, text: el.value });
  }
  return out;
}

/**
 * Saves unsent composer text so it survives a reload. Returns false only
 * when there is text that could not be saved (storage missing or full),
 * so the caller can ask before throwing it away.
 */
export function stashDrafts(
  root: ParentNode = document,
  store: DraftStorage | null = sessionStore(),
): boolean {
  const drafts = collectDrafts(root);
  if (drafts.length === 0) return true;
  if (!store) return false;
  try {
    for (const d of drafts) store.setItem(DRAFT_PREFIX + d.key, d.text);
    return true;
  } catch {
    return false;
  }
}

/** Reads and removes the stashed draft for `key`. */
export function takeDraft(key: string, store: DraftStorage | null = sessionStore()): string | null {
  if (!store) return null;
  try {
    const text = store.getItem(DRAFT_PREFIX + key);
    if (text != null) store.removeItem(DRAFT_PREFIX + key);
    return text;
  } catch {
    return null;
  }
}

/**
 * Wires a composer textarea into draft stash/restore. Spread the result
 * onto the textarea: `ref` restores a stashed draft when it mounts (and
 * calls `onRestore` so mirrored state can follow), `data-draft-key` marks
 * it for `stashDrafts()`. `onRestore` should be stable (e.g. a setState).
 */
export function useComposerDraft(key: string | undefined, onRestore?: (text: string) => void) {
  const ref = useCallback(
    (el: HTMLTextAreaElement | null) => {
      if (!el || !key) return;
      const text = takeDraft(key);
      if (text == null) return;
      el.value = text;
      onRestore?.(text);
    },
    [key, onRestore],
  );
  return { ref, [DRAFT_ATTR]: key } as { ref: typeof ref; "data-draft-key": string | undefined };
}
