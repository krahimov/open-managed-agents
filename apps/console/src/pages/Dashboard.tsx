import { useState } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, ChevronRight, Copy, Terminal } from "lucide-react";
import type { ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  AgentIcon,
  EnvIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  VaultIcon,
} from "../components/icons";
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

  // macOS widget tile: 16px radius, glyph in a tinted disc, big
  // tabular number in the rounded face, small caption.
  const stat = (
    label: string,
    value: number | undefined,
    to: string,
    Icon: ComponentType<{ className?: string }>,
  ) => (
    <button
      key={label}
      onClick={() => nav(to)}
      className="sq-press group relative text-left p-4 rounded-2xl bg-bg-surface shadow-[var(--shadow-sm)] hover:shadow-[var(--shadow-md)] outline-none focus-visible:ring-[3px] focus-visible:ring-system-accent/45"
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-subtle text-brand">
          <Icon className="size-3.5 [stroke-width:2]" />
        </span>
        <ChevronRight className="size-4 text-fg-subtle opacity-0 -translate-x-1 transition-[opacity,translate] duration-[var(--dur-base)] group-hover:opacity-100 group-hover:translate-x-0" />
      </div>
      <div className="mt-4 font-rounded text-[32px] leading-none font-semibold tracking-[-0.02em] text-fg tabular-nums">
        {value ?? "–"}
      </div>
      <div className="mt-1.5 text-[12px] text-fg-muted font-medium">
        {label}
      </div>
    </button>
  );

  const stats_ = [
    { label: "Agents", value: stats?.agents, to: "/agents", icon: AgentIcon },
    { label: "Sessions", value: stats?.sessions, to: "/sessions", icon: SessionsIcon },
    { label: "Environments", value: stats?.environments, to: "/environments", icon: EnvIcon },
    { label: "Vaults", value: stats?.vaults, to: "/vaults", icon: VaultIcon },
    { label: "Skills", value: stats?.skills, to: "/skills", icon: SkillsIcon },
    { label: "Model Cards", value: stats?.model_cards, to: "/model-cards", icon: ModelCardsIcon },
  ];

  const cmd = "npx -y -p @openma/cli oma";
  const cmdGlobal = "npm i -g @openma/cli";
  const examplePrompt =
    `Use ${BRAND_NAME} to create a research agent that monitors arXiv for new ML papers daily`;
  const skillPreview = HARNESS_AGENT_BUILDER_SKILL.split("\n").slice(0, 28).join("\n");

  // Shared copy glyph for the copy-to-clipboard wells.
  const copyGlyph = (key: string) =>
    copied === key ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 pt-2 pb-12 max-w-[1240px] space-y-8">
        {/* Large title. Onboarding voice only until the workspace has
            agents; after that the dashboard is an instrument, with the
            guide one quiet toggle away. */}
        <header className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h1 className="font-display text-[26px] leading-[32px] font-bold tracking-[-0.022em] text-fg">
              {workspaceActive || statsPending ? "Overview" : `Get started with ${BRAND_NAME}`}
            </h1>
            <p className="mt-0.5 text-[13px] text-fg-muted">
              {workspaceActive || statsPending
                ? "Workspace activity at a glance."
                : "Install the CLI, mint a key, and let agents operate against your control plane."}
            </p>
          </div>
          {workspaceActive && (
            <Button variant="outline" size="sm" onClick={() => setShowGuide((v) => !v)}>
              {showGuide ? "Hide setup guide" : "Setup guide"}
            </Button>
          )}
        </header>

        {/* Widgets — number-forward stat tiles. */}
        <section aria-label="Workspace totals">
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3">
            {stats_.map((s) => stat(s.label, s.value, s.to, s.icon))}
          </div>
        </section>

        {/* Quickstart — a grouped list, one row per step. */}
        {guideVisible && (
        <section className="sq-reveal">
          <h2 className="sq-section-title mb-2 px-1">Set up</h2>
          <div className="sq-group">
            {/* Step 1 */}
            <div className="sq-row grid md:grid-cols-[220px_1fr] gap-x-6 gap-y-2 px-4 py-4" style={{ ["--sq-inset" as string]: "56px" }}>
              <div className="flex items-start gap-3">
                <span className="mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg text-[11px] font-semibold font-rounded">1</span>
                <div className="font-medium text-fg text-[13px] leading-6">Install the CLI</div>
              </div>
              <div className="space-y-2 min-w-0">
                <p className="text-[13px] text-fg-muted">
                  The command-line client lets your
                  agent (or you) drive the platform from the terminal.
                </p>
                <button
                  onClick={() => copy(cmd, "cmd")}
                  className="sq-press group flex w-full sm:w-auto sm:inline-flex items-center gap-3 pl-3 pr-2 h-8 rounded-[7px] bg-bg-inset shadow-[inset_0_0_0_0.5px_var(--border)] hover:text-fg text-left"
                >
                  <span className="text-fg-subtle select-none font-mono text-xs">›</span>
                  <span className="font-mono text-[12px] text-fg flex-1 truncate">{cmd}</span>
                  <span className="shrink-0 text-fg-subtle group-hover:text-fg p-1">
                    {copyGlyph("cmd")}
                  </span>
                </button>
                <p className="text-[12px] text-fg-subtle">
                  or globally:{" "}
                  <button
                    onClick={() => copy(cmdGlobal, "cmd-global")}
                    className="inline-flex items-center min-h-11 sm:min-h-0 font-mono text-fg-muted hover:text-brand"
                  >
                    {cmdGlobal}
                  </button>
                </p>
              </div>
            </div>

            {/* Step 2 */}
            <div className="sq-row grid md:grid-cols-[220px_1fr] gap-x-6 gap-y-2 px-4 py-4" style={{ ["--sq-inset" as string]: "56px" }}>
              <div className="flex items-start gap-3">
                <span className="mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg text-[11px] font-semibold font-rounded">2</span>
                <div className="font-medium text-fg text-[13px] leading-6">Mint an API key</div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[13px] text-fg-muted">
                  Your agent needs this to authenticate. Keep it somewhere it can read.
                </p>
                <Button size="sm" onClick={() => nav("/api-keys")}>
                  Generate API key
                  <ArrowRight className="size-3.5" />
                </Button>
              </div>
            </div>

            {/* Step 3 */}
            <div className="sq-row grid md:grid-cols-[220px_1fr] gap-x-6 gap-y-2 px-4 py-4" style={{ ["--sq-inset" as string]: "56px" }}>
              <div className="flex items-start gap-3">
                <span className="mt-px inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-brand text-brand-fg text-[11px] font-semibold font-rounded">3</span>
                <div className="font-medium text-fg text-[13px] leading-6">Give it the task</div>
              </div>
              <div className="space-y-2">
                <p className="text-[13px] text-fg-muted">
                  Point your agent at the CLI or API skill, then
                  ask for what you want:
                </p>
                <button
                  onClick={() => copy(examplePrompt, "prompt")}
                  className="sq-press group w-full text-left rounded-[10px] bg-bg-inset shadow-[inset_0_0_0_0.5px_var(--border)] p-3 flex items-start gap-3"
                >
                  <span className="shrink-0 mt-0.5 text-[11px] font-semibold text-fg-subtle">
                    Prompt
                  </span>
                  <span className="flex-1 text-[13px] text-fg leading-snug">{examplePrompt}</span>
                  <span className="shrink-0 text-fg-subtle group-hover:text-fg mt-0.5">
                    {copyGlyph("prompt")}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </section>
        )}

        {/* Agent builder skill — copyable handoff for external coding agents */}
        <section>
          <h2 className="sq-section-title mb-2 px-1">Build with your coding agent</h2>
          <div className="sq-group grid lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
            <div className="p-5 md:p-6 min-w-0 flex flex-col">
              <div className="flex items-center gap-3">
                <span className="inline-flex size-10 items-center justify-center rounded-[10px] bg-linear-to-b from-[#3a3a40] to-[#1c1c20] text-white shadow-[var(--shadow-sm)]">
                  <Terminal className="size-5" strokeWidth={1.75} />
                </span>
                <div>
                  <h3 className="font-display text-[17px] font-semibold tracking-[-0.015em] text-fg">
                    Agent builder skill
                  </h3>
                  <p className="text-[12px] text-fg-subtle">Codex / Claude Code</p>
                </div>
              </div>
              <p className="mt-4 text-[13px] text-fg-muted leading-[1.55] max-w-[56ch]">
                Paste this into your coding agent so it can create Harness Studio
                agents, trigger CLI sign-in, route app OAuth, apply manifests,
                and verify sessions.
              </p>

              <div className="mt-5 flex flex-col sm:flex-row gap-2">
                <Button onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill")}>
                  {copied === "agent-builder-skill" ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  Copy full skill
                </Button>
                <Button
                  variant="outline"
                  onClick={() => copy(HARNESS_AGENT_BUILDER_PROMPT, "agent-builder-prompt")}
                >
                  {copied === "agent-builder-prompt" ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                  Copy starter prompt
                </Button>
              </div>

              <ol className="mt-5 flex flex-wrap gap-2 text-[12px] text-fg-muted">
                {["CLI sign-in", "OAuth handoff", "Smoke test"].map((item, index) => (
                  <li
                    key={item}
                    className="inline-flex items-center gap-1.5 h-6 pl-1 pr-2.5 rounded-full bg-bg-hover dark:bg-white/[0.06]"
                  >
                    <span className="inline-flex size-4 items-center justify-center rounded-full bg-bg-surface text-[10px] font-semibold text-brand shadow-[var(--shadow-sm)]">
                      {index + 1}
                    </span>
                    <span className="truncate">{item}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="min-w-0 m-1.5 rounded-[10px] bg-bg-inset shadow-[inset_0_0_0_0.5px_var(--border)] overflow-hidden">
              <div className="flex items-center justify-between gap-3 pl-4 pr-2 h-11 shadow-[0_0.5px_0_var(--hairline)]">
                <div className="min-w-0 flex items-baseline gap-2">
                  <p className="text-[12px] font-semibold text-fg">
                    SKILL.md
                  </p>
                  <p className="text-[12px] text-fg-subtle truncate">
                    Self-contained paste target
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill-preview")}
                  aria-label="Copy agent builder skill"
                >
                  {copied === "agent-builder-skill-preview" ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
              <pre className="max-h-[236px] overflow-auto px-4 py-3 text-[11.5px] leading-[1.6] text-fg-muted font-mono whitespace-pre-wrap break-words">
                {skillPreview}
              </pre>
            </div>
          </div>
        </section>

        {/* Recent sessions — a grouped list. */}
        <section>
          <div className="flex items-baseline justify-between mb-2 px-1">
            <h2 className="sq-section-title">Recent sessions</h2>
            <button
              onClick={() => nav("/sessions")}
              className="inline-flex items-center gap-0.5 min-h-11 sm:min-h-0 text-[13px] text-brand hover:underline underline-offset-2"
            >
              View all
              <ChevronRight className="size-3.5" />
            </button>
          </div>

          {sessionsQuery.isLoading ? (
            <div className="sq-group">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="sq-row flex items-center gap-4 px-4 h-14">
                  <Skeleton className="size-8" rounded="full" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3 w-[40%]" rounded="full" />
                    <Skeleton className="h-2.5 w-[24%]" rounded="full" />
                  </div>
                  <Skeleton className="h-3 w-20" rounded="full" />
                </div>
              ))}
            </div>
          ) : recentSessions.length === 0 ? (
            <EmptyState
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
          ) : (
            <ul className="sq-group">
              {recentSessions.map((s) => (
                <li key={s.id} className="sq-row" style={{ ["--sq-inset" as string]: "60px" }}>
                  <button
                    type="button"
                    onClick={() => nav(`/sessions/${s.id}`)}
                    className="group w-full flex items-center gap-3 px-4 h-14 text-left hover:bg-bg-hover transition-colors duration-[var(--dur-quick)] outline-none focus-visible:bg-bg-hover"
                  >
                    <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-bg-inset text-fg-muted shadow-[inset_0_0_0_0.5px_var(--border)]">
                      <SessionsIcon className="size-4 [stroke-width:1.75]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-medium text-fg">
                        {s.title || "Untitled"}
                      </span>
                      <span className="block truncate font-mono text-[11px] text-fg-subtle">
                        {s.agent_id}
                      </span>
                    </span>
                    <StatusPill status={s.status || "idle"} />
                    <span className="w-24 text-right text-[12px] text-fg-muted tabular-nums">
                      {new Date(s.created_at).toLocaleDateString()}
                    </span>
                    <ChevronRight className="size-4 text-fg-subtle/70 group-hover:text-fg-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
