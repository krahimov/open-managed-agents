# Muse — design system for the Orrery console

This is the contract for every screen. Read it once, top to bottom, before you build. If something you
need is not here, look at how **Home** (`src/pages/Dashboard.tsx`) and **Agents** (`src/pages/AgentsList.tsx`)
do it, then at `/_kit` (every shared component rendered with live data, both themes). If it is still not
there, build it from tokens and existing parts — do not invent a new look.

- Tokens: `src/index.css`
- Shared components: `src/components/*` (one import: `@/components/kit`)
- Primitives: `src/components/ui/*`
- Living reference: `http://127.0.0.1:5194/_kit`

Contents: [1 Principles](#1-principles) · [2 Tokens](#2-tokens) · [3 Frame and layout](#3-frame-and-layout) ·
[4 Components](#4-components) · [5 Page patterns](#5-page-patterns) · [6 Motion](#6-motion) ·
[7 Words](#7-words) · [8 Do and don't](#8-do-and-dont) · [9 Screen blueprints](#9-screen-blueprints) ·
[10 Data helpers](#10-data-helpers) · [11 Migrating a legacy page](#11-migrating-a-legacy-page)

---

## 1 Principles

**Muse is the conversational home.** Talking to an agent is the front door; the operational depth is one
click behind it. The feeling is approachable, human and spacious. It should look like a product people
enjoy opening, not like an admin panel.

1. **Names, never ids.** A record is shown by its name with an avatar. Ids appear once per record as a
   quiet copyable chip. References to other records resolve to names. Times are relative, absolute on hover.
2. **One primary action per view.** One ink button. Secondary actions are outline or ghost. Destructive
   and rare actions live in a "more" menu and go through a confirmation.
3. **Soft, not lined.** Separation comes from space, soft fills and elevation. A hairline is the last
   resort. Radii are generous: pills for buttons and chips, 18px for cards, 24px for the composer and dialogs.
4. **Ink and one accent.** Text and the primary button are ink (a deep plum-black). Plum is the single
   accent, used only for links, focus and selection. Saturated colour is reserved for status and data.
5. **The wash is rationed.** The peach → rose → lilac gradient is the brand's one decorative gesture. It
   appears on Home, on login, in an agent's profile header and in page-level empty states. Nowhere else.
6. **Every state is designed.** Loading has a shape (skeletons), empty says what to do next, errors say
   what failed and offer a retry. Never show one in place of another.
7. **Quiet motion.** 120 / 180 / 240ms, one easing curve, fade-and-rise on enter. Nothing loops except
   "live" indicators. All of it is off under `prefers-reduced-motion`.

---

## 2 Tokens

All tokens are CSS variables in `src/index.css`, mapped to Tailwind utilities in `@theme`. Use the
utility (`bg-bg-surface`, `text-fg-muted`), never a raw hex or an arbitrary colour.

### 2.1 Colour roles

Surfaces, lowest to highest. In light they step toward white; in dark they step **up** in lightness.

| Utility | Role | Light | Dark |
|---|---|---|---|
| `bg-bg-sidebar` | Stage: the frame behind sidebar and panel | `#f7f1f0` | `#130e11` |
| `bg-bg` | Panel: the page canvas | `#fefbfa` | `#1a1517` |
| `bg-bg-surface` | Cards, inputs, table bodies | `#ffffff` | `#231e21` |
| `bg-bg-raised` | Popovers, menus, dialogs, toasts | `#ffffff` | `#2b2528` |
| `bg-bg-inset` | Wells: read-only blocks, card footers, code in dark | `#f9f5f4` | `#151113` |
| `bg-bg-soft` | Soft fill (alpha): chips, tool rows, quiet buttons, user bubble | ink 4.5% | white 5.5% |
| `bg-bg-hover` | Hover fill (alpha) for rows, ghost buttons, menu items | ink 6% | white 7.5% |
| `bg-bg-pressed` | Pressed / selected fill (alpha), skeletons | ink 10% | white 12% |
| `bg-bg-overlay` | Scrim behind dialogs and sheets | ink 22% | black 60% |

Text and lines.

| Utility | Role | Light | Dark | Contrast (on surface) |
|---|---|---|---|---|
| `text-fg` | Primary text, titles, values | `#261925` | `#f3efec` | 16:1 |
| `text-fg-muted` | Secondary text, descriptions | `#5f545d` | `#bab1b7` | 7:1 |
| `text-fg-subtle` | Captions, placeholders, table heads, meta | `#6e666d` | `#a1999e` | ≥ 4.7:1 on every surface, soft fill and hovered row |
| `text-fg-faint` | Decorative glyphs, chevrons, disabled. **Never text that must be read.** | `#a39ca2` | `#686165` | — |
| `border-border` | Hairline (alpha): card edges, dividers | ink 9% | white 8.5% | — |
| `border-border-strong` | Control edges (inputs, outline buttons), dashed chips | ink 17% | white 17% | — |

Brand.

| Utility | Role | Light | Dark |
|---|---|---|---|
| `bg-ink` / `text-on-ink` | The primary button, selected step, checked checkbox, tooltip | `#261925` / `#fefbfa` | `#f2ece4` / `#20141c` |
| `hover:bg-ink-hover` | Primary hover | `#3d2c3b` | `#ffffff` |
| `text-plum` | Links, focus ring (`--ring`), selection dot, progress | `#9e317d` | `#efa1d2` |
| `bg-plum-subtle` | Tint behind a plum label (rare) | `#feeaf6` | `#432538` |
| `wash`, `wash-corner` | The signature gradient (utilities). See §4.9. | peach `#ffe3c8` · rose `#ffdbdf` · lilac `#eddfff` | pale warm pink · rose · lilac at 14–16% alpha: a rosy glow, never orange (thin orange on a dark canvas is brown) |

Contrast is computed, not eyeballed: `_rig/notes/muse/tools/director/contrast.mjs` reads these tokens from
`index.css` and checks every text token on every surface and alpha fill in both themes (alpha composited the
way a browser does it). Lowest pair today: 4.71:1. Two rules keep it true: **a pressed fill
(`bg-bg-pressed`) carries `text-fg` or `text-fg-muted`, never `text-fg-subtle`**, and a hovered sidebar row
raises its text to `fg` / `fg-muted`.

`brand`, `brand-hover`, `brand-subtle`, `brand-fg` still exist as **legacy aliases of ink**. Do not use them
in new code. The shadcn names (`primary`, `secondary`, `muted`, `accent`, `popover`, `card`, `destructive`,
`input`, `ring`, `sidebar-*`) map onto the roles above so the `ui/` and `ai-elements/` primitives work
unchanged; prefer the Muse names when you write new classes.

### 2.2 Status colours

Meaning is fixed across the product. Each has a text tone, a soft tint and a solid fill.

| Meaning | Text / icon | Tint | Solid (dots, meters) | Used for |
|---|---|---|---|---|
| **info** — working now | `text-info` `#1f68bc` / `#83bdf8` | `bg-info-subtle` | `bg-info-solid` | running, provisioning, in progress |
| **success** — good | `text-success` `#167645` / `#72d699` | `bg-success-subtle` | `bg-success-solid` | active, completed, passed, connected |
| **warning** — a person is needed | `text-warning` `#935a00` / `#edbb64` | `bg-warning-subtle` | `bg-warning-solid` | needs approval, pending, degraded, near a limit |
| **danger** — failed | `text-danger` `#c02b2f` / `#fc918e` | `bg-danger-subtle` | `bg-danger-solid` | failed, error, expired, over a limit |
| **neutral** — at rest | `text-fg-muted` | `bg-bg-soft` | `bg-fg-faint` | idle, ended, archived, disabled |

Amber means a **person** is needed. Something waiting on a machine (a queued run) is neutral.

**Cards that stop for a person or on a failure** (an access or skill request, `.needs-you-card`; a failed turn,
`EventCard kind="error"`; a failed send's `ComposerNotice tone="danger"`, which draws the edge as an inset ring
in dark so nothing moves) take their own tokens, `--needs-you-bg`/`--needs-you-border` and
`--failed-bg`/`--failed-border`. In light they are the warning and danger tints. In dark the fill is the
surface's own step with a trace of the hue (`oklch(0.252 0.011 72)`, `oklch(0.252 0.013 20)`) and the edge is
strong (55% warning, 50% danger): a full dark tint made two such cards on Operations two brown or maroon slabs,
heavier than anything beside them. The edge and the mark carry the signal; the card reads as a card.

`accent-violet` / `accent-violet-subtle` exist for legacy tags only. Never colour-code resource **types**.
You almost never write these classes by hand: use `<StatusBadge status="…">` (§4.2).

### 2.3 Chart colours

Six categorical hues, validated for colour-blind separation and contrast in both themes. Use them **in
order** and never re-rank them when a filter changes the series count.

| Token | Hue | Light | Dark |
|---|---|---|---|
| `--chart-1` | plum (single-series default) | `#b0408a` | `#c565a3` |
| `--chart-2` | apricot | `#d9791f` | `#cc7d2e` |
| `--chart-3` | teal | `#17969a` | `#27a0a0` |
| `--chart-4` | coral | `#dd5a55` | `#d8655f` |
| `--chart-5` | periwinkle | `#5673dd` | `#6a82e2` |
| `--chart-6` | green | `#3c955a` | `#4ba168` |

Provider series are fixed: `--chart-anthropic` (= chart-2), `--chart-openai` (= chart-3), `--chart-other`
(grey). `<ModelBadge>` uses the same colours, so a provider is the same colour in a chart and on a chip.
Grid lines: `--chart-grid`. Text on and around a chart is always a text token, never a series colour.

**A hue means one thing.** Two more families keep categories apart from providers, so teal is never both
"OpenAI" and "a tool call" on adjacent panels:

| Family | Tokens (utilities `bg-kind-*`, `bg-mix-*`) | Means | Used on |
|---|---|---|---|
| Kinds of work | `--kind-model` plum · `--kind-tool` indigo · `--kind-app` lilac · `--kind-wait` neutral | What the agent was doing | The timeline's bars and legend, tool-call bars on an eval trial |
| Kinds of token | `--mix-cached` · `--mix-input` · `--mix-write` · `--mix-output` (one ink ramp, lightest for the cheapest token) | What was paid for | The session panel's token mix and Usage's, in the same order: cached input, new input, cache writes, output |

A provider colour never stands for a category and a category colour never for a provider. Waiting on a
schedule is neutral (it is not work); waiting on a person is `--warning-solid`; a failure is `--danger-solid`.
Both families pass the dataviz validator over every pair in both themes
(`_rig/notes/muse/tools/r1-sessions/palette.mjs`).

### 2.4 Type

One family: **Hanken Grotesk** (vendored variable font, `src/assets/fonts/hanken-grotesk`, OFL). Mono:
**JetBrains Mono** for ids, code, tool input and output. Numbers are tabular everywhere (set on `body`).

Each role is one utility that sets size, line-height, tracking and weight.

| Utility | Size / line | Weight | Role |
|---|---|---|---|
| `text-display` | 40 / 1.08, −0.03em | 560 | The Home greeting. Login headline. Nothing else. |
| `text-h1` | 26 / 1.2, −0.022em | 600 | Page title (`PageHeader`), record title (`DetailHeader`) |
| `text-h2` | 18 / 1.35, −0.012em | 600 | Section title (`Section`), dialog title |
| `text-h3` | 15 / 1.4, −0.006em | 600 | Card title (`SectionCard`), agent name on a card |
| `text-prose` | 15.5 / 1.65 | 400 | Conversation prose, long descriptions, instructions |
| `text-body` (`text-sm`) | 14 / 1.55 | 400 | Default UI text |
| `text-small` | 13 / 1.5 | 400 | Table cells, secondary text, control labels (`font-medium`) |
| `text-caption` (`text-xs`) | 12 / 1.35 | 400–500 | Captions, chips, table heads, meta |
| `text-micro` | 11 / 1.3 | 500 | Kbd, count pills, mono ids in chips |
| `text-hero` | 36 / 1, −0.03em | 600 | The one number a page leads with (Usage's headline) |
| `text-stat` | 28 / 1, −0.025em | 600 | A headline number in a tile (`StatTile`, a suite card, a trial score) |

The role utilities are registered with tailwind-merge in `src/lib/utils.ts`, so `cn("text-h2 text-fg")`
keeps both. If you ever add a `--text-*` role, add its name there too, or `cn()` will treat it as a colour.

**A role's size alone.** Text inside a box that already sets the rhythm (a 32px button, a 52px table cell, a
menu item, a count badge, a key cap, an avatar's initials) takes `text-small-size`, `text-micro-size`,
`text-caption-size` or `text-body-size`: the token's size and nothing else, so it keeps the line height of
where it sits. Text that is a block of its own takes the role itself, line height and all. No size is written
as a literal (`text-[0.8125rem]`, `text-[11px]`): the only literals left are an avatar's initials at sizes the
scale does not have, and the Home lead line.

Rules: sentence case everywhere. **No ALL-CAPS labels** and no letter-spaced micro labels. Weights are
400, 500 (`font-medium`), 600 (`font-semibold`); nothing heavier. A section label in the sidebar or a
table head is 12px medium `text-fg-subtle`, not uppercase.

### 2.5 Spacing

4px grid, Tailwind's default scale. The numbers that recur:

| Where | Value |
|---|---|
| Page gutter | `px-5`, `lg:px-8` (use `PAGE_GUTTER`) |
| Page top padding (no breadcrumb bar) | 28px to the title (`PageHeader` does it) |
| Between page sections | `space-y-12` on Home, `space-y-10` on detail pages, `space-y-6` between cards in one section |
| Section title to content | 16px (`Section` does it) |
| Card padding | 20px (`p-5`); roomy hero cards 24px |
| Grid gap between cards | 16px (`gap-4`) |
| Record page columns | main + 340px aside from `xl` (1280px); below that the aside drops under the main column |
| Between controls in a row | 8px (`gap-2`); between chips 6px (`gap-1.5`) |
| Form fields, vertically | 20px (`space-y-5`); label to control 6px; control to hint 6px |
| Table row height | 52px; header 40px; cell padding `px-4`, first/last `px-5` |
| Control heights | 36 default · 32 small · 40 large · 28 only inside cards |

### 2.6 Radius

| Utility | px | Use |
|---|---|---|
| `rounded-full` | pill | Buttons, chips, badges, search field, segmented control, nav "New session" |
| `rounded-xs` | 4 | Kbd |
| `rounded-sm` | 6 | Inline code, focus outline of text links |
| `rounded-md` | 10 | Inputs, selects, textareas (`rounded-lg`), menu items, nav rows |
| `rounded-lg` | 14 | Popovers, menus, tool rows (`EventCard`), callouts, code wells (`rounded-md` inside) |
| `rounded-xl` | 18 | **Cards** (`SectionCard`, `AgentCard`, `StatTile`, table card) |
| `rounded-2xl` | 24 | Composer, dialogs, the shell panel, user message bubble |
| `rounded-3xl` | 32 | Login card |

Avatars are squircles with their own radii per size (see `AgentAvatar`). Nested radii get smaller as you
go in: a 14px block inside an 18px card, a 10px well inside a 14px block.

### 2.7 Elevation and borders

| Token | Light | Dark | Use |
|---|---|---|---|
| `shadow-[var(--shadow-xs)]` | 1px soft | 1px top glint | Inputs, outline buttons, selected segment |
| `shadow-[var(--shadow-sm)]` | soft 2-layer | drop + top glint | Cards (via `surface`) |
| `shadow-[var(--shadow-md)]` | wide soft | deep drop + hairline ring | Popovers, menus, toasts, the composer, hover-lift |
| `shadow-[var(--shadow-lg)]` | deep | deepest + ring | Dialogs, sheets, focused composer |
| `shadow-[var(--shadow-focus)]` | 3px plum 18% | 3px plum 26% | Focus halo on inputs |

Shadows are tinted with ink, never neutral grey. In dark, elevation is read from the surface step and a
1px top glint; shadows only help overlays. Two utilities bundle the recipes:

- `surface` = `bg-bg-surface` + hairline + `shadow-sm` → every card. Add the radius yourself: `surface rounded-xl`.
- `surface-raised` = `bg-bg-raised` + hairline + `shadow-md` → custom popover-like panels.

A bare `border` is already a Muse hairline (the default border colour is `--border`).

### 2.8 Motion tokens

`--dur-quick` 120ms (hover, press, colour) · `--dur-base` 180ms (menus, toggles, chevrons) · `--dur-slow`
240ms (dialogs, page content entering). Easing: `--ease-rise` `cubic-bezier(0.22, 1, 0.36, 1)` for
everything that enters or moves; plain `ease-in` for exits. Utilities: `transition-quick`,
`transition-base`, `animate-rise-in`, `animate-fade-in`, `animate-pop-in`, `stagger`, `lift`, `press`. See §6.

---

## 3 Frame and layout

```
┌ stage (bg-bg-sidebar) ───────────────────────────────────────────────┐
│ sidebar 272px │ ╭ panel (bg-bg, rounded-2xl, 8px inset) ───────────╮ │
│               │ │ top bar 48px   only when there is a breadcrumb    │ │
│               │ │                trail, or the sidebar is hidden    │ │
│               │ │ header slot    <PageHeader> portals here (fixed)  │ │
│               │ │ <main>         the only scroll container          │ │
│               │ ╰───────────────────────────────────────────────────╯ │
└──────────────────────────────────────────────────────────────────────┘
```

**Sidebar** (`AppSidebar.tsx`), top to bottom: brand + collapse (⌘B) · **New session** · Search (⌘K) ·
primary nav (Home, Agents, Sessions, Operations with a count) · **Frequent** agents · **Recents** (one flat
list of sessions with a status dot; the agent and the day are in each row's tooltip) · **Workspace** (Run /
Build / Connect / Settings: four rows that each open a menu beside them) · workspace switcher + account menu
(theme lives there).

How it behaves:

- **One layout. Nothing appears, opens or moves because of the route.** The only thing navigation changes
  is which row is drawn as current. A Workspace page makes its **group's row** current, and the row names the
  page ("Build · Vaults"). Proven by `_rig/notes/muse/tools/r1-shell/sidebar_probe.mjs` on 15 routes at four
  heights in both themes.
- **Nothing is hidden, and nothing is cut.** A Workspace group that is not current lists what it holds in as
  many whole names as fit, then a count ("Deployments, Evals +2"), measured against the real text. Opening a
  group shows every destination with its `g` chord in a menu of real links (⌘-click works); it is not an
  accordion, so the lists above never move.
- **The lists are sized from the window's height only** (`planLists`): Recents keeps four rows before Frequent
  takes any and five before Frequent grows past two agents, then takes every whole row left. 1080 tall: 4
  agents + 10 sessions · 900: 4 + 5 · 800: 2 + 4 · 720: 5 sessions. Recents always ends on a whole row, has no
  fade at rest, and scrolls inside itself with snap. "View all" opens Sessions.
- **Frequent never hides an agent without a word.** When the plan leaves it fewer rows than it has agents,
  its label carries "N more" beside New agent (as Recents carries View all); it opens a menu beside the
  sidebar with the agents that have no row (avatar, running dot) and All agents. It costs no row.
- **A list that could not be loaded is one line and Retry** ("Could not load"), and the plan gives it one
  row: no blank rows under it, and the other list may use the room. Retry shows the loading rows again.
- **Collapsed, it is a 52px rail of icons** with the same menus and tooltips, remembered across reloads. On a
  phone it is a sheet that closes when you go somewhere.
- The Operations count is approvals, open access and skill requests, and failed work (`counts.attention`).
  Home's "Needs attention" and the Operations tabs show the same number, because all three read the report
  through `components/operations/model.ts` and the requests through `useSessionReadings()`. A session whose
  log could not be read is not in the number; the badge's tooltip names it (and the badge is "?" when nothing
  else is counted), and its Recents dot is grey.
- **Skip to content** is the first tab stop on every page. It lands on the panel, not on `<main>`, because a
  list's title, primary button and filters are portalled above `<main>`.

Destinations are defined once in `components/navigation.tsx` and feed both the sidebar and the command
palette. To add a route: add it to `PRIMARY_NAV` or a `WORKSPACE_NAV` group with an icon no other
destination **or group** uses, and give it a `g` chord in `lib/route-chords.ts`. Every sidebar destination
has one except the three third-party integration pages. Home is `g h` (`g d` still works, unlisted).

**Command palette** (`CommandPalette.tsx`). With nothing typed: Actions (New session, New agent) · Go to
(every destination, with its chord) · Agents · Recent sessions · Appearance (only the themes you are not on,
last). Typed: one ranked list across kinds (`lib/palette-rank.ts`, tested): exact name, name prefix, word
start, name contains, then keywords and descriptions, then ids; each row says what it is. cmdk's own fuzzy
filter is off. The palette knows agents, pages and the latest 100 sessions, and says so when it finds nothing.

**Tab titles** come from the breadcrumb trail (`useRouteTitle`): "Sessions · Orrery", "PR Reviewer · Orrery",
"Publish an agent · Slack · Orrery". A page does not set its own.

**Unknown addresses** render `pages/NotFound.tsx` inside the shell: the address, Go home, Search, and the
destination it most resembles. Nothing redirects silently.

**Top bar.** Top-level pages have none: the page title is the first thing in the panel. A nested route
(`/agents/:id`) gets a 48px bar with the breadcrumb. Record crumbs show the record's **name**, resolved
through the directory: publish `handle: { crumb: (m) => entityCrumb("agent", m, "Agent") }` in `main.tsx`.
A record the directory does not know (an integration workspace) names its own crumb from inside the page with
`useCrumbLabel(name)`. The last crumb takes the room that is left before it truncates; middle crumbs cap at
240px. Sub-pages nest under their record, so the trail reads "Agents › PR Reviewer › Setup".

**Page widths.** Every page (except the two full-bleed ones, Home and Session detail) is wrapped in
`<Page width>`; pass the same `width` to `<PageHeader>`.

| `width` | max | Use |
|---|---|---|
| `narrow` | 760px | Forms, settings, wizards, single-column reading |
| `default` | 1120px | Record pages, mixed content, dashboards |
| `wide` | 1440px | Tables and galleries (`DataTable` and `ListPage` default to it) |
| `full` | none | Canvases that manage their own width |

**One left edge.** Top-level pages (no breadcrumb above them) all start on the left side of one 1440px frame
centred in the panel: x=305 at 1280 and 1440, x=404 at 1920, whatever their `width`. A narrower page is capped
at its width on that edge; it is never centred by itself, so going from Sessions to Usage to Workspace does not
move the title. Record pages (under a breadcrumb) centre once the panel has 80px to spare on each side;
until then they sit on the same edge as the list they were opened from. `Page`, `PageHeader` and `DataTable`
all take their column from `usePageColumn(width)` (`Page.tsx`); never `mx-auto` a page column yourself.
Check 1280, 1440 and 1920 with `_rig/notes/muse/tools/r1-shell/edge_probe.mjs`.

**Stacking.** The panel, its header and `<main>` deliberately set **no z-index**. Do not add one, and do
not put `isolate`, `transform`, `filter` or `backdrop-filter` on a page wrapper: it traps dialogs under
the sidebar. Overlays always go through `Modal`, `ConfirmDialog`, `Sheet`, `Popover` or `DropdownMenu`
(all portalled). For a decorative layer behind content, put it first in DOM order with `absolute` and no
z-index, and make the content `relative`.

---

## 4 Components

Import from `@/components/kit` unless noted. Every component has a doc comment with the full prop list.

### 4.1 Identity

| Component | Use it for |
|---|---|
| `AgentAvatar` | An agent. A squircle with **a glyph in a tint**: the agent's face. Pass `id` and `name`; the avatar finds the rest in the workspace directory. The face is, in order: `metadata.avatar` on the agent (chosen in the avatar picker of the create and edit dialogs, or carried over from the template it was made from), else read from its name and description (`lib/agent-face.ts`, 64 glyphs), else two initials. The tint says the kind of work (customers, operations, engineering, research, communication, business: the six `.tint-N` classes). Two agents never look the same: the newer of two identical faces moves to the furthest free tint (`faceBook`). `face` is for things that are not agents yet (templates). Sizes `xs` 20 (sidebar, inline refs) · `sm` 24 (chips, card headers) · `md` 32 (table rows) · `lg` 40 (cards) · `xl` 56 (record header) · `2xl` 72. `archived` removes the tint. |
| `EntityAvatar` | Any other resource: a neutral squircle with that resource's icon (the same icon as its nav item). Tones `neutral` (default), `surface`, `wash` (hero only). **No colour per resource type.** |
| `Avatar` | People (round, ink) and workspaces (`squared`). Up to two initials, the same rule as agents. |
| `AppIcon` | A third-party app: its vendored brand glyph in the text colour (`components/brand-marks.ts`, simple-icons, CC0), or its initial. **Never a remote image.** `tone="surface"` on gallery cards. |
| `EntityRef` | A reference to another record **by name**. Resolves `kind` + `id`, links to the record, id in the tooltip. `variant="chip"` for a pill. Pass `name` when you already have it. |
| `IdChip` | The record's id: shortened, mono, click to copy. `full` for the whole id. **Once per record, in its Details card** (not in the header as well). |
| `CopyButton` | Icon-only copy for any value. Feedback is the icon turning into a check, not a toast. |
| `ModelBadge` | A model as people say it ("Opus 4.8", "GPT-5.5 mini") with a provider dot; raw id in the tooltip. `variant="plain"` in table cells. |
| `RelativeTime` | **How a time is shown** in lists, cards and headers: "3h ago", absolute on hover. The one exception is inside a conversation, under a day divider, where turns show the time of day ("5:58 AM", full timestamp on hover): the day is already said once. |

```tsx
<EntityRef kind="environment" id={agent._oma?.default_environment_id} />
<EntityRef kind="agent" id={s.agent.id} name={s.agent.name} />            {/* no lookup */}
<EntityRef kind="vault" id={id} variant="chip" />
<span className="text-fg-muted">Updated <RelativeTime value={agent.updated_at} /></span>
<IdChip id={agent.id} />
```

Kinds `EntityRef` knows: `agent`, `session`, `environment`, `vault`, `memory_store`. To add one, extend
`ENTITY_META` in `lib/directory.ts`.

### 4.2 Status and labels

| Component | Use it for |
|---|---|
| `StatusBadge` | The state of a thing. `variant="dot"` (default) in tables and rows; `variant="soft"` (tinted pill) in headers and on cards. Pass the raw status string; the vocabulary maps it to a tone and a label. |
| `StatusDot` | The dot alone, where there is no room for a label (sidebar rows). Pair with `sr-only` text. |
| `Chip` | A fact on a record: "3 apps", "v4", "Slack". Neutral by default; `tone="outline"` for versions; a status tone only if the fact is a state. `icon` takes a lucide component. |
| `Kbd` | Keyboard hints. `keys={["⌘","K"]}` for a chord, add `then` for a sequence. |
| `Tip` | One-line tooltip. Required on every icon-only button and every truncated value. |
| `Callout` | An inline notice in a page or card (`neutral`, `info`, `success`, `warning`, `danger`), with an optional action. `warning` is amber and amber means a person is needed; a state at rest (archived) is `neutral` with the archive icon. |

Status vocabulary (extend `STATUS` in `Badge.tsx`, do not pass ad-hoc tones):

| Key | Label | Tone |
|---|---|---|
| `running`, `provisioning`, `in_progress` | Running / … | info, live halo |
| `idle` | Idle | neutral |
| `approval` | Needs approval | warning |
| `rescheduling` | Retrying | warning, live halo |
| `pending`, `degraded` | … | warning |
| `queued` | Queued | neutral (waiting on a runner, not a person) |
| `errored`, `failed`, `error`, `dead_letter`, `expired`, `revoked` | Failed / … | danger |
| `active`, `enabled`, `ready`, `online`, `connected`, `completed`, `passed`, `published` | … | success |
| `terminated` | Ended | neutral |
| `archived`, `disabled`, `draft`, `offline`, `cancelled` | … | neutral |
| publications: `live` · `pending_setup`, `credentials_filled`, `awaiting_install` · `needs_reauth` · `unpublished` | Live · Setup not finished, Ready to install, Waiting for install · Needs reconnecting · Unpublished | success · warning · danger · neutral |
| skill scans: `curated`, `approved` · `flagged`, `quarantined` · `blocked`, `rejected` | Curated, Approved · Flagged, Awaiting review · Blocked | success · warning · danger |
| eval verdicts: `flaky` · `ungraded` (with `passed`, `failed`, `error`, `running`, `queued` above) | Flaky · Not graded | warning · neutral |

A slice may add words around a state (what a scan result means, what a verdict counts) but never its own
label or tone.

For sessions, draw the one reading (§10): `const { read } = useSessionReadings()`, then
`<SessionStatus reading={read(s)} />` (or `SessionStatusDot` where there is no room for a label). It trusts
the server's status, says "Needs access" or "Waiting on you" for an unanswered access or skill request as it
does for an approval, and "Stalled" for work that claims to run but has been silent for half an hour. A
session whose log could not be read is **State unknown** (grey, neutral): "Its events could not be read, so
whether it is waiting on you is not known", or "Its history is too long to check here…" past the read budget.
It is never shown as Idle and never dropped from a list in silence: the Sessions list counts it in a
"1 not checked" chip (Try again), Home lists it under Needs attention (and then never says "Nothing is
waiting on you"), Operations has a "Could not be checked" card with Try again. Never work a session's state
out anywhere else.

```tsx
<SessionStatus reading={read(s)} />
<StatusBadge status="active" variant="soft" />
<Chip icon={PlugIcon} title="Connected apps: Linear, Slack">2 apps</Chip>
<Chip tone="outline" mono>v{agent.version}</Chip>
```

### 4.3 Buttons and small controls (`@/components/ui/button`, kit)

`Button` is a pill. Pick the variant by role:

| Variant | Role |
|---|---|
| `default` | **The** primary action. Ink. One per view, placed last (rightmost). |
| `outline` | Secondary actions next to a primary. |
| `secondary` | Soft fill. Tertiary or in-card actions. |
| `ghost` | Toolbar buttons, icon buttons, Cancel. |
| `destructive` | The confirm button inside a `ConfirmDialog`. Never a resting button on a page. |
| `link` | Inline plum link. |

Sizes: `default` 36 · `sm` 32 (inside cards and card headers) · `lg` 40 (hero) · `xs` 28 (dense, inside
cards only) · `icon`, `icon-sm`, `icon-lg`, `icon-xs` (circles; always with `aria-label` and a `Tip`).
`loading` shows the three-dot loader and disables the button; pair it with `useAsyncAction`. A disabled
primary is a quiet neutral pill (`bg-bg-pressed`), not ink at half strength.
A leading icon gets `data-icon="inline-start"`.

**One ink button per view, including first runs.** When a list is empty for the first time, the empty
state's action is the ink button and the header's create button steps back to outline (`DataTable` does this
when you pass `filtered`; the integration lists do the same). Header actions on a record carry a leading icon.

**Text links** come from `lib/links.ts`, never from a hand-written class string. Every one has a target of at
least 24px that does not move the text (a pseudo-element reaches past the glyphs):
`inlineLink` (plum, inside a sentence or a row of text) · `standaloneLink` (plum, on a line of its own, 32px) ·
`quietLink` (the text colour with a grey underline, for a small action that is not a destination: "Show more",
"Try again") · `linkHitArea` (the target alone, for a link that keeps its own look). Links in prose that can
wrap (Markdown, a dialog's subtitle) grow by inline padding instead, which follows a link across a line break.

`SegmentedControl` — two to five mutually exclusive choices that apply at once (view switch, range, theme).
`iconOnly` moves labels to tooltips. `Switch` (`ui/switch`) — an on/off setting that applies immediately.
`Checkbox` — a choice inside a form that is submitted later.

### 4.4 Page structure

| Component | Use it for |
|---|---|
| `Page` | The page container: width + gutter. `header` takes a `PageHeader`. |
| `PageHeader` | The fixed header of **list and index** pages: `title` (defaults to the route's crumb), `subtitle`, `actions`, `toolbar`. |
| `DetailHeader` | The header of a **record** page, in the page flow: `avatar`, `title`, `status`, `description`, `meta` chips, `actions`, `menu`, optional `wash` (portalled to the panel backdrop, so it runs edge to edge; `wash="inline"` only inside a card), and `children` for the `TabBar`. |
| `TabBar` + `useTabParam` | Underlined section tabs for a record page; the tab lives in `?tab=`. |
| `Section` | An unboxed page section: `text-h2` title, optional description, optional `action` on the right. |
| `SectionCard` | The standard card with a header: `title`, `description`, `actions`, `flush`, `footer`. |
| `Card` | The bare card surface (`interactive` adds the hover lift). |
| `PropertyList` + `Property` | Label–value facts. Values are components (`EntityRef`, `ModelBadge`, `RelativeTime`, `IdChip`), not raw strings. `columns={2}` for wide cards; `labelWidth="narrow"` in a 340px aside or a side panel. |
| `PanelGroup` | One labelled group in a side panel (`Sheet`, the session's details panel): a 12px label, an optional control, the content. Stack with `space-y-6`. |
| `SettingRow` | One setting: label and description left, control right. Stack inside `<SectionCard flush>`. |
| `Steps` | Wizard progress (2–5 steps). |
| `Wash` | The signature gradient (§4.9). |

```tsx
<Page width="default">
  <DetailHeader
    avatar={<EntityAvatar icon={BoxIcon} size="xl" />}
    title={env.name}
    status={<StatusBadge status="ready" variant="soft" />}
    description={env.description}
    meta={<><Chip>Daytona</Chip><Chip>Python 3.12</Chip></>}
    actions={<><Button variant="outline"><PencilIcon data-icon="inline-start" />Edit</Button><Button>Start session here</Button></>}
    menu={<RowActionsMenu actions={[{ label: "Archive", … }, { label: "Delete", destructive: true, … }]} />}
  >
    <TabBar label="Environment sections" value={tab} onChange={setTab} tabs={[…]} />
  </DetailHeader>
  <div className="mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
    <SectionCard title="Sandbox" description="What sessions start from.">…</SectionCard>
    <SectionCard title="Details">
      <PropertyList labelWidth="narrow">
        <Property label="Provider">Daytona</Property>
        <Property label="Created"><RelativeTime value={env.created_at} /></Property>
        <Property label="Environment id"><IdChip id={env.id} full /></Property>
      </PropertyList>
    </SectionCard>
  </div>
</Page>
```

### 4.5 Lists

| Component | Use it for |
|---|---|
| `DataTable` | **The list page.** Owns title row, toolbar, pinned column header, rows, loading, **failed** (`error` + `onRetry`), empty, infinite scroll, column visibility, sorting, and an optional gallery layout (`layout="grid"` + `renderCard`). Pass `filtered` when a search or filter is narrowing the list. With no rows and nothing to filter by it draws no toolbar. One native table: the headings are real `<th scope="col">`; the strip pinned above the scroll area is presentational. |
| `RowLink` | The record's name as the link that opens its row. Put it in the identity cell of a table that has `rowHref` (a page) or `onRowClick` (a panel or dialog). |
| `OverflowTip` | A tooltip only while its child is actually cut, with a tab stop only then. `RowLink` uses it; use it for any cell text that can be cut. |
| `ListToolbar`, `SearchInput` | The one-row toolbar: search · filter chips · (space) · summary · view controls. `DataTable` builds it for you. |
| `FilterChip`, `CreatedFilterChip`, `FacetedFilter` | Structured filters. Dashed at rest, solid with a value and a clear ×. Each maps to a real server query param. |
| `RowActionsMenu` | The "more" menu at the end of a row, on a card, or as `DetailHeader menu`. `destructive` items are separated and red. |
| `AgentCard` | The record card (a gallery of agents). Sessions are rows everywhere: in a table, on Home, in the sidebar. |
| `LoadMoreSentinel` | Infinite scroll trigger for custom lists. |

Table rules:
- **Column 1 is the identity cell**: the name in a `<RowLink>` (`font-medium text-fg`) + a secondary line
  (`text-xs text-fg-subtle`). It never shows an id. `enableHiding: false`.
- **A leading mark only when it tells rows apart**: an agent's face, a provider's mark on a model, a file's
  extension, a deployment's agent. A tile that would be identical on every row (a vault, a memory store, an
  environment, an API key, a machine) is left out: the page title already says what the rows are.
- Column sizes are proportions (fixed layout, fills the width). Typical: identity 320–380, text 180–230,
  model 150, status 130, time 120, number 110, actions 56.
- Numbers: `meta: { align: "right" }`, formatted with `formatCost` / `formatCompact`.
- Times: `<RelativeTime className="text-fg-muted" />`. References: `<EntityRef>`.
- Status: `<StatusBadge>` (dot).
- Last column: `id: "actions"`, `<RowActionsMenu>`, `size: 56`, `enableHiding: false`.
- **Rows are links.** Pass `rowHref={(r) => `/things/${r.id}`}` and put the name in a `<RowLink>`: it is a real
  `<a>` stretched over the row from the first cell, so click, ⌘-click, middle-click, "Open in new tab" and
  Tab + Enter all work, and the focus ring is drawn round the row. A row that opens a panel or a dialog passes
  `onRowClick` and gets a `<button>` the same way. Everything else in the row (links, menus, anything with a
  tooltip) is lifted above the stretch without opting in. No `<tr onClick>`, no "View" buttons. A table that
  draws its own rows uses `openRowFromEvent` (the agent's Activity tab does).
- **Sorting is over the whole list or not at all.** `enableSorting: true` makes a heading a sort button. A
  sort on a list that still has pages loads the rest first and says so; above 500 rows it declines and asks
  for a narrower list.
- Cells truncate only as a last resort; anything that can be cut carries an `OverflowTip` (or a `title`), so
  the whole value is readable by hover and by keyboard.
- A long column has a floor (`minSize`, or 62% of its size). When it reaches the floor its neighbours give
  way; the table does not scroll sideways.
- Size columns for the words they hold: Status fits "Needs approval" (150), a name column gets what is left.
  Check 1280 and 1440: a column that truncates beside an empty one is mis-sized.
- On a narrow panel the squeeze is not shared evenly. A short column (160 or less: status, time, a number)
  keeps its declared width, so "Needs approval" and "yesterday" are never cut to an ellipsis; the long
  columns give way. Past that, a column marked `meta: { hideBelow: 760 }` (a value that is also on the record
  page) is dropped, so at 1024 a table shows fewer columns whole instead of scrolling sideways.
- The toolbar never overlaps itself: the chip row scrolls on a narrow panel and the summary waits for `xl`.
- Galleries must not repeat themselves: skills take a subject icon from their name (`skillIcon`), templates
  wear the glyph their agent will keep (`face` in `lib/agent-templates.ts`), apps their own mark. Gallery
  grids count columns from the room they have (`GALLERY_GRID`: 2 at 1024, 3 at 1280 and 1440, 4 at 1920).
- A skill is shown to people, not to the model: `humanSkillName` and `skillSummary`
  (`components/resources/skills.ts`) give it a name people say ("Word documents") and one whole sentence. The
  author's own text is one click away, under "When agents use it". The same reading is used on the skill
  request card in a session.

```tsx
const columns: ColumnDef<Vault>[] = [
  { id: "name", header: "Vault", size: 340, enableHiding: false, enableSorting: true,
    cell: ({ row }) => (
      <div className="min-w-0">
        <div className="flex min-w-0"><RowLink className="font-medium text-fg">{row.original.name}</RowLink></div>
        <div className="truncate text-xs text-fg-subtle">{plural(row.original.credential_count, "credential")}</div>
      </div>
    ) },
  { id: "updated", header: "Updated", size: 130,
    cell: ({ row }) => <RelativeTime value={row.original.updated_at ?? row.original.created_at} className="text-fg-muted" /> },
  { id: "actions", header: "", size: 56, enableHiding: false,
    cell: ({ row }) => <RowActionsMenu label={`Actions for ${row.original.name}`} actions={…} /> },
];
// <DataTable columns={columns} rowHref={(v) => `/vaults/${v.id}`} … />
```

### 4.6 Numbers and charts

| Component | Use it for |
|---|---|
| `StatTile` | One headline number: `label`, `value`, optional `delta` (`good` sets the colour, not the direction), `hint`, `spark`, `footer`, `to`. Lay out as `grid gap-4 sm:grid-cols-2 lg:grid-cols-4`. |
| `Sparkline` | A trend beside a number. One series, no axes. |
| `TimeSeriesChart` | A value over time: `type="area" | "line" | "bar"`, `stacked`, hover crosshair + tooltip, legend for ≥ 2 series, sr-only table. `formatValue` for tooltips, `formatTick` for the axis. |
| `BarList` | Ranked categories with names worth reading (spend by model, sessions by agent). Prefer it to a pie. |
| `Meter` | Progress toward a limit; amber at 80%, red at 100%. |
| `ChartLegend` | Swatch + label (+ value). |

Chart rules: choose the form by the job (one number → tile; trend → area/line; parts of a whole over time
→ stacked area or columns; ranking → `BarList`). One y-axis, starting at zero. 2px lines, area fills at
10–16%, columns ≤ 24px with a 4px rounded top and a 2px gap between stacked segments. Series colours in
token order. Every chart sits in a `SectionCard` whose title says what is plotted.

```tsx
<SectionCard title="Spend by provider" description="Estimated API cost per day.">
  <TimeSeriesChart type="area" stacked labels={days} height={240}
    series={[
      { id: "anthropic", label: "Anthropic", color: "var(--chart-anthropic)", values: a },
      { id: "openai", label: "OpenAI", color: "var(--chart-openai)", values: o },
    ]}
    formatValue={formatCost} formatTick={(n) => `$${n}`} formatLabel={shortDay}
    aria-label="Estimated spend per day by provider" />
</SectionCard>
```

### 4.7 Conversation

| Component | Use it for |
|---|---|
| `Composer` | The prompt box. `size="lg"` on Home, `"md"` in a session. Slots: `leading`, `trailing`, `attachments`, `footer`. Send button states: disabled, ready, `submitting`, `running` + `onStop` (stop square). Enter sends, Shift+Enter adds a line. |
| `ComposerNotice` | The notice that sits against a composer: a refused file (named, with the reason), a message that was not sent (the server's reason, Try again), an upload that failed. Both composers use it. |
| `SessionStarter` (`components/home`) | **The one way to start a session** (§9.0): the box, the agent picker, image attachments, Options (environment, vaults, resources, title) and things to ask. Inline on Home, in `NewSessionDialog` everywhere else. |
| `AgentPicker` | Pill + searchable popover to choose an agent. |
| `EventCard` | Everything an agent **does** that is not prose. `kind`: `tool`, `mcp`, `thinking`, `approval`, `error`. |
| `EventSection`, `CodeWell` | Labelled parts of an event body and mono blocks for input/output. |
| `Markdown` | Agent prose (lists, tables, code, links) in Muse styles. |

`EventCard` looks: **tool / mcp** = a 40px soft row (icon · mono name · one-line preview · duration · state
glyph), closed by default, opens to `EventSection`s. **thinking** = bare muted row that folds; shimmers while
running. **approval** = amber-tinted, always open, actions in a footer; it cannot be collapsed. **error** =
red-tinted, always open, optional Retry. See §9.3 for how they compose into a session.

### 4.8 States

| Component | Use it for |
|---|---|
| `EmptyState` | Nothing here. `kind` picks the icon; `size` `sm` (in a card), `md` (a section), `lg` (the whole page, gets the wash). Title names the thing; body says what to do; one action. Filtered-empty offers "Clear filters", not "Create". An `lg` title is a heading (`h2`, or `heading="h1"` when the state is the whole page). |
| `RecordNotFound` | A record that is not there. **One wording for every kind**: "This {thing} does not exist" · "It may have been deleted, or the link is from another workspace." · **Back to {things}**. Agents, sessions, vaults, memory stores, environments, eval runs and connected workspaces all draw it; an unknown address draws its sibling, "This page does not exist". |
| `ErrorState` (`QueryProblem`) | A read failed. `title` says **what** could not be loaded; the reason is a sentence from `failureSentence` (the server's own words when they read as one, otherwise what kind of failure it was, "The server had a problem (“unavailable”)…", never the bare token); `retry` refetches. `compact` for inside cards. |
| `Skeleton`, `SkeletonText`, `SkeletonCard`, `SkeletonDetail`, `SkeletonRows` | Loading with a shape. Match the anatomy of what is coming. |
| `BrandLoader` | Three dots: in buttons and for waits with no shape. Not for page content. |

**Failures are read once** (`lib/failures.ts` `readFailure`): the cause in plain words, then what to do
next, then the provider's exact response folded under "Provider response" (`ProviderResponse`). The session's
error card and the Operations queue both use it, so one failure reads the same in both places. Never print
the same provider sentence twice on a card.

**One failure, one explanation, on every screen.** The session page leads with the model's own error
(`span.model_request_end` with `finish_reason: "error"`) before the runtime's `session.error` message; the
operations report carries only the latter ("No output generated…"). So the cause is read from the log, where
the session page reads it: `log-reading.ts` records it per session (`useSessionReadings().failures`), and
`buildOperationsView(…, causes)` hands it to Failed work, Set aside, Ended on an error, Home's failure rows,
Recently finished and every reading's detail; the session header and the panel's Outcome take it from the
conversation (`Conversation.failure`). Pass `readFailure(cause ?? report error).cause`, never the report's
text alone.

A read of one record that answers 404 raises no toast (`useApiQuery` passes `quietNotFound`): the page draws
its not-found state. A read that is allowed to fail altogether uses `useQuietQuery`. A call that draws its
own failure passes `silentErrors`, and then no toast is raised for it at all, a network failure included.

**Every failure is said in a sentence** (`lib/failure-text.ts`): `failureSentence(err)` for a reason alone,
`withReason("The key could not be saved", err)` for ours and then the server's. No `err.message` reaches the
screen as it is. List hooks hand on the error itself, not its message, so the status can be read.

**A failed read is asked for again by its Retry**, an interval or a refresh, never because another piece that
shows it mounted (`retryOnMount: false` in `useApiQuery`): a screen that draws a piece only once a read has
settled would otherwise ask again on every mount, in a loop.

**A failed read is never an empty state.** "This vault holds no credentials yet" is said only when the read
succeeded and returned none; otherwise the region says what could not be loaded and offers a retry in place
(the session's details panel, the mission band, Home's agent picker all do).

Decision order in every data region: `error` → `ErrorState`; `isLoading` → skeleton; empty → `EmptyState`;
else content. Never `"Loading..."` text, never a blank area, never an empty state while loading.

### 4.9 The wash

`<Wash />` portals the gradient into the panel backdrop: it reaches the panel's top edge and fades away as
the page scrolls. Allowed in exactly four places: **Home**, **login-family pages**, **the agent profile
header** (`<DetailHeader wash>`, which portals `<Wash variant="header" />`), and **page-level empty states**
(built into `EmptyState size="lg"`). Do not put it behind tables, forms, chat or charts. Under
`prefers-reduced-motion` it still fades but no longer drifts.

### 4.10 Overlays and forms

| Component | Use it for |
|---|---|
| `Modal` | A dialog with a form or content: `title`, `subtitle`, `footer`, `maxWidth`. Header and footer stay put; the body scrolls, and shows that it does: a hairline under the header once scrolled, a fade at the bottom while more is below, so a cut line reads as more, never as clipped. `placement="top"` for a dialog that grows beneath a fixed top edge (the session starter's Options); it may grow to 1.5rem above the window's bottom, then scrolls inside. |
| `ConfirmDialog` | Any irreversible or visible-to-others action. Replaces `window.confirm`. |
| `Sheet` (`ui/sheet`) | A side panel for inspecting a record without leaving the list. |
| `Field` | Label + control + hint/error, wired for accessibility. Every form control goes in one. See **the Field contract** below. |
| `Input`, `Textarea` (`ui/*`), `TextInput`, `SecretInput` | Text entry. `SecretInput` for anything sensitive: what is typed is set in mono, the placeholder in the UI face (it is built in; callers set neither). A placeholder that describes rather than shows an example ("Environment id") stays in the UI face on a mono field too. |
| `Select`, `Combobox`, `LocalCombobox` | One of a few (static) · one of many (server-searched) · free text with suggestions. Never a native `<select>`. |
| `DateField`, `TimeField` | A day (typed or picked from a month grid with full keyboard support) and a time of day (typed, forgiving, 24-hour). They hold the same strings a native input would (`YYYY-MM-DD`, `HH:MM`), so they drop in. **Never a native date or time input**: it looks like a different product on every platform. A refused entry says why under the field. |
| `Disclosure` | Fold away rarely-changed options. |
| toasts (`sonner`) | Transient confirmation of something that already happened ("Agent archived"). Never the only place an error is shown. |

**The Field contract.** `Field` hands its control `FieldControlProps`: `id`, `aria-labelledby` (the label,
unless the caller named the control), `aria-describedby` (the hint or error, added to any description the
control already had) and `aria-invalid`. Every composed control takes them and puts them **on the element
that takes focus**: `Select`, `Combobox`, `LocalCombobox`, `PickSelect`, `EnvironmentPicker`,
`SegmentedControl`, `MemoryModeControl`, `DateField`, `TimeField`, `SearchInput`, `TextInput`, `SecretInput`
(its own `label` too). A label click goes through `onLabelClick`: a control that opens a list is focused and
stays closed, as a native select's label does; a radio group focuses its chosen radio; an input keeps the
browser's behaviour. A wrapper that does not pass props on (react-hook-form's `<Controller>`) swallows them:
put the `<Field>` inside its `render`, never around it. A new composed control is not done until a test shows
its label names it (`Field.test.tsx`).

**Tooltips do not open from focus a layer put there.** When a dialog, sheet or popover opens, or focus comes
back from a portalled list, the focused button's tooltip stays closed (`ui/tooltip.tsx`); Tab within the
layer, or pointing, still opens it. So a dialog never opens with a tooltip over its first label. A dialog's
first focus is its first field (Edit agent opens on Name), not an icon button.

**One task form.** Save as eval and New eval run write tasks with the same form and model
(`components/evals/TaskForm.tsx`, `task-draft.ts`): name, messages, rubric, trials, pass mark, time limit, a
card per task, errors on their fields and the first one focused. "Edit as JSON" is the second way in and
round-trips: fields the form does not show are kept, and a task with a simulated user or a composite reward is
kept whole and edited as JSON.

**A model is named as people say it in a field too.** A model field shows "Opus 4.8" at rest, with the
provider and the raw id as its hint ("Anthropic · claude-opus-4-8"), and switches to the id while it is being
edited (`LocalCombobox displayValue`). A description that runs to more than a line is a textarea that starts
at two lines and grows.

---

## 5 Page patterns

### 5.1 List page

```
PageHeader   title · one-line subtitle                         [outline actions] [+ New thing]
             [search…] (Status ⌄) (Created ⌄)                         12 things   [⋮ view]
table card   Thing            Fact        Status     Updated    ⋯
             ● Name           value       ● Active   3h ago     ⋯
               secondary line
```

Use `DataTable`. Give it `title`, a `subtitle` that says what these things are for (one sentence), the
primary `createLabel`/`onCreate`, server-side `search` and `filters`, and the three empty states (first
run with a create action; filtered with "Clear filters"; archived view). A resource with a strong visual
identity (agents, skills, apps) may default to `layout="grid"` with a List switch, as Agents does.

### 5.2 Record (detail) page

```
top bar      Things › Name
DetailHeader [avatar]  Name  ● Status                                   [Edit] [Primary]  ⋯
                       one-line description
                       (chip) (chip) (chip)
             Overview   Activity 14   Settings
content      ┌ main column: SectionCards ───────────┐ ┌ aside 340px ─────────┐
             │ what it is / does                     │ │ Details (… id ⧉ last) │
             │ related lists (flush tables)          │ │ Usage (StatTile/spark)│
             └───────────────────────────────────────┘ └───────────────────────┘
```

`<Page width="default">`, `DetailHeader`, `TabBar` when there are three or more groups of content, then
`mt-6 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]` (from `xl`, not `lg`: with the 272px sidebar open, an
`lg` split leaves a 320px main column; below `xl` the aside drops under and lays its cards side by side).
Facts go in a `PropertyList` in the aside; long text
gets its own `SectionCard`; child collections are `SectionCard flush` with a compact table or list and an
"Add" button in the card header. Loading: `<SkeletonDetail />`. Missing record: `EmptyState size="lg"` with
"Back to Things". Nothing is permanently open that is used rarely: creation forms open in a `Modal`.

### 5.3 Settings / form page

`<Page width="narrow">` with a `PageHeader width="wide"` title and subtitle: the header spans the frame like
every other top-level page's, so its action sits on the one right edge; the cards keep the narrow measure
(Workspace). A stack of `SectionCard`s (`space-y-6`),
one per topic. Inside: `Field`s (`space-y-5`) for values saved together, with the Save button in the
card's header `actions` or a footer row (`flex justify-end gap-2 pt-5`); or `SettingRow`s in a
`SectionCard flush` for switches and selects that apply immediately. Dangerous settings go in a last card
titled "Danger zone" with `variant="outline"` buttons that open a `ConfirmDialog`. Show save progress on
the button (`loading`), success as a toast, failure as a `Field` error or a `Callout tone="danger"`.

### 5.4 Dialog

`Modal` with a title that is the action ("New vault"), a one-line `subtitle`, `Field`s, and a `footer`:
ghost **Cancel** on the left of the ink primary whose label repeats the action ("Create vault"). Widths:
`max-w-md` confirmations, `max-w-lg` (default) short forms, `max-w-2xl` rich forms, `max-w-4xl` pickers.
The primary is disabled until the form is valid and shows `loading` while submitting. Do not nest dialogs.

### 5.5 Wizard

For three or more decisions that depend on each other. A `Modal` (`max-w-3xl`) or a `narrow` page with
`<Steps>` at the top, one question per step, **Back** (ghost) and **Continue** (ink) bottom right, and a
final Review step that restates the choices in a `PropertyList`. Completed steps are clickable. Keep state
when going back.

---

## 6 Motion

| Moment | What moves | Duration / curve |
|---|---|---|
| Hover, press, focus | colour, border, shadow; buttons scale to 0.97 on press | `transition-quick` (120ms) |
| Clickable card hover | lifts 1px, `shadow-md`, firmer border (`lift`) | 180ms |
| Menu, popover, tooltip | fade + 97% scale + 4px slide from the trigger | 150ms in, instant-ish out |
| Dialog, sheet | scrim fades; panel fades, rises 8px, scales from 97% | 200–240ms |
| Content entering a page | `animate-rise-in` (fade + 6px rise); lists add `stagger` with `style={{ "--i": index }}` (40ms steps, cap the index at ~12) | 240ms |
| Chevrons, switches, segmented thumb | rotate / slide | 180ms |
| Live state | `StatusDot` halo (`live-dot`), `text-shimmer` on streaming titles, three-dot `BrandLoader` | loops |
| Wash | fades and drifts as the page scrolls | scroll-linked |

Rules: animate `opacity` and `transform` only. Nothing bounces, nothing takes longer than 240ms, nothing
loops unless it means "live". Do not animate layout on data refresh. `prefers-reduced-motion` zeroes the
duration tokens, disables `lift`, `stagger` and the loops, shortens every other transition to 1ms and stops
the wash's drift. It is probed, not assumed: `_rig/notes/muse/tools/director/a11y_probe.mjs` loads pages with
the preference set and reports any transition or loop that survives.

---

## 7 Words

- **Sentence case** for everything: titles, buttons, menu items, table heads. "New agent", not "New Agent".
- Buttons are verbs that name the result: "Create vault", "Start session", "Delete agent". Never "OK", "Submit".
- A session with no title is "Conversation with {agent}". Never "Untitled", never an id (`sessionTitle`).
- Empty values say so in words: "None", "Not set", "No sessions yet". Never a bare dash in a property. In a
  table column whose neighbour already says the row is empty (Memory: Contents "Empty"), the second cell is
  a quiet dash that carries its words in a tooltip and to a screen reader ("Nothing written yet"), so two
  cells do not repeat one fact and neither is cut.
- Times: relative with `RelativeTime`. Dates in prose: "Nov 6, 2026" (`formatDate`).
- Money `formatCost` ("$181.63"), counts `formatCompact` ("151M"), durations `formatSpan` ("6m 50s"),
  plurals `plural(n, "session")`.
- Models by their short name (`ModelBadge`). Harnesses by `harnessLabel`. Never show `agent_toolset_20260401`.
- Errors say what failed, in the product's terms: "Sessions could not be loaded". Then the server message.
- A failed turn says the cause and the next step ("The model provider rejected this workspace's key. Check
  the key for this model in Models, then retry."). The provider's response is folded away (§4.8).
- A session that is trying again after a transient failure is "Retrying", not "Rescheduling".
- Counts that mean the same thing are the same number everywhere (sidebar, Home, Operations).
- No emoji as icons. Icons are lucide, 16px in controls and rows, one stroke weight (1.75, set globally).

---

## 8 Do and don't

**Do**
- Start from `Page`, `PageHeader` or `DetailHeader`, `Section`/`SectionCard`. Compose; do not hand-roll shells.
- Resolve every id on screen with `EntityRef` or the directory hooks.
- Give every icon-only button an `aria-label` and a `Tip`. Keep hit areas ≥ 32px (36 for primary controls).
- Keep one ink button per view. Put archive/delete in `RowActionsMenu` + `ConfirmDialog`.
- Check both themes, and 1280 and 1920 wide, before you call a screen done.
- Keep existing accessible names and roles that tests query (button names, `role="alert"`, tab names).

**Don't**
- Don't use raw hex, `text-[11px]`-style arbitrary sizes, `uppercase`, `tracking-wide`, or `font-bold`.
- Don't use `brand-*` classes, `bg-bg-surface` as a hover (use `hover:bg-bg-hover`), or native `<select>` / `confirm()` / `alert()`.
- Don't draw borders to separate things that space or a soft fill already separates. No zebra stripes, no divider under every heading.
- Don't colour-code resource types, and don't use a status colour for decoration.
- Don't use the wash outside its four places. Don't add gradients, glows or glass.
- Don't put a z-index, `isolate`, `transform` or `backdrop-filter` on page wrappers (§3 Stacking).
- Don't leave a form permanently open in a page, and don't show six count tiles as a dashboard.
- Don't load an image, icon or font from the network. App marks come from `AppIcon`; there is no favicon
  service anywhere in the console.
- Don't show a record's id twice, a provider's sentence twice, or two ink buttons in one view.
- Don't remove a capability to make a screen cleaner: move it into a menu, a tab or a dialog.

---

## 9 Screen blueprints

Each blueprint lists the regions, what is primary, and which components to use. Build exactly this.

### 9.0 Home and starting a session (`/`)

Full-bleed, with the wash. Top to bottom: the greeting (`text-display`) · **the session starter** · Running
now and Needs attention side by side (from 880px of real room; a container query, because the sidebar takes
272px of the window) · Since you were last here · Last 30 days · Workspace counts.

**The session starter** (`components/home/SessionStarter.tsx`) is the one way to start a session.

- The box (`Composer size="lg"`, placeholder "Describe a task…"), the `AgentPicker`, image attachments, and
  **Options**, a section that opens in place under the box (the disclosure expand) and moves the bands below
  it down; it never floats over the page. In `NewSessionDialog` the dialog grows with it from a fixed top
  edge and scrolls inside when the window is short. Runs in (environment), Title, Resources, Vaults; Done,
  Escape (which closes the panel only, never the dialog around it) and a click elsewhere leave the draft
  alone, and Done and Escape put the caret back in the message. The words already typed stay in view above
  it and are sent as the first message. Home does not autofocus the box, so it arrives at rest.
- **The recipient does not change under the person.** A chosen agent (`draftStore.recipient`) always wins;
  otherwise the default worked out from usage the last time the sessions were read stands in while they load
  or fail (`components/home/default-agent.ts`), never "whichever agent was created last".
- **Things to ask**: up to four chips for the chosen agent, derived in the browser
  (`components/home/starters.ts`, tested) from its description, its instructions, its schedules' prompts and
  its past titles. A chip fills the box and never sends. Chips never name the agent: its name appears once
  above the fold, in the picker. A chip that leaves the case open reads as a whole ask ("Review a PR…",
  "Triage a ticket…", "New call summary…"); a long ask shortens after its first whole action and never ends
  on a word that leads somewhere ("and", "of").
- Sending creates the session, uploads images, sends the first `user.message`, then opens the session. If a
  step fails, the words and attachments stay in the box under a `ComposerNotice` that says which step failed;
  trying again continues with the session already created. The draft is kept for the life of the tab.
- Images are the only attachments. Anything else that is picked, pasted or dropped anywhere on the page is
  refused in a notice that names the file and says why. Nothing is dropped silently. What it says next is
  only what is true (`components/files/refusal.ts`, tested): another kind of file reaches an agent from Files,
  mounted in Options when a session starts; a file gets into Files when an agent saves it or through the API,
  which the notice links to in words ("Upload it to Files (how to upload a file ↗)", the docs section on
  uploads, opening beside the page so the draft stays; `UPLOAD_DOCS_URL` in `components/files/refusal.ts`).
  No endpoint is printed in the composer, Options' File hint or Files' empty state. If the very file is already in Files the
  notice mounts it; in a running session it offers a new session. Never "in this build", never a control
  that does not exist.
- If the agents request fails, the box is disabled and says so with a retry. "Create your first agent" is
  shown only when the request succeeded and returned none.

**One flow everywhere.** Nothing navigates to start a session. Every "New session" (the sidebar, the top bar
on a phone, the palette, a page's button, an agent's card and profile, an environment, the band on an ended
session, the `?new=1` links) calls `startSession({ agentId?, environmentId? })` from `lib/shell-events.ts`.
The shell answers it in one place (`NewSessionHost`): on Home the starter that is already there takes focus,
with that agent chosen; on every other page the same starter opens in `NewSessionDialog` over the page you
are on.

**Below the starter**, Home says what the sidebar cannot:

- *Running now*: each running session with a clock counting from the start of its turn and one line of what
  the agent is doing ("Running a command `duckdb …`", "Thinking"), read from the tail of its event log every
  5s (every 30s once silent for 15 minutes, when it says "no activity for 4d" in amber). The one thing on the
  page that loops, and it means "live".
- *Needs attention*: the same reading and the same count as the sidebar badge and Operations.
- *Since you were last here* (or "Recently finished" on a first visit): finished sessions with the agent's
  own closing words, or "Failed" with the cause in plain words.
- *Last 30 days*: the window and the numbers of the Usage page (`lib/usage-window.ts`: whole UTC days, the
  period before is the same length), so Home and Usage always agree. Sparklines are one colour.

### 9.1 Agent detail — "the profile" (`/agents/:id`)

`<Page width="default">`. Loading `<SkeletonDetail />`.

**Header** — `<DetailHeader wash>`:
- `avatar`: `<AgentAvatar size="xl" />`. `title`: agent name. `status`: `StatusBadge variant="soft"`
  (`running` if it has running sessions, else `active`; `archived` when archived).
- `description`: `agent.description`, or a muted "No description yet." with an Edit affordance.
- `meta`: `<ModelBadge>` · capability chips from `agentCapabilities(agent)` (`lib/agents.ts`) ·
  `<Chip tone="outline" mono>v{version}</Chip>`. The id is in Details, once.
- `actions`: `<Button variant="outline">Edit</Button>` then **`<Button>Start session</Button>`** (primary;
  `startSession({ agentId })`, which opens the starter over the profile with this agent chosen and its
  Options at hand). If `metadata.long_running`, "Run until done" is an outline button before Edit.
- `menu` (`RowActionsMenu`): Deploy, Open setup chat, Copy agent id, Archive, Delete (destructive). Archive and
  Delete go through `ConfirmDialog`. Every legacy action stays reachable; only Start session is ink.
- An archived agent shows `<Callout tone="neutral" icon={ArchiveIcon} title="This agent is archived">` under
  the header (neutral: archived is a state at rest; amber is kept for "a person is needed"). Vaults, memory
  stores and environments do the same.
- The Edit dialog and the new-agent dialog carry the avatar picker, left of Name. A choice is stored in
  `metadata.avatar` through the existing agent endpoints; "Automatic" clears it.

**Tabs** — `TabBar` + `useTabParam("overview")`: **Overview · Activity (n) · Triggers (n) · Versions (n) · Access**.

**Overview** — `grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]`:
- Main: `SectionCard "Instructions"` (the system prompt in `text-prose whitespace-pre-line`, clamped to ~12
  lines with "Show all"; Edit in the card header) · `SectionCard "Tools and apps" flush` (one row per
  MCP server / tool group / skill: `EntityAvatar` + name + permission policy as a `Chip`) ·
  `SectionCard "Works with"` when `multiagent` (the delegated agents as `EntityRef`s) ·
  `SectionCard "Integrations" flush` (Linear, GitHub, Slack rows: brand icon, name, `StatusBadge`
  `published`/neutral "Not published", action on the right).
- Aside: `SectionCard "Details"` with a `PropertyList labelWidth="narrow"`: Model (`ModelBadge plain`),
  Reasoning, Runs on (`harnessLabel`), Memory; then **Runs with** (environment, vaults and memory store as
  full-name rows that link to the record, because a label–value grid cut every name at 340px); then Created,
  Updated (`RelativeTime`), Agent id (`IdChip full`). Then `SectionCard "Last 30 days"`: sessions count with a
  `Sparkline`, last active.

**Activity** — the agent's sessions in a compact flush table (title as a link, `StatusBadge`, started),
newest first, with "Open in Sessions" linking to `/sessions?agent_id=`. A click anywhere on a row opens it with
the modifiers a link understands (`openRowFromEvent`). Empty: `EmptyState kind="session"` with **Start session**.

**Triggers** — ambient rules. A list of rule cards (name, trigger summary in words, next run as
`RelativeTime`, a `Switch` for enabled, `RowActionsMenu` for delete) and an **Add trigger** button in the
tab's trailing slot that opens the rule form in a `Modal`. The "New Rule" form is never open in the page.

**Versions** — version history rows (`v3` chip, who/when, summary) with compare (the existing
`AgentVersionComparison`) in a `Sheet` or below the list.

### 9.2 Sessions list (`/sessions`)

`DataTable`, `title="Sessions"`, `subtitle="Every conversation your agents have had."`, primary
`+ New session` (`startSession()`: the starter opens over the list). `?new=1`, `&agent_id=` and
`&environment_id=` are links that open it with that choice made.

Columns: **Session** (identity: `AgentAvatar md` of the session's agent + the title in a `RowLink` + a
secondary line "{agent name} · {source} · {environment}"; source badges for Linear/Slack/Eval are the brand
icon, no emoji) · **Status** (`SessionStatus` with the one reading, `useSessionReadings().read(s)`) · **Environment** (`EntityRef`; a
column only where it fits beside a whole title, a table of 1220px or more, otherwise it is on the secondary
line) · **Duration** (right-aligned, sortable) · **Last activity** (`RelativeTime`, sortable) · actions (Copy
link, Copy session id, Archive, Delete). The title takes the room: no title is cut at 1280, 1440 or 1920.

Filters: Agent (`Combobox` inside a `FilterChip`), **Status** with the six states the column shows (Needs
approval, Failed, Running, Retrying, Idle, Ended), Started (custom range with `DateField`), Archived. Running,
Retrying, Idle and Ended are the server's `?status=`. Needs approval and Failed are derived, as the column
derives them, from the operations report: the sessions it names are read by id, so the result is complete and
not a scan of the pages loaded so far. A runtime without the report does not offer the two. Sorting by title,
Duration or Last activity loads the remaining pages first (§4.5). Summary: "27 sessions", with an amber
"1 needs approval" link. The search, the filters and the sort live in the address (`?q=`, `?agent_id=`,
`?status=`, `?archived=show`, `?sort=`): a filtered list survives a reload and can be linked. Every list
counts in words: "12 vaults", or "More than 200 vaults" when another page exists (`countWords`), never "200+".

A session whose title the server wrote from an id (a mission's iteration, "Mission mis-… · iteration 3") is
shown as "Run until done · iteration 3" here and everywhere (`sessionTitle`).

Empty: `EmptyState kind="session"`, action **New session** → `startSession()`.

### 9.3 Session detail — the centrepiece (`/sessions/:id`)

Full-bleed (no `Page`). Three regions inside the panel; only the conversation scrolls.

```
top bar       Sessions › {title}
session bar   [avatar] Title  ● Running      [Conversation | Timeline]        [Save as eval] [⋯] [▯ panel]
              Finance Ops Reconciler · via Linear SUP-482 · started 3d ago · 6m 50s
┌ conversation column (scrolls) ──────────────────────────────┐ ┌ context panel 320px ─┐
│            centred, max-w-[720px], px-6, py-8                │ │ Agent                │
│                                          ╭ user bubble ╮     │ │ Environment          │
│ [av] Agent name · 3d ago                                     │ │ Vaults               │
│ thinking row                                                 │ │ Files                │
│ tool rows                                                    │ │ Usage                │
│ prose (Markdown, text-prose)                                 │ │ Outcome              │
│ approval card                                                │ └──────────────────────┘
│ ╭ Composer (md), sticky bottom, same 720px column ╮          │
└──────────────────────────────────────────────────────────────┘
```

**Session bar** (in `PageHeader`'s slot, custom content): `AgentAvatar md`; title `text-h2` (the session
title via `sessionTitle`; editable if it is today); `StatusBadge variant="soft"`; second line in
`text-small text-fg-muted`: agent as `EntityRef` · environment (only while the details panel is closed; the
panel names it in full) · source (an eval run by its name) · `RelativeTime` · `formatSpan`. Right: the view
switch as pill `Tabs` (**Conversation | Timeline**; keep the tab names), then ghost/outline actions (Save as
eval, Stop when running — Stop is `outline`, never ink), a `RowActionsMenu` (Trajectory, Files, Copy session
id, Archive), and an icon button that toggles the context panel. The mono chip row of the baseline is
gone: those facts live in the context panel as names.

**Conversation column**: `mx-auto w-full max-w-[720px]`, turns separated by `space-y-6`, items inside one
agent turn by `space-y-3`.
- **User turn**: right-aligned bubble
  `max-w-[85%] rounded-2xl rounded-br-md bg-bg-soft px-4 py-2.5 text-prose text-fg`. Attached images sit
  above it as 64px rounded-lg thumbnails. Pending/queued messages are the same bubble at 60% opacity with
  a "Queued" caption.
- **Agent turn**: a header line once per turn — `AgentAvatar sm` + name (`text-small font-medium`) + the
  time of day (subtle; the day is said once by a divider, the full timestamp is in the tooltip) — then the
  content with **no bubble**: prose through `<Markdown>` at `text-prose text-fg`, interleaved with
  `EventCard`s in the order they happened. A finished turn ends with "Worked for 11s", a hairline, and a
  labelled **Copy reply** button.
- **Thinking**: `<EventCard kind="thinking" title="Thought for 4 seconds">`; `status="running"` while
  streaming ("Thinking…", shimmering).
- **Tool call**: `<EventCard kind="tool" title={name} subtitle={one-line input preview} status meta={duration}>`
  with `EventSection label="Input"` and `"Output"` (`CodeWell`; stderr `tone="danger"`). Consecutive calls
  stack with `space-y-1.5`. More than four in a row collapse to "6 tool calls" that expands.
- **MCP call**: the same with `kind="mcp"` and `source={server name}` ("Linear · create_issue").
- **Approval**: `<EventCard kind="approval" title="{Agent} wants to run {tool}">` with the exact input in a
  `CodeWell` and actions **Allow this call** (ink, `size="sm"`) and **Deny** (outline). It is always open,
  it scrolls into view when it appears, and while one is pending the composer shows a `footer` line
  "Waiting for your approval above". Keep the existing button names.
- **Error**: `<EventCard kind="error">` read through `readFailure`: title = what failed ("The model request
  failed"), subtitle = the cause in plain words, body = the model and the next step, then the provider's
  response folded under "Provider response". Retry when retryable; "Review model keys" for key and quota
  failures.
- **Hand-off to another agent** (`call_agent_<id>`): never the raw tool name. A tool row with the asked
  agent's face, "Asked PR Reviewer", the opening of the request, the duration and the state; open, it holds
  the whole request, what came back, and "Open PR Reviewer's thread". When a session has sub-agent threads, a
  tab row sits under the session bar (Main · one tab per sub-agent, roving tabindex). Inside a sub-agent's
  thread the opening message sits on the left under "{coordinator} asked {agent}", not on the right as "you".
- **Requests** (`request_access`, `request_skill`): the amber card is the whole of it; the tool call that
  produced it is not drawn a second time. The access card names the app with its own mark and says where the
  credential goes; the skill card names the skill as people say it ("Word documents") with one whole sentence.
- **A run until done** (a mission; one session per iteration). The band under the session bar carries the
  run's state in words, the goal, two budgets (iteration, time), the other iterations and Stop run. The
  iteration opens with a note from the run ("Iteration 3 started · the run sent the agent back in because a
  check failed last time: `npm test -- routes`"), with the brief the agent was given folded under it: the run
  wrote that message, so it is never a bubble from "you". It ends with a verdict card listing each check and
  the output of the failing ones.
- **System notes** (scheduled wake-up, context compaction): a centred caption row `text-xs text-fg-subtle`
  with a small icon, or a `Callout` when it needs reading.
- **Streaming**: the last agent block shows the three-dot `BrandLoader` under the text until tokens arrive.
- **Empty session**: centred `AgentAvatar xl`, the agent's name (`text-h2`), its description, and the
  composer; no wash.
- **Composer**: `<Composer size="md">` sticky at the bottom of the column on a
  `bg-gradient-to-t from-bg` fade; `attachments` for images; `running` + `onStop` while the agent works.
  A send that fails puts the words and attachments back in the box under a notice with the server's reason
  and **Try again**; a failed attachment stops the whole message and is named. Typed text is kept per session
  for the tab. Files that are not images are refused in the same notice, by name.
- **An ended or archived session has no composer**: a flat band says it cannot take new messages and offers
  **New session with {agent}** (`startSession`). This follows the API contract (409).
- **Edges**: once scrolled, text passing under the session bar dissolves over a short fade that mirrors the
  one above the composer (`ConversationEdges`); at the very top there is none.
- **Failed reads say so**: vault credentials, the mission band, history, names, outcome, files and
  permissions each say "could not be loaded" with their own retry, never an empty state.

**Context panel** (right, 320px, collapsible; opens by itself only from 1400px, where the conversation keeps
its 720px column, and remembers a person's choice separately for compact and roomy screens; a `Sheet` below
1280px): a stack of quiet
groups separated by `space-y-6`, each a 12px medium `text-fg-subtle` label plus content: **Agent**
(`AgentAvatar` + name + `ModelBadge`, links to the profile) · **Environment** (`EntityRef`) · **Vaults**
(`EntityRef chip`s) · **Files** (name, size, download; "No files yet") · **Usage** (tokens, estimated cost,
model calls as a small `PropertyList`) · **Outcome** (evaluation result as `StatusBadge` + rationale) ·
**Session id** (`IdChip full`). The panel is `bg-bg` with a left hairline, not a card. Each group is a
`PanelGroup`; long names wrap to two lines instead of truncating.

**Timeline view**: the same session bar; the body is a `Page width="wide"`-like container with the
waterfall. Left column: one row per event with the `EventCard` icon for its kind, a mono name and its
duration; right: bars on a time axis (ticks from `pickTickStep`, `--chart-grid` lines, 11px
`text-fg-subtle` labels). Bar colours by **kind** (§2.3): model turn `--kind-model`, tool `--kind-tool`,
app (MCP) `--kind-app`, a scheduled wait neutral, thinking `--chart-other`, waiting for approval
`--warning-solid`, error `--danger-solid`. A hand-off is labelled in words ("Asked PR Reviewer"). Bars are 8px tall, fully rounded; hovering a row highlights it
(`bg-bg-hover`) and shows a tooltip (name, start offset, duration); clicking opens the same `EventCard`
body in a right `Sheet`. A legend (`ChartLegend`) sits above the axis. `TimelineView` takes a `sender` so an
eval trial says "Task" or "Simulated user" where a session says "You".

### 9.4 Usage (`/usage`)

`<Page width="default">`, `PageHeader title="Usage"`, `subtitle` explaining that cost is an API-price
estimate; `actions`: a `SegmentedControl` for the range (24h · 7 days · 30 days · 90 days) and one for
Cost | Tokens. No primary button.

1. KPI row: four `StatTile`s — Estimated spend (spark, delta vs previous period, `good: false` when up),
   Tokens processed (spark), Sessions, Saved by caching (proportion bar in `footer`). A change against the
   period before is shown on spend, tokens and sessions together or on none (`periodChanges`, shared with
   Home's last-30-days tiles), and each names its baseline. Range, measure and table length are in the address.
2. `SectionCard "Spend over time"`: `TimeSeriesChart type="area" stacked` by provider (Anthropic, OpenAI,
   Other), `height={280}`.
3. Two columns (`grid gap-4 lg:grid-cols-2`): `SectionCard "By model"` (`BarList`, provider colours,
   hint = tokens) and `SectionCard "By harness"` (`BarList`, single hue `--chart-1`, labels via `harnessLabel`).
4. `SectionCard "Token mix"`: cached input, new input, cache writes, output as one proportion bar with the
   numbers beside it, in the `--mix-*` ink ramp and the order of the session's usage panel (§2.3).
5. A `Callout tone="neutral"` at the bottom for the pricing caveat.

Loading: `StatTile loading` + skeleton blocks in the cards. Empty range: `EmptyState` in place of the charts.

### 9.5 Login (`/login`, also `/cli/login`, `/connect-runtime`)

All three use `pages/auth/AuthShell` (wash, mark, display headline, one card, theme toggle, docs link).
Full viewport, `bg-bg`, with `<Wash inline />` filling the top half (these pages have no shell, so use
`inline` inside a `relative` wrapper). Centred column, `max-w-[400px]`:

- `<Logo size="xl" />`, then `text-display` "Welcome back" (sign-up: "Create your account") and one
  `text-fg-muted` line ("Sign in to run and supervise your agents.").
- A card `surface rounded-3xl p-8`: provider buttons first (`Button variant="outline" size="lg"`, full
  width, brand icon), a divider with "or" (hairline + caption), then `Field`s for email and password and
  the ink **Sign in** (`size="lg"`, full width, `loading`).
- Errors as `Callout tone="danger"` above the form; Turnstile below the fields.
- Under the card: the mode switch as a plain line with a plum link ("New here? Create an account").
- Footer caption links (Docs, Terms) in `text-xs text-fg-subtle`.

Keep every auth mode, provider and the Turnstile flow that exists today.

### 9.6 Generic resource list

For Environments, Vaults, Memory, Skills, Models, API keys, Deployments, Files, Evals, Local runtimes and
the integration lists. Pattern §5.1 with `DataTable`:

| Resource | Identity cell | Columns after it |
|---|---|---|
| Environments | name + description (no tile: it would be the same on every row) | Provider/image `Chip`s · Networking · `StatusBadge` · Updated |
| Vaults | name | Credentials (count) · Used by (agents, `EntityRef` or count) · Updated |
| Memory | name + description | Entries · Used by · Updated |
| Skills | `EntityAvatar PuzzleIcon` + name + description | Source `Chip` · Security `StatusBadge` · Added |
| Models | the provider's own mark (Anthropic, OpenAI, Google; `components/resources/provider-marks.ts`) + model short name + raw id | Provider · Key (`••••wazK`, mono) · Default `Chip` · Added |
| API keys | name + key prefix | Scopes `Chip`s · Expires (`RelativeTime`, warning tone near expiry) · Last used |
| Deployments | the agent's face + name, the agent under it | Agent (`EntityRef`) · Environment (`EntityRef`) · Origins · `StatusBadge` |
| Files | file-type icon + filename | Type · Size (right) · Session (`EntityRef`) · Created |
| Evals | `EntityAvatar FlaskConicalIcon` + suite/run name | Agent (`EntityRef`) · Pass rate (`Meter` or "4/5") · `StatusBadge` · Started |

Every list: a one-sentence `subtitle` that says what the resource is for, a search box where the endpoint
supports `q`, the status filter where rows can be archived, and a first-run `EmptyState` that explains the
resource and offers the create action. Rows open the record page; secondary actions are in `RowActionsMenu`.

### 9.7 Generic resource detail

Pattern §5.2. Header: `EntityAvatar size="xl"` with the resource's icon, name, `StatusBadge soft`,
description, three to five meta chips (no id: it is in Details). Primary action = the most common next step
(Environment: "Start session here", with an agent that runs there or any other through the dialog; Vault:
"Add credential"; Memory: "New entry"; Eval run: "Run again"). Edit is outline;
Archive/Delete are in the menu. Body: main column of `SectionCard`s for configuration (use `SettingRow`s
for toggles, `PropertyList`s for read-only config, `CodeWell` for Dockerfiles and JSON) and child
collections (`SectionCard flush` with a compact table); aside with "Details" (`PropertyList`: created,
updated, id) and "Used by" (the agents that reference it, as `EntityRef`s — resolve with `useAgents()`).

### 9.8 Operations (`/operations`)

`<Page width="default">`, title "Operations", subtitle "Approvals, failures and budgets that need a
person." KPI row of four tiles (Waiting for approval, Failed work, Running now, Estimated cost today), each
opening its tab. `TabBar`: **Needs attention · Approvals (n) · Failed work (n) · Running (n) · Budgets** (keep the existing tab names that tests
query, e.g. `Approvals (1)`). Approvals are `EventCard kind="approval"` with the session as an `EntityRef`
above each; failed work items are `EventCard kind="error"` with **Retry work** and **Discard and continue**;
budgets are `Meter`s in a `SectionCard`. Keep `role="alert"` on load failures and the "Try again" button.
Every failure line leads with the cause read from the session's log (§4.8), "Ended on an error" included. A
session whose requests could not be read is a "Could not be checked" card with Try again, not counted in the
tiles (when nothing else waits, the Waiting tile's hint says "1 session could not be checked" instead of "No agent
is blocked").
A run until done is called that here too: the section is "Runs until done" and ends one with **End the run**,
the session band's words; "mission" is the API's word and never the screen's.

---

## 10 Data helpers

All in `src/lib`. They use the existing API client and endpoints, cached and de-duplicated by TanStack Query.

| Helper | Gives you |
|---|---|
| `useAgents()` (`directory.ts`) | `agents`, `byId` — every agent, active and archived |
| `useRecentSessions()` | `sessions` — the latest 100, each with its agent snapshot (`s.agent.name`) |
| `useAgentActivity()` | `byAgent: Map<id, { sessions, running, lastActiveAt }>` |
| `useOperations()` | `report`, `approvals`, `failed`, `total`, `attention: Map<sessionId, "approval" | "error">`, `unsupported` |
| `useSessionReadings()` (`components/sessions/readings.ts`) | **The one reading of a session**: `read(session)` → `{ status, tone, label, detail, waiting, stalled }` from `readSession` (`lib/session-state.ts`), with the open access and skill requests read from each session's log (`log-reading.ts`: backward from the newest 40 events until every request is settled, then only newer events; budget and cost in `readings.ts`), `failures` (each failed session's cause), `unknown` (sessions that could not be read, or are too long to check); `counts.attention` is the one number. Every place that shows a session's state draws it: the sidebar's Recents dot and Operations count, Home, Operations, the Sessions list, the session header, the palette, an agent's Overview and Activity |
| `usePatienceForRequests(loading)` (`readings.ts`) | Whether a count that includes the open requests should still wait for them (at most 1.5s from when their reads start, one clock for the tab), so the badge and Home's band are drawn once |
| `useEntityName(kind, id)` | `{ name, isLoading, missing, href }` — what `EntityRef` uses |
| `sessionTitle(s)`, `sessionSource(s)` (`sessions.ts`) | Session display rules (a title is never "Untitled" and never an id). `sessionDisplayStatus` is the reading with less evidence (no requests, no staleness): no screen uses it any more |
| `agentCapabilities(agent)`, `harnessLabel(h)`, `agentNeedsEnvironment(agent)` (`agents.ts`) | Capability chips and labels |
| `describeModel(model)`, `PROVIDER_COLOR` (`models.ts`) | Model short names and provider colours |
| `formatRelativeTime`, `formatAbsolute`, `formatDate`, `formatCost`, `formatCompact`, `formatSpan`, `plural`, `countWords`, `initials` (`format.ts`) | Formatting |
| `failureSentence(err)`, `withReason(lead, err)` (`failure-text.ts`) | A failure as a sentence (§4.8) |
| `usageWindow(days)` (`usage-window.ts`) | The one usage window for Home and Usage: whole UTC days, the period before of the same length |
| `inlineLink`, `standaloneLink`, `quietLink`, `linkHitArea` (`links.ts`) | The text-link looks, each with a 24px target or more (§4.3) |
| `naturalFace`, `faceBook` (`agent-face.ts`) | An agent's glyph and tint, and the pass that keeps two agents from looking the same |
| `useCopy()`, `copyText()` (`clipboard.ts`) | Copy with inline "copied" feedback |
| `readFailure(error)` (`failures.ts`) | `{ cause, next, headline, auth, quota, raw }`: a failure in plain words (§4.8) |
| `useQuietQuery(path)` (`useApiQuery.ts`) | A read that may fail without a toast; `missing` on 404 / 501 |
| `buildOperationsView(report, agents, sessions)` (`components/operations/model.ts`) | Approvals, failed work, running, budgets by name; `attention` is the one count |
| `useCrumbLabel(name)` (`components/AppBreadcrumb.tsx`) | Name the current page's breadcrumb from inside the page |
| `brandMark(key)`, `AppIcon` (`components/agents/controls.tsx`) | A vendored app glyph, or undefined |
| `skillIcon(name, category?)` (`components/resources/skills.ts`) | A subject icon for a skill |
| `useTheme()` (`theme.ts`) | `{ theme, effective, setTheme }` from one shared store |
| `startSession({ agentId?, environmentId? })`, `openCommandPalette()` (`shell-events.ts`) | Start a session from anywhere (§9.0); open ⌘K |

Starting a session from anywhere: call `startSession()`. Never navigate to start one. The starter creates the
session (`POST /v1/sessions`), uploads images, sends the first `user.message`, then opens it.

---

## 11 Migrating a legacy page

| You find | Replace with |
|---|---|
| `bg-brand text-brand-fg` button | `<Button>` |
| hand-rolled bordered button | `<Button variant="outline">` (or `ghost`) |
| `text-brand hover:underline` | `text-plum underline underline-offset-3` or `<Button variant="link">` |
| `border border-border rounded-lg bg-bg-surface shadow-[var(--shadow-sm)]` | `surface rounded-xl` or `<SectionCard>` |
| `hover:bg-bg-surface`, `hover:bg-brand-subtle/45` | `hover:bg-bg-hover` |
| `text-[11px] uppercase text-fg-subtle` label | `text-xs font-medium text-fg-subtle` (sentence case) |
| `text-[13px]`, `text-[12px]`, `text-[15px]` | `text-small`, `text-xs`, `text-prose` / `text-h3`; inside a box that sets its own line height, `text-small-size`, `text-caption-size` (§2.4) |
| `font-display text-lg font-semibold` | `text-h2` |
| a raw id in a cell or a header | `<EntityRef>` for references, `<IdChip>` for the record's own id |
| `new Date(x).toLocaleString()` | `<RelativeTime value={x} />` |
| status `<span className="bg-success-subtle …">active</span>` | `<StatusBadge status="active" />` |
| `confirm("Delete?")` | `<ConfirmDialog destructive …>` |
| native `<select>` | `<Select>` / `<Combobox>` |
| `<div className="p-10 text-fg-subtle">Loading...</div>` | `<SkeletonDetail />` or the matching skeleton |
| `<div className="p-10 text-danger">Error: …</div>` | `<ErrorState title="… could not be loaded" error retry />` |
| a key–value grid | `<PropertyList>` in a `SectionCard` |
| a row of five equal buttons | one primary + one outline + `RowActionsMenu` |
| emoji as an icon (🔗 💬 🧪) | a lucide icon or the brand mark from `components/icons.tsx` |
| `<img src={favicon(domain)}>`, any remote icon | `<AppIcon slug={…} name={…} />` |
| `text-[1.75rem] leading-none font-semibold …` | `text-stat` (or `text-hero` for a page's one headline number) |
| a list's own "could not be loaded" swap | `<DataTable error={error} onRetry={refresh} />` |
| a record id chip in the header | remove it; the id lives in Details |
| `pl-4 pr-5` page padding | `<Page>` (or `PAGE_GUTTER`) |
