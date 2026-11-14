/**
 * Task starters: three or four things a person could ask the selected agent,
 * offered under the composer. They are read from what the workspace already
 * knows about the agent, in the browser, with no model call:
 *
 *   job       what the agent is for, turned into an ask. "Classifies inbound
 *             support tickets, matches known issues, and drafts first replies."
 *             gives "Classify inbound support tickets", "Match known issues"
 *             and "Draft first replies". When there is no description, the
 *             opening line of its instructions ("You review pull requests…").
 *   trigger   what one of its schedules asks it every time it fires.
 *   recent    something it was asked before, as something to ask now. A
 *             past session's title is never shown as it stands: "Nightly DQ
 *             check — Nov 4" is an old title with a date, not an ask. A
 *             title that is already an ask is kept without its date
 *             ("Flag duplicate vendor invoices — September" asks to "Flag
 *             duplicate vendor invoices"); a recurring job is asked for
 *             ("Run the nightly DQ check"); a title that names a kind of
 *             work and then one case of it becomes a new piece of that
 *             work with the case left open: the chip asks it whole ("Call
 *             summary — Initech discovery" gives "New call summary…",
 *             "Review PR #1842" gives "Review a PR…", "Triage: SSO login
 *             loop (ACME-4821)" gives "Triage a ticket…") and the composer
 *             gets the work's own words to finish ("Call summary — ",
 *             "Review PR #", "Triage: "). Anything else is left out.
 *
 * Clicking a starter fills the composer. It never sends.
 *
 * The reading is deliberately strict. A clause becomes an ask only when it
 * opens with a verb this file knows, so "Posting requires approval" or
 * "Sales assistant for EMEA" are never bent into nonsense: they are left
 * out and another source fills the row.
 */

export type StarterKind = "job" | "trigger" | "recent";

export interface Starter {
  key: string;
  kind: StarterKind;
  /** What the chip says: short enough to read at a glance. */
  label: string;
  /** What clicking puts in the composer: the whole ask. */
  text: string;
  /** Where it came from, for the tooltip. */
  hint: string;
}

export interface StarterAgent {
  id: string;
  name: string;
  description?: string | null;
  system?: string | null;
}

export interface StarterRule {
  id: string;
  name: string;
  enabled?: boolean;
  trigger?: { source?: string; config?: Record<string, unknown> | null } | null;
}

export interface StarterSession {
  id: string;
  title?: string | null;
  created_at: string;
  updated_at?: string | null;
  agent?: { id?: string } | null;
  metadata?: Record<string, unknown> | null;
}

/** A chip holds about this many characters before it is shortened. */
export const STARTER_LABEL_MAX = 44;

// Verbs that open a description of what an agent does. Base form.
const VERBS = new Set(
  `add alert analyse analyze answer apply approve archive assemble assess assign audit automate backfill benchmark book
   build calculate capture catch categorise categorize check clarify classify clean close cluster collect compare compile
   compose compute condense confirm convert coordinate correlate create critique curate debug decide deduplicate define
   deliver deploy describe design detect diagnose diff digest dispatch document draft edit enrich escalate estimate
   evaluate examine explain explore export extract fetch file fill filter find fix flag follow forecast format gather
   generate grade group guide handle help identify import index ingest inspect interview investigate keep label lint list
   log look maintain make manage map match measure merge migrate mine moderate monitor negotiate notify onboard open
   optimise optimize organise organize outline package parse patch pick plan post prepare prioritise prioritize process
   produce profile propose prospect provide publish pull qualify query rank read rebuild recommend reconcile record
   refactor refine remind renew repair reply report research resolve respond review rewrite route run scan schedule score
   scope scrape screen search segment send set ship simulate sort source spot stage suggest summarise summarize support
   surface sweep sync tag test tidy trace track transcribe transform translate triage troubleshoot turn update upgrade
   validate verify vet watch write`
    .split(/\s+/)
    .filter(Boolean),
);

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const capitalise = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const firstWord = (s: string) => /^[A-Za-z][A-Za-z'-]*/.exec(s)?.[0] ?? "";

/** "classifies" → "classify", "matches" → "match", "summarizes" → "summarize". Null when it is not a verb we know. */
function baseOfThirdPerson(word: string): string | null {
  const w = word.toLowerCase();
  if (!w.endsWith("s") || w.endsWith("ss")) return null;
  const candidates: string[] = [];
  if (w.endsWith("ies")) candidates.push(`${w.slice(0, -3)}y`);
  if (w.endsWith("es")) candidates.push(w.slice(0, -2));
  candidates.push(w.slice(0, -1));
  return candidates.find((c) => VERBS.has(c)) ?? null;
}

// How often a recurring job happens. "Nightly checks on warehouse tables"
// names a job by its schedule; asked by hand it is "Run nightly checks…".
const CADENCE = new Set(["nightly", "daily", "hourly", "weekly", "monthly", "quarterly", "regular", "scheduled", "periodic", "continuous"]);

/** A clause that opens with a verb, as an instruction: "Reviews pull requests" → "Review pull requests". */
function toAsk(clause: string): string | null {
  const text = clean(clause).replace(/[.;,:]+$/, "");
  const word = firstWord(text);
  if (!word) return null;
  const rest = text.slice(word.length);
  // Already an instruction ("Summarize sales calls…").
  if (VERBS.has(word.toLowerCase())) return capitalise(word.toLowerCase()) + rest;
  const base = baseOfThirdPerson(word);
  if (base) return capitalise(base) + rest;
  // "Nightly checks on…": a cadence, then the work as a noun we know as a verb.
  if (CADENCE.has(word.toLowerCase()) && baseOfThirdPerson(firstWord(rest.trimStart()))) {
    return `Run ${word.toLowerCase()}${rest}`;
  }
  return null;
}

/**
 * Split one sentence where a new verb starts: "Classifies tickets, matches
 * known issues, and drafts replies" is three clauses, while "Reviews pull
 * requests for correctness, edge cases and test coverage" stays whole
 * because "edge" and "test" do not open a new action.
 */
function clauses(sentence: string): string[] {
  const parts = sentence.split(/(,\s+and\s+|,\s+|\s+and\s+)/);
  const out: string[] = [];
  let current = parts[0] ?? "";
  for (let i = 1; i < parts.length; i += 2) {
    const piece = parts[i + 1] ?? "";
    if (baseOfThirdPerson(firstWord(piece))) {
      out.push(current);
      current = piece;
    } else {
      current += parts[i] + piece;
    }
  }
  out.push(current);
  return out;
}

/** What the description says the agent does, as asks, in the order it says them. */
export function asksFromDescription(description: string | null | undefined): string[] {
  const text = clean(description ?? "").replace(/^(this agent|the agent|an agent that|agent that|it)\s+/i, "");
  if (!text) return [];
  const out: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|;\s+/)) {
    // "Runs incident response: triage, comms cadence…" → the part before the list.
    const colon = sentence.indexOf(": ");
    const head = colon > 0 && sentence.slice(0, colon).split(" ").length >= 3 ? sentence.slice(0, colon) : sentence;
    for (const clause of clauses(head)) {
      const ask = toAsk(clause);
      if (ask && ask.split(" ").length >= 2) out.push(ask);
    }
  }
  return out;
}

/** The job as the instructions open with it: "You review pull requests for the platform monorepo." */
export function askFromInstructions(system: string | null | undefined): string | null {
  const text = clean(system ?? "");
  if (!text) return null;
  for (const sentence of text.split(/(?<=[.!?])\s+/).slice(0, 2)) {
    const you = /^you\s+(.+)$/i.exec(sentence);
    const body = you ? you[1] : sentence;
    const word = firstWord(body).toLowerCase();
    // Only a plain statement of the job: "You are…", "You must…", "Never…" are not asks.
    if (!VERBS.has(word)) continue;
    const colon = body.indexOf(": ");
    const head = (colon > 0 ? body.slice(0, colon) : body).replace(/[.;,:]+$/, "");
    if (head.split(" ").length < 3) continue;
    return capitalise(word) + head.slice(word.length);
  }
  return null;
}

// A phrase that opens with one of these adds detail to an ask without
// changing what is asked, so a chip can stop before it. ("into", "to" and
// "from" are not here: "Turn pull requests into release notes" needs its end.)
const DETAIL = /\s(?:for|on|with|against|by|using|across|about|within|per|via)\s/g;

/**
 * Shorten for a chip so that what is left still reads whole: drop a trailing
 * "(…)", then a " — tail", then a closing phrase of detail ("… for
 * correctness, edge cases and test coverage"). Only when none of that fits
 * is the text cut at a word with an ellipsis. The composer always gets the
 * full text.
 */
export function shortLabel(text: string, max = STARTER_LABEL_MAX): string {
  let s = clean(text).replace(/[.]+$/, "");
  if (s.length <= max) return s;
  const noParen = s.replace(/\s*\([^()]*\)\s*$/, "");
  if (noParen.length >= 12 && noParen.length < s.length) s = noParen;
  if (s.length <= max) return s;
  const dash = Math.max(s.lastIndexOf(" — "), s.lastIndexOf(" – "), s.lastIndexOf(" - "));
  if (dash >= 12 && dash <= max) return s.slice(0, dash);
  let head = "";
  for (const m of s.matchAll(DETAIL)) {
    const at = m.index ?? 0;
    if (at > max) break;
    if (at >= 16 && s.slice(0, at).split(" ").length >= 3) head = s.slice(0, at);
  }
  if (head) return head.replace(/[\s,;:]+$/, "");
  // A second action joined on ("… queue and triage anything older…"): the
  // first one, whole, says what is asked; the ellipsis says there is more.
  let first = "";
  for (const m of s.matchAll(/(?:,\s|\s(?:and|then|or)\s)/g)) {
    const at = m.index ?? 0;
    if (at > max - 1) break;
    if (s.slice(0, at).split(" ").length >= 3) first = s.slice(0, at);
  }
  if (first) return `${first.replace(/[\s,;:]+$/, "")}…`;
  const cut = s.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  // Never end on a word that leads somewhere ("… and", "… of the").
  const words = (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:—–-]+$/, "").split(" ");
  while (words.length > 2 && DANGLING.has(words[words.length - 1].toLowerCase())) words.pop();
  return `${words.join(" ").replace(/[\s,;:—–-]+$/, "")}…`;
}

const DANGLING = new Set(["a", "an", "the", "and", "or", "but", "then", "to", "of", "in", "on", "for", "with", "by", "at", "from", "into", "as", "that", "which", "its", "their", "our", "your"]);

const MONTHS = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/g;

/** The words that carry a starter's meaning, for telling two of them apart. */
function signature(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/\([^()]*\)/g, " ")
      .replace(MONTHS, " ")
      .replace(/[^a-z\s]/g, " ")
      .split(/\s+/)
      // "plans" and "plan", "invoices" and "invoice" are one word here.
      .map((w) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w))
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
const STOP = new Set(["the", "and", "for", "with", "from", "into", "that", "this", "its", "any", "all", "new", "run", "now"]);

/**
 * Do two starters say the same thing? Yes when at least two of their words
 * are shared and those make up half of the shorter one: "Reconcile Stripe
 * payouts against the ledger" and "Reconcile October Stripe payouts vs.
 * ledger" are one ask; "Review pull requests" and "Review PR #1842" are not.
 */
function alike(a: Set<string>, b: Set<string>): boolean {
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared >= 2 && shared / Math.min(a.size, b.size) >= 0.5;
}

/** A session title worth reading: not "hey", not an untitled or machine-made run. */
function reusableTitle(s: StarterSession): string | null {
  const title = clean(s.title ?? "");
  if (title.length < 12 || title.split(" ").length < 3) return null;
  const m = s.metadata ?? {};
  if (m.oma_setup || m.eval) return null;
  return title;
}

// Words that only say when: a tail made of these (and numbers) is a date.
const WHEN = new Set(
  `jan january feb february mar march apr april may jun june jul july aug august sep sept september oct october nov november
   dec december mon monday tue tues tuesday wed wednesday thu thur thurs thursday fri friday sat saturday sun sunday
   today tonight yesterday tomorrow week month quarter year morning evening night am pm run train batch the of for on at`
    .split(/\s+/)
    .filter(Boolean),
);

/** "Nov 4", "September", "2026-11-04", "week 45", "Q4 2026": particulars that only date a past run. */
function isDate(text: string): boolean {
  const words = text
    .toLowerCase()
    .replace(/[(),.]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return true;
  let dated = false;
  for (const w of words) {
    if (/^\d{1,4}(st|nd|rd|th)?$/.test(w) || /^\d{1,4}[-/.]\d{1,2}([-/.]\d{1,4})?$/.test(w) || /^q[1-4]$/.test(w) || /^w\d{1,2}$/.test(w)) {
      dated = true;
      continue;
    }
    if (!WHEN.has(w)) return false;
    if (w.length > 2 && !["the", "for", "run", "train", "batch"].includes(w)) dated = true;
  }
  return dated;
}

const QUESTION = /^(how|what|why|when|where|which|who|can|could|should|is|are|does|do|will)\b/i;

/** Does it read as something said to an agent: an instruction or a question? */
function readsAsAsk(text: string): boolean {
  return VERBS.has(firstWord(text).toLowerCase()) || QUESTION.test(text) || text.trim().endsWith("?");
}

export interface TitleAsk {
  /** What the chip says. */
  label: string;
  /** What goes into the composer. A trailing space means "finish this". */
  text: string;
  /** True when the person is expected to add the particulars. */
  open: boolean;
}

/**
 * A past session's title as something to ask now, or null when it cannot be
 * read as one. See the note at the top of this file.
 */
export function askFromTitle(raw: string): TitleAsk | null {
  let title = clean(raw);
  // A closing "(…)" is a particular of that one run: "(Nov 3)", "(ACME-4821)".
  const particular = /\(([^()]*)\)\s*$/.exec(title)?.[1] ?? "";
  title = title.replace(/\s*\([^()]*\)\s*$/, "");
  const sep = /\s([—–-])\s|(:)\s/.exec(title);
  const head = sep ? title.slice(0, sep.index).trim() : title;
  const tail = sep ? title.slice(sep.index + sep[0].length).trim() : "";
  const joiner = sep?.[2] ? ": " : " — ";

  const words = head.split(" ");
  if (readsAsAsk(head)) {
    // Already an ask, about one numbered case ("Review PR #1842", "Fix
    // ACME-4821"): the case is over, the ask is not. The number is left open.
    // The chip asks for "a PR", not "PR #…": a whole ask, with the
    // ellipsis saying the particulars are the person's to add.
    const ref = /(#|\b[A-Z][A-Z0-9]+-)\d+/.exec(head);
    if (ref && ref.index > 0 && head.slice(0, ref.index).trim().split(" ").length >= 2) {
      const stem = head.slice(0, ref.index) + ref[1];
      const [verb, ...object] = head.slice(0, ref.index).trim().split(" ");
      return { label: `${verb} ${withArticle(object.join(" "))}…`, text: stem, open: true };
    }
    // "Triage: SSO login loop after Okta migration (ACME-4821)": the work,
    // then one case of it. Asked as "Triage a ticket…" when the case names
    // what it is (a ticket key, a PR number), otherwise "Triage a new case…".
    if (tail && !isDate(tail) && words.length <= 2) {
      const what = caseNoun(`${tail} ${particular}`);
      const label = words.length === 1 ? `${head} ${what}…` : `${head}…`;
      return { label, text: `${head}${joiner}`, open: true };
    }
    // Otherwise it is asked as it was. Its date goes; anything else it said stays.
    const ask = tail && !isDate(tail) ? `${head}${joiner}${tail}` : head;
    if (ask.split(" ").length < 2) return null;
    return { label: shortLabel(ask), text: ask, open: false };
  }
  if (words.length < 2) return null;
  // "Nightly DQ check — Nov 4": a job named by how often it runs.
  if (CADENCE.has(words[0].toLowerCase())) {
    const ask = `Run the ${words[0].toLowerCase()} ${words.slice(1).join(" ")}`;
    return { label: shortLabel(ask), text: ask, open: false };
  }
  // "Call summary — Initech discovery": a kind of work, then one case of
  // it. The chip asks for a new one ("New call summary…"); the composer
  // gets the work's own words ("Call summary — ") to finish.
  if (tail) return { label: `New ${lowerFirst(head)}…`, text: `${head}${joiner}`, open: true };
  // "Onboarding plan for Globex Corp": the same, joined by a preposition.
  const prep = /\s(for|on|about|of)\s/.exec(head);
  if (prep && head.slice(0, prep.index).split(" ").length >= 2) {
    const work = head.slice(0, prep.index);
    return { label: `New ${lowerFirst(work)}…`, text: `${work} ${prep[1]} `, open: true };
  }
  return null;
}

/** "PR" → "a PR", "incident" → "an incident", "SLA breach" → "an SLA breach". Kept when it has one already. */
export function withArticle(noun: string): string {
  const n = noun.trim();
  if (!n) return "one";
  if (/^(a|an|the|this|that|another|our|my|your|its|their)\s/i.test(n)) return n;
  const word = n.split(" ")[0];
  // An initialism is said letter by letter: "an SLA", "an HR request", "a PR".
  const vowelSound = /^[A-Z0-9]{2,}$/.test(word)
    ? /^[AEFHILMNORSX8]/.test(word)
    : /^[aeio]/i.test(word) || (/^u/i.test(word) && !/^(uni|use|usu|ura|uro|uti)/i.test(word)) || /^hour|^honest/i.test(word);
  return `${vowelSound ? "an" : "a"} ${n}`;
}

/** What one case of a piece of work is, from its particulars. */
function caseNoun(particulars: string): string {
  if (/\b[A-Z][A-Z0-9]+-\d+\b/.test(particulars)) return "a ticket";
  if (/\bPR\s*#?\d+|pull request/i.test(particulars)) return "a pull request";
  if (/#\d+/.test(particulars)) return "an issue";
  return "a new case";
}

/** "Call summary" → "call summary"; an initialism or a camel-cased name keeps its capitals ("DQ check", "GitHub sync"). */
function lowerFirst(text: string): string {
  const [first, ...rest] = text.split(" ");
  if (!first || /^[A-Z0-9]{2,}$/.test(first) || /[A-Z].*[A-Z]/.test(first)) return text;
  const lowered = first[0].toLowerCase() + first.slice(1);
  return [lowered, ...rest].join(" ");
}

const relative = (iso: string, now: number): string => {
  const days = Math.floor((now - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 1) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
};

/** Words for any agent, when the workspace knows nothing else about it yet. */
const GENERIC: Array<Pick<Starter, "label" | "text">> = [
  { label: "What can you help me with?", text: "What can you help me with? List the kinds of task you are set up for." },
  { label: "What do you need from me to start?", text: "What do you need from me before you can start working?" },
];

export function buildStarters({
  agent,
  rules = [],
  sessions = [],
  max = 4,
  now = Date.now(),
}: {
  agent: StarterAgent | null | undefined;
  /** The agent's triggers. */
  rules?: StarterRule[];
  /** Recent sessions, newest first. Only this agent's are read. */
  sessions?: StarterSession[];
  max?: number;
  now?: number;
}): Starter[] {
  if (!agent) return [];

  // ── what the agent is for ──
  const jobs: Starter[] = [];
  const described = asksFromDescription(agent.description);
  const opening = askFromInstructions(agent.system);
  const asks = [...described];
  // The instructions open by restating the whole job. That is the fallback
  // when there is no description to read, and a shorter way to say the
  // description's first ask when that one does not fit a chip.
  if (opening) {
    if (asks.length === 0) asks.push(opening);
    else if (shortLabel(asks[0]).endsWith("…") && !shortLabel(opening).endsWith("…")) asks[0] = opening;
  }
  asks.forEach((ask, i) => {
    jobs.push({
      key: `job-${i}`,
      kind: "job",
      label: shortLabel(ask),
      text: ask,
      hint: "Part of what this agent is set up to do. Click to start from it.",
    });
  });

  // ── what its schedules ask ──
  const triggers: Starter[] = [];
  for (const rule of rules) {
    const prompt = rule.trigger?.config?.prompt;
    if (typeof prompt !== "string" || !prompt.trim()) continue;
    const ask = capitalise(clean(prompt).replace(/^scheduled run:\s*/i, ""));
    if (ask.split(" ").length < 3) continue;
    triggers.push({
      key: `trigger-${rule.id}`,
      kind: "trigger",
      label: shortLabel(ask),
      text: ask,
      hint: `What the trigger “${rule.name}” asks each time it fires. Click to ask it now.`,
    });
  }

  // ── what it was asked before ──
  const recents: Starter[] = [];
  for (const s of sessions) {
    if (s.agent?.id !== agent.id) continue;
    const title = reusableTitle(s);
    const ask = title ? askFromTitle(title) : null;
    if (!title || !ask) continue;
    const when = relative(s.updated_at || s.created_at, now);
    recents.push({
      key: `recent-${s.id}`,
      kind: "recent",
      label: ask.label,
      text: ask.text,
      hint: ask.open
        ? `From “${title}”, ${when}. Click to start another and add the details.`
        : `From “${title}”, ${when}. Click to ask it now and change the details.`,
    });
  }

  // One row, mixed: up to two jobs, a schedule, then history, then whatever
  // is left. Two starters that say the same thing never sit side by side.
  const picked: Starter[] = [];
  const seen: Array<{ kind: StarterKind; sig: Set<string> }> = [];
  const take = (list: Starter[], limit: number, against: "all" | "recent" = "all") => {
    let taken = 0;
    for (const s of list) {
      if (picked.length >= max || taken >= limit) return;
      if (picked.includes(s) || picked.some((p) => p.label === s.label)) continue;
      const sig = signature(s.text);
      const clash = seen.some((other) => (against === "all" || (against === "recent" && other.kind === "recent")) && alike(sig, other.sig));
      if (clash) continue;
      picked.push(s);
      seen.push({ kind: s.kind, sig });
      taken += 1;
    }
  };
  take(jobs, 2);
  take(triggers, 1);
  take(recents, 2);
  take(jobs, max);
  take(recents, max);
  take(triggers, max);
  // A single chip is thin, but a near copy of it ("Coordinate v2.14 release
  // readiness" beside "Coordinate release readiness") reads as a duplicate.
  // Pair the one job with a question that finds out what else the agent does.
  if (picked.length === 1) {
    picked.push({
      key: "generic-0",
      kind: "job",
      ...GENERIC[0],
      hint: "A way to find out what this agent can do. Click to start from it.",
    });
  }

  if (picked.length === 0) {
    return GENERIC.slice(0, max).map((g, i) => ({
      key: `generic-${i}`,
      kind: "job" as const,
      ...g,
      hint: "A way to find out what this agent can do. Click to start from it.",
    }));
  }
  return picked;
}
