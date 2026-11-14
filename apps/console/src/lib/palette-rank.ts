/**
 * Ranking for the command palette.
 *
 * The palette used to hand every row's whole search string to a fuzzy
 * matcher, so a query was scored against names, keywords, descriptions and
 * ids alike: "triage" put Operations first (its letters happen to appear,
 * in order, across its keywords) and the agent called Support Triage third.
 *
 * Here a match is read the way a person reads it. What you typed is looked
 * for in the NAME first, and how it sits in the name decides the tier:
 *
 *   0  the name is exactly the query            "sessions"     → Sessions
 *   1  the name starts with it                  "tri"          → Triage: SSO login loop…
 *   2  every word of it starts a word of the    "tri"          → Support Triage
 *      name                                     "sup tri"      → Support Triage
 *   3  every word of it appears in the name     "port"         → Support Triage
 *   4  every word of it starts a word of the    "billing"      → Usage (a keyword)
 *      name, keywords or description
 *   5  every word of it appears somewhere in    "pagerduty"    → an agent whose description says so
 *      those
 *   6  it is part of the id                     "5ahomh"       → agent-5ahomh6eio9nv0uv
 *
 * Results are ordered by tier across every kind of row, then by `weight`
 * (pages before agents before sessions), then by the order they came in
 * (sessions arrive newest first). Tiers 0–3 are name matches.
 *
 * One rule sits above the tiers. A workspace has a handful of agents,
 * environments and pages, each named on purpose, and hundreds of sessions,
 * each titled from whatever was asked. So among name matches the named
 * things come first and the sessions (`many`) follow, however the query
 * sits in a title: "triage" opens on the agent Support Triage, then the
 * sessions called "Triage: …". Only a session whose title IS the query
 * (tier 0) stays level with everything else.
 *
 * `matchRanges` says which part of a text the query matched, so a row can
 * show WHY it is in the list: the words are set in bold in its name, or in
 * the keyword, description or id it was found by.
 */

export interface Rankable {
  /** What the row is called on screen. */
  name: string;
  /** Keywords, descriptions, the kind of thing: matched after names. */
  more?: string;
  /** Matched last, and only by a query that looks like part of an id. */
  id?: string;
  /** Tie-break within a tier: lower first. */
  weight?: number;
  /** A kind there are very many of (sessions). Its name matches follow every other kind's. */
  many?: boolean;
}

export interface Ranked<T> {
  item: T;
  tier: number;
}

/** Highest tier that still counts as "the name matches". */
export const NAME_TIER = 3;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");

const words = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

/** The tier `query` reaches on `item`, or null when it does not match. */
export function matchTier(query: string, item: Rankable): number | null {
  const q = fold(query).trim().replace(/\s+/g, " ");
  if (!q) return null;
  const tokens = words(q);
  const name = fold(item.name).trim();

  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (tokens.length > 0) {
    const nameWords = words(item.name);
    if (tokens.every((t) => nameWords.some((w) => w.startsWith(t)))) return 2;
    if (tokens.every((t) => name.includes(t))) return 3;
    if (item.more) {
      const all = `${name} ${fold(item.more)}`;
      const allWords = [...nameWords, ...words(item.more)];
      if (tokens.every((t) => allWords.some((w) => w.startsWith(t)))) return 4;
      if (tokens.every((t) => all.includes(t))) return 5;
    }
  }
  // An id is matched as typed (ids carry "-" and "_"), and only by a query
  // long enough to mean one: "sess" alone should not list every session.
  if (item.id && q.length >= 5 && !q.includes(" ") && fold(item.id).includes(q)) return 6;
  return null;
}

/**
 * Where a result sits before its tier is looked at: an exact name, then
 * names of the few named things, then names of the many, then the rest.
 */
function band(tier: number, item: Rankable): number {
  if (tier === 0) return 0;
  if (tier <= NAME_TIER) return item.many ? 2 : 1;
  return 3;
}

/** Every item that matches, best first. An empty query matches nothing. */
export function rank<T extends Rankable>(query: string, items: readonly T[]): Ranked<T>[] {
  const out: Array<Ranked<T> & { index: number }> = [];
  items.forEach((item, index) => {
    const tier = matchTier(query, item);
    if (tier !== null) out.push({ item, tier, index });
  });
  out.sort(
    (a, b) =>
      band(a.tier, a.item) - band(b.tier, b.item) ||
      a.tier - b.tier ||
      (a.item.weight ?? 0) - (b.item.weight ?? 0) ||
      a.index - b.index,
  );
  return out.map(({ item, tier }) => ({ item, tier }));
}

/** A half-open stretch of a string: [start, end). */
export type Range = [start: number, end: number];

/** `text` folded the way matching folds it, with each folded character's place in the original. */
function foldWithMap(text: string): { folded: string; at: number[] } {
  let folded = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const f = fold(text[i]);
    for (let k = 0; k < f.length; k++) at.push(i);
    folded += f;
  }
  return { folded, at };
}

const isWordChar = (c: string | undefined) => !!c && /[a-z0-9]/.test(c);

/**
 * The parts of `text` that `query` matched, for setting in bold. Each word
 * of the query marks its first appearance, at the start of a word when
 * there is one. An id-like query (with "-" or "_") is looked for as typed.
 * Ranges are in the original string, sorted, never overlapping.
 */
export function matchRanges(query: string, text: string): Range[] {
  const q = fold(query).trim();
  if (!q || !text) return [];
  const { folded, at } = foldWithMap(text);
  const found: Range[] = [];
  const mark = (needle: string) => {
    if (!needle) return;
    let from = 0;
    let anywhere = -1;
    for (;;) {
      const i = folded.indexOf(needle, from);
      if (i === -1) break;
      if (anywhere === -1) anywhere = i;
      if (!isWordChar(folded[i - 1])) {
        anywhere = i;
        break;
      }
      from = i + 1;
    }
    if (anywhere === -1) return;
    found.push([at[anywhere], at[anywhere + needle.length - 1] + 1]);
  };
  const whole = folded.indexOf(q);
  if (whole !== -1 && /[^a-z0-9\s]/.test(q)) found.push([at[whole], at[whole + q.length - 1] + 1]);
  else for (const token of words(q)) mark(token);

  found.sort((a, b) => a[0] - b[0]);
  const merged: Range[] = [];
  for (const r of found) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged;
}

/** The words of `query` that `text` does not hold: what a row still has to explain. */
export function unmatchedWords(query: string, text: string): string[] {
  const hay = fold(text);
  return words(query).filter((t) => !hay.includes(t));
}
