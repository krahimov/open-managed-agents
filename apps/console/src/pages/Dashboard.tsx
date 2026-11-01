import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, ArrowUpRight, Check, ChevronRight, Copy, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "../lib/auth";
import { useApiQuery } from "../lib/useApiQuery";
import { toast } from "sonner";
import { StatusPill } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { BRAND_NAME } from "../lib/brand";
import {
  HARNESS_AGENT_BUILDER_PROMPT,
  HARNESS_AGENT_BUILDER_SKILL,
} from "../lib/harness-agent-builder-skill";

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

interface RecentSession {
  id: string;
  title: string;
  agent_id: string;
  status: string;
  created_at: string;
}

export function Dashboard() {
  const nav = useNavigate();
  const { user: _user } = useAuth();
  const [copied, setCopied] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(false);

  // Headline cards + recent panel each ride their own TQ query so the
  // dashboard renders the parts it has — a flaky /v1/stats no longer
  // blocks the recent-sessions panel and vice versa. The previous
  // hand-rolled `Promise.all` + single `loading` boolean made one failure
  // hide both panels.
  const statsQuery = useApiQuery<Stats>("/v1/stats");
  const sessionsQuery = useApiQuery<{ data: RecentSession[] }>(
    "/v1/sessions",
    { limit: "5" },
  );
  const stats = statsQuery.data ?? null;
  // Until /v1/stats settles we don't know whether this is a fresh workspace
  // or an active one — render the neutral Overview shell and NO guide.
  // Deciding "new user" from missing data made the whole onboarding panel
  // (API-key step included) flash for a beat on every hard refresh, then
  // vanish when stats landed.
  const statsPending = statsQuery.isLoading;
  const workspaceActive = (stats?.agents ?? 0) > 0;
  const guideVisible = !statsPending && (!workspaceActive || showGuide);
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

  const copy = async (text: string, key: string) => {
    try {
      const fallbackCopy = () => {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const copiedFallback = document.execCommand("copy");
        textarea.remove();
        if (!copiedFallback) throw new Error("Clipboard fallback failed");
      };

      try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
        await navigator.clipboard.writeText(text);
      } catch {
        fallbackCopy();
      }

      setCopied(key);
      toast.success("Copied");
      setTimeout(() => setCopied(null), 1600);
    } catch {
      toast.error("Copy failed");
    }
  };

  const stats_ = [
    { label: "Agents", value: stats?.agents, to: "/agents" },
    { label: "Sessions", value: stats?.sessions, to: "/sessions" },
    { label: "Environments", value: stats?.environments, to: "/environments" },
    { label: "Vaults", value: stats?.vaults, to: "/vaults" },
    { label: "Skills", value: stats?.skills, to: "/skills" },
    { label: "Model Cards", value: stats?.model_cards, to: "/model-cards" },
  ];

  const cmd = "npx -y -p @openma/cli oma";
  const cmdGlobal = "npm i -g @openma/cli";
  const examplePrompt =
    `Use ${BRAND_NAME} to create a research agent that monitors arXiv for new ML papers daily`;
  const skillPreview = HARNESS_AGENT_BUILDER_SKILL.split("\n").slice(0, 28).join("\n");

  const CopyGlyph = ({ k }: { k: string }) =>
    copied === k ? <Check className="size-4" /> : <Copy className="size-4" />;

  // Bento layout: the two headline counts get tall tiles beside the
  // feature tile; the remaining four sit in a row of compact tiles.
  const [primaryStats, secondaryStats] = [stats_.slice(0, 2), stats_.slice(2)];

  const statTile = (
    s: { label: string; value: number | undefined; to: string },
    i: number,
    big: boolean,
  ) => (
    <button
      key={s.label}
      onClick={() => nav(s.to)}
      style={{ animationDelay: `${80 + i * 40}ms` }}
      className={`studio-rise group card card-hover press text-left flex flex-col justify-between outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring ${
        big ? "rounded-[var(--radius-tile)] p-6 min-h-[164px]" : "p-5 min-h-[124px]"
      }`}
    >
      <div className="flex items-center justify-between">
        <span className="eyebrow">{s.label}</span>
        <ArrowUpRight
          className="size-4 text-fg-subtle opacity-0 -translate-x-1 translate-y-1 transition-all duration-[var(--dur-slow)] ease-[var(--ease-spring)] group-hover:opacity-100 group-hover:translate-x-0 group-hover:translate-y-0"
          aria-hidden="true"
        />
      </div>
      <div className="flex flex-col gap-1.5">
      {statsPending ? (
        <Skeleton className={big ? "h-11 w-16" : "h-8 w-12"} rounded="lg" />
      ) : (
        <div
          className={`font-display tabular-nums text-fg ${
            big ? "text-[56px] leading-none font-semibold tracking-[-0.045em]" : "text-numeral"
          }`}
        >
          {s.value ?? "–"}
        </div>
      )}
      {big && (
        <span className="text-[13px] text-fg-subtle">
          {s.label === "Sessions" ? "Conversations recorded" : "Configured in this workspace"}
        </span>
      )}
      </div>
    </button>
  );

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-8 pt-3 pb-14 max-w-[1320px]">
        {/* Header — onboarding voice only until the workspace has agents;
            after that the dashboard is an instrument, with the guide one
            quiet toggle away. */}
        <header className="flex flex-wrap items-end justify-between gap-4 mb-8">
          <div className="min-w-0">
            <div className="eyebrow mb-2">{BRAND_NAME} workspace</div>
            <h1 className="font-display text-hero text-fg">
              {workspaceActive || statsPending ? "Overview" : `Get started with ${BRAND_NAME}`}
            </h1>
            <p className="mt-2 text-[17px] leading-7 text-fg-muted max-w-[60ch]">
              {workspaceActive || statsPending
                ? "Workspace activity at a glance."
                : "Install the CLI, mint a key, and let agents operate against your control plane."}
            </p>
          </div>
          {workspaceActive && (
            <Button variant="secondary" onClick={() => setShowGuide((v) => !v)}>
              {showGuide ? "Hide setup guide" : "Setup guide"}
            </Button>
          )}
        </header>

        {/* Quickstart — three steps as three columns in one tile */}
        {guideVisible && (
          <section className="studio-rise card rounded-[var(--radius-tile)] mb-4 grid md:grid-cols-3 md:divide-x divide-border">
            {/* Step 1 */}
            <div className="p-6 md:p-7 min-w-0 space-y-3">
              <div className="eyebrow">Step 01</div>
              <div className="text-headline text-fg">Install the CLI</div>
              <p className="text-sm text-fg-muted leading-relaxed">
                The command-line client lets your
                agent (or you) drive the platform from the terminal.
              </p>
              <button
                onClick={() => copy(cmd, "cmd")}
                className="group flex w-full items-center gap-3 pl-3.5 pr-2 h-10 rounded-xl bg-code-well text-code-well-fg hover:opacity-90 transition-opacity text-left press"
              >
                <span className="text-code-well-muted select-none font-mono text-xs">›</span>
                <span className="font-mono text-[12.5px] flex-1 truncate">{cmd}</span>
                <span className="shrink-0 text-code-well-muted group-hover:text-code-well-fg transition-colors p-1">
                  <CopyGlyph k="cmd" />
                </span>
              </button>
              <p className="text-[12px] text-fg-subtle">
                or globally:{" "}
                <button
                  onClick={() => copy(cmdGlobal, "cmd-global")}
                  className="inline-flex items-center min-h-11 sm:min-h-0 font-mono text-fg-muted hover:text-brand transition-colors"
                >
                  {cmdGlobal}
                </button>
              </p>
            </div>

            {/* Step 2 */}
            <div className="p-6 md:p-7 min-w-0 space-y-3">
              <div className="eyebrow">Step 02</div>
              <div className="text-headline text-fg">Mint an API key</div>
              <p className="text-sm text-fg-muted leading-relaxed">
                Your agent needs this to authenticate. Keep it somewhere it can read.
              </p>
              <Button onClick={() => nav("/api-keys")} data-icon="inline-end">
                Generate API key
                <ArrowRight className="size-4" />
              </Button>
            </div>

            {/* Step 3 */}
            <div className="p-6 md:p-7 min-w-0 space-y-3">
              <div className="eyebrow">Step 03</div>
              <div className="text-headline text-fg">Give it the task</div>
              <p className="text-sm text-fg-muted leading-relaxed">
                Point your agent at the CLI or API skill, then
                ask for what you want:
              </p>
              <button
                onClick={() => copy(examplePrompt, "prompt")}
                className="group w-full text-left rounded-xl bg-fill hover:bg-fill-strong transition-colors p-3.5 flex items-start gap-3 press"
              >
                <span className="flex-1 text-[13px] text-fg leading-snug">{examplePrompt}</span>
                <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors mt-0.5">
                  <CopyGlyph k="prompt" />
                </span>
              </button>
            </div>
          </section>
        )}

        {/* Bento */}
        <div className="grid grid-cols-1 md:grid-cols-6 lg:grid-cols-12 gap-4">
          {/* Feature tile — agent builder skill with an inset dark code well */}
          <section className="studio-rise card rounded-[var(--radius-tile)] md:col-span-6 lg:col-span-8 lg:row-span-2 overflow-hidden grid xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <div className="p-7 flex flex-col min-w-0">
              <div className="eyebrow inline-flex items-center gap-1.5">
                <Terminal className="size-3.5" />
                Codex / Claude Code
              </div>
              <h2 className="mt-3 font-display text-[30px] leading-[1.1] font-bold tracking-[-0.028em] text-fg">
                Agent builder skill
              </h2>
              <p className="mt-3 text-[15px] text-fg-muted leading-relaxed max-w-[44ch]">
                Paste this into your coding agent so it can create Harness Studio
                agents, trigger CLI sign-in, route app OAuth, apply manifests,
                and verify sessions.
              </p>

              <div className="mt-6 flex flex-wrap gap-2">
                <Button onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill")}>
                  <CopyGlyph k="agent-builder-skill" />
                  Copy full skill
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => copy(HARNESS_AGENT_BUILDER_PROMPT, "agent-builder-prompt")}
                >
                  <CopyGlyph k="agent-builder-prompt" />
                  Copy starter prompt
                </Button>
              </div>

              <ol className="mt-auto pt-8 grid grid-cols-3 gap-3 text-[12.5px] text-fg-muted">
                {["CLI sign-in", "OAuth handoff", "Smoke test"].map((item, index) => (
                  <li key={item} className="min-w-0 border-t border-border pt-3">
                    <div className="font-mono text-[11px] text-fg-subtle tabular-nums">
                      {String(index + 1).padStart(2, "0")}
                    </div>
                    <div className="mt-0.5 truncate font-medium text-fg">{item}</div>
                  </li>
                ))}
              </ol>
            </div>

            <div className="p-3 xl:pl-0 min-w-0 flex">
              <div className="relative flex-1 min-w-0 rounded-[14px] bg-code-well ring-1 ring-white/5 overflow-hidden flex flex-col">
                <div className="flex items-center gap-3 pl-4 pr-2 h-11 border-b border-white/8">
                  <div className="flex gap-1.5" aria-hidden="true">
                    <span className="size-2.5 rounded-full bg-white/15" />
                    <span className="size-2.5 rounded-full bg-white/15" />
                    <span className="size-2.5 rounded-full bg-white/15" />
                  </div>
                  <p className="flex-1 min-w-0 truncate font-mono text-[11.5px] text-code-well-muted">
                    SKILL.md <span className="opacity-60">· preview</span>
                  </p>
                  <button
                    onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill-preview")}
                    className="inline-flex items-center justify-center size-8 rounded-full text-code-well-muted hover:text-code-well-fg hover:bg-white/10 transition-colors"
                    aria-label="Copy agent builder skill"
                  >
                    <CopyGlyph k="agent-builder-skill-preview" />
                  </button>
                </div>
                <pre className="flex-1 max-h-[320px] overflow-auto px-4 py-3.5 text-[11.5px] leading-[1.7] text-code-well-fg/85 font-mono whitespace-pre-wrap break-words [scrollbar-width:thin]">
                  {skillPreview}
                </pre>
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-code-well to-transparent"
                />
              </div>
            </div>
          </section>

          {/* Headline counts — tall tiles beside the feature */}
          {primaryStats.map((s, i) => (
            <div key={s.label} className="md:col-span-3 lg:col-span-4 flex [&>button]:flex-1">
              {statTile(s, i, true)}
            </div>
          ))}

          {/* Compact counts */}
          {secondaryStats.map((s, i) => (
            <div key={s.label} className="md:col-span-3 lg:col-span-3 flex [&>button]:flex-1">
              {statTile(s, i + 2, false)}
            </div>
          ))}

          {/* Recent sessions — editorial list */}
          <section className="studio-rise card rounded-[var(--radius-tile)] md:col-span-6 lg:col-span-12 overflow-hidden" style={{ animationDelay: "320ms" }}>
            <div className="flex items-end justify-between gap-4 px-7 pt-6 pb-4">
              <div>
                <div className="eyebrow mb-1">Activity</div>
                <h2 className="font-display text-[22px] leading-7 font-bold tracking-[-0.022em] text-fg">
                  Recent sessions
                </h2>
              </div>
              <button
                onClick={() => nav("/sessions")}
                className="inline-flex items-center gap-1 min-h-11 sm:min-h-0 text-[13px] font-medium text-brand hover:underline underline-offset-4"
              >
                View all
                <ChevronRight className="size-3.5" />
              </button>
            </div>

            {sessionsQuery.isLoading ? (
              <div className="px-7 pb-4">
                {Array.from({ length: 4 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-6 h-16 border-t border-border">
                    <Skeleton className="h-3 w-[32%]" rounded="full" />
                    <Skeleton className="h-3 w-16" rounded="full" />
                    <Skeleton className="h-3 w-20 ml-auto" rounded="full" />
                  </div>
                ))}
              </div>
            ) : recentSessions.length === 0 ? (
              <div className="px-7 pb-7">
                <EmptyState
                  className="!shadow-none !border-0 bg-fill"
                  title="No sessions yet"
                  body={
                    <>
                      Tell your agent to start one, or visit the{" "}
                      <button
                        onClick={() => nav("/sessions")}
                        className="inline-flex items-center min-h-11 sm:min-h-0 text-brand hover:underline"
                      >
                        Sessions page
                      </button>
                      .
                    </>
                  }
                />
              </div>
            ) : (
              <ul className="px-4 pb-4">
                {recentSessions.map((s) => (
                  <li key={s.id} className="mx-3 border-t border-border first:border-t-0">
                    <button
                      onClick={() => nav(`/sessions/${s.id}`)}
                      className="-mx-3 w-[calc(100%+1.5rem)] grid grid-cols-[minmax(0,1fr)_auto] sm:grid-cols-[minmax(0,1fr)_120px_110px] items-center gap-x-6 px-3 h-16 rounded-xl text-left hover:bg-fill/70 transition-colors duration-[var(--dur-base)] outline-none focus-visible:bg-fill"
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-[14.5px] font-semibold tracking-[-0.012em] text-fg">
                          {s.title || "Untitled"}
                        </span>
                        <span className="block truncate font-mono text-[11.5px] text-fg-subtle">
                          {s.id}
                          {s.agent_id ? <span className="opacity-70"> · {s.agent_id}</span> : null}
                        </span>
                      </span>
                      <span className="hidden sm:flex">
                        <StatusPill status={s.status || "idle"} />
                      </span>
                      <span className="text-right text-[13px] text-fg-subtle tabular-nums">
                        {new Date(s.created_at).toLocaleDateString()}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
