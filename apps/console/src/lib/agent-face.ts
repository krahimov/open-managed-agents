import type { ComponentType } from "react";
import {
  ArrowUpFromLineIcon,
  ActivityIcon,
  BellRingIcon,
  BinocularsIcon,
  BookOpenIcon,
  BotIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarDaysIcon,
  CatIcon,
  ChartLineIcon,
  ClipboardListIcon,
  CodeXmlIcon,
  CompassIcon,
  ConciergeBellIcon,
  DatabaseIcon,
  FlameIcon,
  FlaskConicalIcon,
  GaugeIcon,
  GhostIcon,
  GitPullRequestIcon,
  GlobeIcon,
  GraduationCapIcon,
  HeadsetIcon,
  HeartIcon,
  IterationCwIcon,
  LandmarkIcon,
  LanguagesIcon,
  LeafIcon,
  LifeBuoyIcon,
  LightbulbIcon,
  MailIcon,
  MegaphoneIcon,
  MessageCircleQuestionMarkIcon,
  MessagesSquareIcon,
  MicIcon,
  NetworkIcon,
  NotebookPenIcon,
  PackageIcon,
  PenLineIcon,
  PhoneIcon,
  PickaxeIcon,
  PresentationIcon,
  RadarIcon,
  ReceiptIcon,
  RocketIcon,
  ScaleIcon,
  ScanTextIcon,
  ScrollTextIcon,
  SearchIcon,
  ShieldCheckIcon,
  ShoppingCartIcon,
  SirenIcon,
  SmileIcon,
  SparklesIcon,
  SquareTerminalIcon,
  StarIcon,
  TargetIcon,
  TelescopeIcon,
  TrendingUpIcon,
  TruckIcon,
  UsersIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

import { hashIndex, initials } from "./format";

/**
 * An agent's face: the glyph and tint its avatar wears on every screen.
 *
 * Where it comes from, in order:
 *   1. `metadata.avatar` on the agent record: a person chose it in the
 *      create or edit dialog, or it was carried over from the template the
 *      agent was created from. (`metadata` is persisted by the existing
 *      agent endpoints and merged per key, so nothing else is touched.)
 *   2. Read from the agent's name, then its description: "Support Triage"
 *      wears a headset, "PR Reviewer" a pull request. The tint is the
 *      glyph's family, so agents that do the same kind of work look related.
 *   3. Two initials, when the name and description say nothing we can read.
 *
 * Within a workspace no two agents wear the same glyph in the same tint
 * until every tint of that glyph is taken: the newer agent moves to the
 * tint furthest from the one in use (`faceBook`). So "Incident Commander"
 * and "Incident commander 2" are a peach siren and a lilac siren, not two
 * identical "IC" squares.
 */

export type FaceIcon = ComponentType<{ className?: string }>;

/** The six identity tints (`.tint-1` … `.tint-6` in index.css), in hue order. */
export const FACE_TINTS = [
  { id: "apricot", label: "Apricot", family: "Business" },
  { id: "peach", label: "Peach", family: "Operations" },
  { id: "rose", label: "Rose", family: "Customers" },
  { id: "orchid", label: "Orchid", family: "Communication" },
  { id: "lilac", label: "Lilac", family: "Research" },
  { id: "periwinkle", label: "Periwinkle", family: "Engineering" },
] as const;

export type FaceTint = (typeof FACE_TINTS)[number]["id"];

const TINT_IDS = FACE_TINTS.map((t) => t.id) as readonly FaceTint[];

/** The CSS class that sets `--tint-bg` and `--tint-fg` for a tint. */
export function tintClass(tint: FaceTint): string {
  return `tint-${TINT_IDS.indexOf(tint) + 1}`;
}

/** The picker's sections, in order. The first six are the tint families. */
export const FACE_GROUPS = ["Customers", "Operations", "Engineering", "Research", "Communication", "Business", "More"] as const;
export type FaceGroup = (typeof FACE_GROUPS)[number];

export interface FaceGlyph {
  id: string;
  /** What the glyph stands for, for tooltips and the picker. */
  label: string;
  icon: FaceIcon;
  /** Where the picker lists it. */
  group: FaceGroup;
  /** The family tint an agent gets with this glyph unless a person picks
   *  another. Characters have none: their tint comes from the agent id. */
  tint: FaceTint | null;
}

const FAMILY_TINT: Record<FaceGroup, FaceTint | null> = {
  Customers: "rose",
  Operations: "peach",
  Engineering: "periwinkle",
  Research: "lilac",
  Communication: "orchid",
  Business: "apricot",
  More: null,
};

const g = (id: string, label: string, icon: FaceIcon, group: FaceGroup, tint: FaceTint | null = FAMILY_TINT[group]): FaceGlyph => ({
  id,
  label,
  icon,
  group,
  tint,
});

/**
 * Every glyph an agent can wear. Each was checked at 20px in both themes:
 * shapes that turn to a blot at that size are not here. Eight to a family,
 * so the picker's rows are whole.
 */
export const FACE_GLYPHS: readonly FaceGlyph[] = [
  g("headset", "Support", HeadsetIcon, "Customers"),
  g("concierge", "Concierge", ConciergeBellIcon, "Customers"),
  g("lifebuoy", "Help desk", LifeBuoyIcon, "Customers"),
  g("question", "Questions and answers", MessageCircleQuestionMarkIcon, "Customers"),
  g("smile", "Customer success", SmileIcon, "Customers"),
  g("users", "People", UsersIcon, "Customers"),
  g("compass", "Onboarding and guides", CompassIcon, "Customers"),
  g("escalate", "Escalation", ArrowUpFromLineIcon, "Customers"),

  g("siren", "Incidents", SirenIcon, "Operations"),
  g("radar", "Monitoring", RadarIcon, "Operations"),
  g("bell", "Alerts", BellRingIcon, "Operations"),
  g("pulse", "Health checks", ActivityIcon, "Operations"),
  g("gauge", "Scoring", GaugeIcon, "Operations"),
  g("shield", "Quality and security", ShieldCheckIcon, "Operations"),
  g("wrench", "Maintenance", WrenchIcon, "Operations"),
  g("flame", "Firefighting", FlameIcon, "Operations"),

  g("pull-request", "Code review", GitPullRequestIcon, "Engineering"),
  g("code", "Coding", CodeXmlIcon, "Engineering"),
  g("bug", "Bugs", BugIcon, "Engineering"),
  g("terminal", "Shell and infrastructure", SquareTerminalIcon, "Engineering"),
  g("database", "SQL and data", DatabaseIcon, "Engineering"),
  g("network", "Coordination", NetworkIcon, "Engineering"),
  g("rocket", "Releases", RocketIcon, "Engineering"),
  g("scan", "Extraction", ScanTextIcon, "Engineering"),

  g("telescope", "Research", TelescopeIcon, "Research"),
  g("binoculars", "Market watch", BinocularsIcon, "Research"),
  g("chart", "Analysis", ChartLineIcon, "Research"),
  g("trend", "Forecasts", TrendingUpIcon, "Research"),
  g("flask", "Experiments and evals", FlaskConicalIcon, "Research"),
  g("book", "Docs and knowledge", BookOpenIcon, "Research"),
  g("search", "Search", SearchIcon, "Research"),
  g("cap", "Training", GraduationCapIcon, "Research"),

  g("pen", "Writing", PenLineIcon, "Communication"),
  g("scroll", "Release notes", ScrollTextIcon, "Communication"),
  g("notebook", "Notes and summaries", NotebookPenIcon, "Communication"),
  g("megaphone", "Announcements", MegaphoneIcon, "Communication"),
  g("mail", "Email", MailIcon, "Communication"),
  g("chat", "Conversations", MessagesSquareIcon, "Communication"),
  g("mic", "Transcripts", MicIcon, "Communication"),
  g("languages", "Translation", LanguagesIcon, "Communication"),

  g("phone", "Calls", PhoneIcon, "Business"),
  g("briefcase", "Sales", BriefcaseIcon, "Business"),
  g("target", "Goals and campaigns", TargetIcon, "Business"),
  g("landmark", "Finance", LandmarkIcon, "Business"),
  g("receipt", "Billing", ReceiptIcon, "Business"),
  g("scale", "Reconciliation and legal", ScaleIcon, "Business"),
  g("calendar", "Scheduling", CalendarDaysIcon, "Business"),
  g("clipboard", "Planning", ClipboardListIcon, "Business"),

  // More subjects, each still in its family's tint…
  g("pickaxe", "Feedback mining", PickaxeIcon, "More", "apricot"),
  g("loop", "Retrospectives", IterationCwIcon, "More", "periwinkle"),
  g("package", "Builds", PackageIcon, "More", "periwinkle"),
  g("presentation", "Slides", PresentationIcon, "More", "orchid"),
  g("cart", "Orders", ShoppingCartIcon, "More", "apricot"),
  g("truck", "Logistics", TruckIcon, "More", "apricot"),
  g("globe", "The web", GlobeIcon, "More", "lilac"),
  g("lightbulb", "Ideas", LightbulbIcon, "More", "lilac"),
  // …and characters, for a person to pick. Never derived; no family.
  g("bot", "Robot", BotIcon, "More"),
  g("sparkles", "Sparkles", SparklesIcon, "More"),
  g("zap", "Bolt", ZapIcon, "More"),
  g("star", "Star", StarIcon, "More"),
  g("leaf", "Leaf", LeafIcon, "More"),
  g("heart", "Heart", HeartIcon, "More"),
  g("ghost", "Ghost", GhostIcon, "More"),
  g("cat", "Cat", CatIcon, "More"),
];

const GLYPH_BY_ID = new Map(FACE_GLYPHS.map((glyph) => [glyph.id, glyph]));

export function faceGlyph(id: string | null | undefined): FaceGlyph | null {
  return (id && GLYPH_BY_ID.get(id)) || null;
}

/**
 * How a name is read. First match wins, so the order is the judgement:
 * roles that say exactly what the agent does come first ("coordinator",
 * "reconciler"), then subjects from specific to broad ("pull request"
 * before "code"), then the loose roles that fit almost anything
 * ("monitor", "analyst", "writer"). Words that every agent could carry
 * ("agent", "assistant", "bot") match nothing: initials tell those apart
 * better than one shared robot.
 */
export const FACE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // Roles that are the whole job
  [/\bconcierge/, "concierge"],
  [/\bescalat/, "escalate"],
  [/\bcoordinat|\borchestrat|\bdispatch|\bdelegat|\bsupervis|\brouter\b|\brouting\b/, "network"],
  [/\breconcil/, "scale"],
  // Engineering and operations subjects
  [/\bpull requests?\b|\bprs?\b|\bcode review|\bmerge requests?\b/, "pull-request"],
  [/\bincident|\bon-?call\b|\boutage|\bsev-?\d|\bpager|\bwar room/, "siren"],
  [/\bpost-?mortem|\bretro(spective)?s?\b/, "loop"],
  [/\brelease notes?\b|\bchange-?log|\bwhat'?s new\b/, "scroll"],
  [/\bsql\b|\bdatabase|\bwarehouse|\bpostgres|\bbigquery|\bsnowflake|\bquer(y|ies)\b|\betl\b|\bdata pipeline/, "database"],
  [/\bqualit|\bcomplian|\baudit|\bsecur|\bvulnerab|\bguard|\bverif|\bvalidat|\bqa\b|\bsafety\b|\bmoderat|\bfraud/, "shield"],
  [/\bbugs?\b|\bdebug|\bcrash|\bregression/, "bug"],
  [/\btest(s|ing|er)?\b|\bexperiment|\bevals?\b|\bevaluat|\bbenchmark|\bsimulat/, "flask"],
  [/\brelease|\bdeploy|\blaunch|\brollout/, "rocket"],
  [/\bdevops\b|\binfra|\bsre\b|\bshell\b|\bterminal\b|\bcli\b|\bscript|\bsysadmin|\bkubernetes|\bk8s\b|\bserver/, "terminal"],
  [/\bcod(e|ing|er)\b|\bdeveloper|\bengineer|\bprogramm|\brefactor|\bfrontend|\bbackend|\bfull-?stack|\brepo(sitor(y|ies))?\b/, "code"],
  [/\bbuild(s|er)?\b|\bpackag|\bdependenc|\bupgrade|\bmigrat/, "package"],
  // Research subjects
  [/\bcompetit|\bmarket (research|intel|watch)|\bintel(ligence)?\b|\bscout|\bprospect/, "binoculars"],
  [/\bresearch/, "telescope"],
  [/\bchurn|\bforecast|\bgrowth\b|\btrend|\bretention\b|\bpredict/, "trend"],
  [/\bextract|\bpars(e|er|ing)\b|\bocr\b|\bscrap(e|er|ing)\b|\bclassif|\bstructured\b/, "scan"],
  // Customers
  [/\bcustomer success|\bcsat\b|\bsatisf|\bhappiness/, "smile"],
  [/\bonboard|\bwelcome|\bnavigator|\btravel|\btrips?\b|\bitinerar/, "compass"],
  [/\bhelp ?desk|\bservice desk|\bhelp cent(er|re)/, "lifebuoy"],
  [/\bsupport\b|\btickets?\b|\bcustomer service/, "headset"],
  [/\bq\s?&\s?a\b|\bfaqs?\b|\bquestions?\b/, "question"],
  [/\bfeedback|\bmin(er|ing)\b|\bvoice of (the )?customer|\bsurvey|\bnps\b/, "pickaxe"],
  [/\brecruit|\bhiring\b|\bcandidate|\bhr\b|\bpeople ops|\bemployee|\bstaffing/, "users"],
  // Business
  [/\bcalls?\b|\bphone\b|\bvoice\b|\bdial(er|ing)?\b/, "phone"],
  [/\binvoic|\bbilling\b|\breceipt|\bexpense|\bpayment|\brefund|\bpayout|\bpricing\b/, "receipt"],
  [/\bfinanc|\baccount(ing|ant)\b|\baccounts (payable|receivable)|\bbookkeep|\bledger|\btreasur|\bbudget|\btax(es)?\b|\bpayroll|\bbank/, "landmark"],
  [/\blegal\b|\bcontract|\bpolic(y|ies)\b|\bterms\b|\bregulat/, "scale"],
  [/\bsales\b|\bdeals?\b|\bcrm\b|\bleads?\b|\boutbound|\bsdr\b|\bbdr\b|\brevenue|\bpartnerships?\b/, "briefcase"],
  [/\bgoals?\b|\bokrs?\b|\bcampaign|\bads?\b|\bseo\b|\bconversion/, "target"],
  [/\bmeeting (notes|minutes|summar|recap)/, "notebook"],
  [/\bschedul|\bcalendar|\bmeetings?\b|\bbooking|\bappointment|\bstand-?up|\bagenda/, "calendar"],
  [/\borders?\b|\bcheckout|\be-?commerce|\bshop|\bcart\b|\binventor|\bmerchand/, "cart"],
  [/\blogistic|\bshipping\b|\bshipment|\bdeliver|\bfleet|\bsupply chain|\bprocure|\bvendor/, "truck"],
  // Communication
  [/\btranscri|\bpodcast|\bdictat/, "mic"],
  [/\btranslat|\blocali[sz]|\blanguage|\bmultilingual|\binterpret/, "languages"],
  [/\bslides?\b|\bdecks?\b|\bpresentation|\bpitch\b|\bkeynote/, "presentation"],
  [/\be-?mail|\binbox|\bmailbox|\boutreach|\bcorrespond/, "mail"],
  [/\bannounc|\bmarketing|\bsocial\b|\bpromo|\bbrand|\bcomms\b|\bnewsletter|\bpress\b|\btweet/, "megaphone"],
  [/\bchat|\bslack\b|\bdiscord|\bmessag|\bconvers|\bcommunity|\bforum/, "chat"],
  [/\bdocs?\b|\bdocumentation|\bknowledge|\bwiki|\bhandbook|\bmanuals?\b|\blibrar|\bglossary/, "book"],
  [/\btutor|\bteach|\btrain(er|ing)\b|\bcoach|\blearn|\bcourse|\bquiz|\bmentor|\beducat/, "cap"],
  [/\bideas?\b|\bbrainstorm|\bstrateg|\badvis|\bconsult|\binnovat/, "lightbulb"],
  // Loose roles: they fit when nothing above did
  [/\bmonitor|\bwatch(er|dog)?\b|\btrack(er|ing)?\b|\bobserv|\bsentinel|\bdetect/, "radar"],
  [/\balert|\bnotif|\bremind|\bnudge/, "bell"],
  [/\bhealth|\buptime|\bstatus\b|\bheartbeat|\bpulse/, "pulse"],
  [/\bscor(e|er|ing)\b|\brank(er|ing)?\b|\bgrad(e|er|ing)\b|\bperforman|\brisk\b|\blatency/, "gauge"],
  [/\bhot-?fix|\bfirefight/, "flame"],
  [/\bfix(er|es)?\b|\bmaint(ain|enance)|\brepair|\bclean-?up|\bjanitor|\bops\b/, "wrench"],
  [/\banaly(st|sis|tics|ze|zer|se|ser)\b|\bmetrics?\b|\bdashboard|\breport(s|ing|er)?\b|\binsights?\b|\bstatistic|\bdata\b|\bcohort|\bkpis?\b/, "chart"],
  [/\bplan(s|ner|ning)?\b|\btasks?\b|\bproject|\bbacklog|\bsprint|\broadmap|\bto-?do|\bchecklist|\bproduct\b/, "clipboard"],
  [/\bnotes?\b|\bsummar|\bdigest|\brecap|\bbrief(s|ing)?\b|\bminutes\b|\bjournal|\bscribe/, "notebook"],
  [/\bwrit(e|er|ing)\b|\bcopy-?writ|\beditor\b|\bedit(s|ing)?\b|\bblog|\bauthor|\bproofread|\bdraft|\bcontent\b/, "pen"],
  [/\bsearch|\bfind(er)?\b|\blook-?up|\bretriev|\bcrawl|\bindex(er)?\b/, "search"],
  [/\bweb\b|\bbrows(e|er|ing)\b|\binternet|\bwebsite/, "globe"],
  [/\breview(s|er|ing)?\b|\bcheck(s|er|ing)?\b|\bapprov/, "shield"],
  [/\bcustomers?\b|\bclients?\b|\busers?\b|\bmembers?\b|\bteam\b/, "users"],
  [/\bhelp(er)?\b|\brescue/, "lifebuoy"],
];

function readGlyph(text: string | null | undefined): FaceGlyph | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  for (const [pattern, id] of FACE_RULES) if (pattern.test(t)) return GLYPH_BY_ID.get(id) ?? null;
  return null;
}

/**
 * The glyph a name (then a description) suggests, or null for initials.
 * A bracketed aside in a name ("Churn Risk Scorer (experiment)") is a note
 * about the agent, not what it does, so it is only read if the rest of the
 * name says nothing.
 */
export function deriveGlyph(name: string | null | undefined, description?: string | null): FaceGlyph | null {
  const plain = (name ?? "").replace(/\([^)]*\)|\[[^\]]*\]/g, " ");
  return readGlyph(plain) ?? readGlyph(name) ?? readGlyph(description);
}

// ── A person's choice, as stored in `metadata.avatar` ───────────────────

/** The metadata key the choice is stored under. */
export const FACE_METADATA_KEY = "avatar";

/** Stands for "two initials" where a glyph id is expected. */
export const INITIALS_GLYPH = "initials";

export interface FaceChoice {
  /** A glyph id, `"initials"`, or null to read it from the name. */
  glyph: string | null;
  /** A tint id, or null for the glyph's family tint. */
  tint: FaceTint | null;
}

/**
 * Read a stored choice: `"siren:peach"`, `"siren"`, `":lilac"` or
 * `"initials:rose"`. Anything this console does not know (another client's
 * value, a glyph that was retired) reads as "no choice", never as an error.
 */
export function parseFace(value: unknown): FaceChoice | null {
  if (typeof value !== "string") return null;
  const [rawGlyph = "", rawTint = ""] = value.trim().toLowerCase().split(":");
  const glyph = rawGlyph === INITIALS_GLYPH || GLYPH_BY_ID.has(rawGlyph) ? rawGlyph : null;
  const tint = (TINT_IDS as readonly string[]).includes(rawTint) ? (rawTint as FaceTint) : null;
  return glyph || tint ? { glyph, tint } : null;
}

/** The string to store for a choice; `""` when nothing is chosen (the
 *  server drops a metadata key that is set to an empty string). */
export function formatFace(choice: FaceChoice | null | undefined): string {
  if (!choice || (!choice.glyph && !choice.tint)) return "";
  return choice.tint ? `${choice.glyph ?? ""}:${choice.tint}` : (choice.glyph ?? "");
}

// ── Resolving a face ────────────────────────────────────────────────────

export interface AgentFace {
  /** null draws two initials. */
  glyph: FaceGlyph | null;
  tint: FaceTint;
  /** Where the glyph came from. */
  source: "chosen" | "derived" | "initials";
}

/** What `faceBook` needs from an agent record. */
export interface FaceSubject {
  id?: string | null;
  name?: string | null;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  created_at?: string | number | null;
}

interface Draft extends AgentFace {
  /** A person fixed the tint, so it must not be moved. */
  tintFixed: boolean;
}

function draftFace(agent: FaceSubject): Draft {
  const choice = parseFace(agent.metadata?.[FACE_METADATA_KEY]);
  const seed = agent.id || agent.name || "?";
  let glyph: FaceGlyph | null;
  let source: AgentFace["source"];
  if (choice?.glyph === INITIALS_GLYPH) {
    glyph = null;
    source = "chosen";
  } else if (choice?.glyph) {
    glyph = GLYPH_BY_ID.get(choice.glyph) ?? null;
    source = "chosen";
  } else {
    glyph = deriveGlyph(agent.name, agent.description);
    source = glyph ? "derived" : "initials";
  }
  const tint = choice?.tint ?? glyph?.tint ?? TINT_IDS[hashIndex(seed, TINT_IDS.length)];
  return { glyph, tint, source, tintFixed: !!choice?.tint };
}

/**
 * The face of one agent on its own, without looking at its neighbours.
 * Used before the workspace's agents have loaded and for agents the
 * directory does not hold (deleted, or past the first 200).
 */
export function naturalFace(agent: FaceSubject): AgentFace {
  const { glyph, tint, source } = draftFace(agent);
  return { glyph, tint, source };
}

/** The order tints are tried when the family tint is taken: the opposite
 *  hue first, so the two agents are as far apart as six tints allow. */
const TINT_STEPS = [0, 3, 2, 4, 1, 5];

const BOOKS = new WeakMap<readonly FaceSubject[], Map<string, AgentFace>>();

/**
 * Every agent's face, with collisions settled: when two agents would wear
 * the same glyph (or the same initials) in the same tint, the one created
 * later takes the furthest free tint. A tint a person chose is never
 * moved, and chosen faces are placed first so derived ones step around
 * them. Cached per list, so a page of avatars computes it once.
 */
export function faceBook(agents: readonly FaceSubject[]): Map<string, AgentFace> {
  const cached = BOOKS.get(agents);
  if (cached) return cached;

  const book = new Map<string, AgentFace>();
  const taken = new Set<string>();
  const mark = (agent: FaceSubject, face: AgentFace) => `${face.glyph?.id ?? `initials ${initials(agent.name)}`}/${face.tint}`;

  const ordered = agents
    .filter((a): a is FaceSubject & { id: string } => !!a.id)
    .map((agent) => ({ agent, draft: draftFace(agent) }))
    .sort((a, b) => created(a.agent) - created(b.agent) || (a.agent.id < b.agent.id ? -1 : 1));

  for (const { agent, draft } of ordered) {
    if (!draft.tintFixed) continue;
    const face: AgentFace = { glyph: draft.glyph, tint: draft.tint, source: draft.source };
    taken.add(mark(agent, face));
    book.set(agent.id, face);
  }
  for (const { agent, draft } of ordered) {
    if (draft.tintFixed) continue;
    const start = TINT_IDS.indexOf(draft.tint);
    let face: AgentFace = { glyph: draft.glyph, tint: draft.tint, source: draft.source };
    for (const step of TINT_STEPS) {
      const candidate = { ...face, tint: TINT_IDS[(start + step) % TINT_IDS.length] };
      if (!taken.has(mark(agent, candidate))) {
        face = candidate;
        break;
      }
    }
    taken.add(mark(agent, face));
    book.set(agent.id, face);
  }

  BOOKS.set(agents, book);
  return book;
}

function created(agent: FaceSubject): number {
  const at = agent.created_at;
  if (typeof at === "number") return at;
  const ms = at ? Date.parse(at) : NaN;
  return Number.isNaN(ms) ? Number.MAX_SAFE_INTEGER : ms;
}

/**
 * The face a draft would get in this workspace: an agent being created
 * (no id yet) or edited (same id, new name or choice). The avatar picker
 * shows this, so what a person sees in the dialog is what they get.
 */
export function previewFace(agents: readonly FaceSubject[], draft: FaceSubject): AgentFace {
  const id = draft.id || "\u0000draft";
  const rest = agents.filter((a) => a.id !== id);
  const book = faceBook([...rest, { ...draft, id, created_at: draft.created_at ?? Number.MAX_SAFE_INTEGER - 1 }]);
  return book.get(id) ?? naturalFace(draft);
}

/** A face in words, for a tooltip or a version diff: "Siren, peach". */
export function describeFace(face: AgentFace): string {
  const tint = FACE_TINTS.find((t) => t.id === face.tint)?.label.toLowerCase() ?? face.tint;
  return `${face.glyph ? face.glyph.label : "Initials"}, ${tint}`;
}
