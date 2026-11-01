import { useState, type ComponentType } from "react";
import { useNavigate } from "react-router";
import { ArrowRight, Check, ChevronRight, Copy, Terminal } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useApiQuery } from "../lib/useApiQuery";
import { toast } from "sonner";
import { StatusPill } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { BRAND_NAME } from "../lib/brand";
import { Button } from "../components/ui/button";
import { formatRelative } from "../lib/format";
import {
  AgentIcon,
  EnvIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  VaultIcon,
} from "../components/icons";
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
  const { user } = useAuth();
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

  const stat = (
    label: string,
    value: number | undefined,
    to: string,
    Icon: ComponentType<{ className?: string }>,
  ) => (
    <button
      key={label}
      onClick={() => nav(to)}
      className="group relative text-left p-4 pb-3.5 rounded-[20px] glass-card transition-[transform,box-shadow] duration-300 ease-(--ease-spring) hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_0_var(--glass-hi),inset_0_0_0_1px_var(--glass-rim),0_0_0_0.5px_var(--glass-edge),var(--glass-shadow-lg)] active:scale-[0.98] motion-reduce:transform-none outline-none focus-visible:outline-2 focus-visible:outline-ring"
    >
      <div className="flex items-center justify-between">
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-brand-subtle text-brand shadow-[inset_0_1px_0_var(--glass-hi)]">
          <Icon className="size-3.5" />
        </span>
        <ChevronRight className="size-4 text-fg-subtle opacity-0 -translate-x-1 transition-all duration-200 group-hover:opacity-100 group-hover:translate-x-0" />
      </div>
      <div className="mt-4 font-rounded text-[34px] leading-none font-semibold tracking-[-0.02em] text-fg tabular-nums">
        {value ?? "–"}
      </div>
      <div className="mt-1.5 text-[13px] text-fg-muted font-medium">
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

  const hour = new Date().getHours();
  const greeting = hour < 5 ? "Good evening" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const who = (user?.name || "").trim();
  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const cmd = "npx -y -p @openma/cli oma";
  const cmdGlobal = "npm i -g @openma/cli";
  const examplePrompt =
    `Use ${BRAND_NAME} to create a research agent that monitors arXiv for new ML papers daily`;
  const skillPreview = HARNESS_AGENT_BUILDER_SKILL.split("\n").slice(0, 28).join("\n");

  const copyIcon = (key: string) =>
    copied === key ? <Check className="size-4" /> : <Copy className="size-4" />;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="px-6 pt-7 pb-12 space-y-9 max-w-[1320px]">
        {/* Hero — large display title. Onboarding voice only until the
            workspace has agents; after that a greeting, with the guide
            one quiet toggle away. */}
        <header className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <p className="text-[12px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
              {today} · Overview
            </p>
            <h1 className="mt-1.5 font-display text-[34px] leading-[1.1] font-semibold tracking-[-0.03em] text-fg">
              {workspaceActive || statsPending
                ? `${greeting}${who ? `, ${who}` : ""}`
                : `Get started with ${BRAND_NAME}`}
            </h1>
            <p className="mt-2 text-[15px] text-fg-muted">
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

        {/* Stat widgets — glass tiles, rounded tabular numerals. */}
        <section aria-label="Workspace totals">
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {stats_.map((s) => stat(s.label, s.value, s.to, s.icon))}
          </div>
        </section>

        {/* Quickstart — one glass panel, three steps */}
        {guideVisible && (
        <section className="glass-card rounded-[20px] overflow-hidden">
          {[
            {
              n: "1",
              title: "Install the CLI",
              body: (
                <>
                  <p className="text-sm text-fg-muted">
                    The command-line client lets your agent (or you) drive the platform from the terminal.
                  </p>
                  <button
                    onClick={() => copy(cmd, "cmd")}
                    className="group flex w-full sm:w-auto sm:inline-flex items-center gap-3 pl-3.5 pr-2 h-10 rounded-[12px] glass-well hover:bg-hover transition-colors duration-200 text-left"
                  >
                    <span className="text-fg-subtle select-none font-mono text-xs">$</span>
                    <span className="font-mono text-[13px] text-fg flex-1 truncate">{cmd}</span>
                    <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors p-1">
                      {copied === "cmd" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
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
                </>
              ),
            },
            {
              n: "2",
              title: "Mint an API key",
              body: (
                <>
                  <p className="text-sm text-fg-muted">
                    Your agent needs this to authenticate. Keep it somewhere it can read.
                  </p>
                  <Button onClick={() => nav("/api-keys")}>
                    Generate API key
                    <ArrowRight data-icon="inline-end" />
                  </Button>
                </>
              ),
            },
            {
              n: "3",
              title: "Give it the task",
              body: (
                <>
                  <p className="text-sm text-fg-muted">
                    Point your agent at the CLI or API skill, then ask for what you want:
                  </p>
                  <button
                    onClick={() => copy(examplePrompt, "prompt")}
                    className="group w-full text-left rounded-[12px] glass-well hover:bg-hover transition-colors duration-200 p-3 flex items-start gap-3"
                  >
                    <span className="shrink-0 mt-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-fg-subtle">
                      Prompt
                    </span>
                    <span className="flex-1 text-[13px] text-fg leading-snug">{examplePrompt}</span>
                    <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors mt-0.5">
                      {copied === "prompt" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                    </span>
                  </button>
                </>
              ),
            },
          ].map((step, i) => (
            <div
              key={step.n}
              className={`grid md:grid-cols-[200px_1fr] gap-x-6 gap-y-3 p-6 ${i < 2 ? "border-b border-border" : ""}`}
            >
              <div className="flex items-start gap-3">
                <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full btn-solid font-rounded text-[13px] font-semibold">
                  {step.n}
                </span>
                <div className="pt-0.5 font-semibold text-fg text-[15px] tracking-[-0.01em]">{step.title}</div>
              </div>
              <div className="space-y-3 min-w-0">{step.body}</div>
            </div>
          ))}
        </section>
        )}

        {/* Agent builder skill — rich glass panel with an inset code well */}
        <section className="glass-card rounded-[24px] p-2">
          <div className="grid lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] gap-2">
            <div className="p-5 md:p-6 min-w-0 flex flex-col">
              <div className="inline-flex w-fit items-center gap-1.5 rounded-full glass-chip h-7 px-3 text-[12px] font-medium text-fg-muted">
                <Terminal className="size-3.5 text-brand" />
                Codex · Claude Code
              </div>
              <h2 className="mt-5 font-display text-[24px] leading-tight font-semibold tracking-[-0.025em] text-fg">
                Agent builder skill
              </h2>
              <p className="mt-2 text-[14px] text-fg-muted leading-6 max-w-[52ch]">
                Paste this into your coding agent so it can create Harness Studio
                agents, trigger CLI sign-in, route app OAuth, apply manifests,
                and verify sessions.
              </p>

              <div className="mt-6 flex flex-col sm:flex-row gap-2">
                <Button size="lg" onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill")}>
                  {copyIcon("agent-builder-skill")}
                  Copy full skill
                </Button>
                <Button
                  size="lg"
                  variant="secondary"
                  onClick={() => copy(HARNESS_AGENT_BUILDER_PROMPT, "agent-builder-prompt")}
                >
                  {copyIcon("agent-builder-prompt")}
                  Copy starter prompt
                </Button>
              </div>

              <ol className="mt-auto pt-8 flex flex-wrap gap-2 text-[12.5px] text-fg-muted">
                {["CLI sign-in", "OAuth handoff", "Smoke test"].map((item, index) => (
                  <li key={item} className="inline-flex items-center gap-2 h-7 pl-1 pr-3 rounded-full bg-hover">
                    <span className="inline-flex size-5 items-center justify-center rounded-full bg-brand-subtle font-rounded text-[11px] font-semibold text-brand">
                      {index + 1}
                    </span>
                    <span className="truncate">{item}</span>
                  </li>
                ))}
              </ol>
            </div>

            <div className="glass-well rounded-[18px] min-w-0 overflow-hidden flex flex-col">
              <div className="flex items-center justify-between gap-3 pl-4 pr-2 h-12 border-b border-border">
                <div className="min-w-0 flex items-center gap-2.5">
                  <span aria-hidden="true" className="flex gap-1.5">
                    <span className="size-2.5 rounded-full bg-fg/15" />
                    <span className="size-2.5 rounded-full bg-fg/15" />
                    <span className="size-2.5 rounded-full bg-fg/15" />
                  </span>
                  <p className="text-[12.5px] font-medium text-fg truncate">
                    SKILL.md
                  </p>
                  <p className="text-[12px] text-fg-subtle truncate hidden sm:block">
                    Self-contained paste target
                  </p>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => copy(HARNESS_AGENT_BUILDER_SKILL, "agent-builder-skill-preview")}
                  aria-label="Copy agent builder skill"
                >
                  {copyIcon("agent-builder-skill-preview")}
                </Button>
              </div>
              <pre className="max-h-[320px] overflow-auto px-4 py-3.5 text-[12px] leading-5 text-fg-muted font-mono whitespace-pre-wrap break-words [mask-image:linear-gradient(to_bottom,black_80%,transparent)]">
                {skillPreview}
              </pre>
            </div>
          </div>
        </section>

        {/* Recent sessions — glass list, flat rows */}
        <section>
          <div className="flex items-center justify-between mb-3 px-1">
            <h2 className="font-display text-[20px] font-semibold tracking-[-0.02em] text-fg">Recent sessions</h2>
            <Button variant="ghost" size="sm" onClick={() => nav("/sessions")}>
              View all
              <ChevronRight data-icon="inline-end" />
            </Button>
          </div>

          {sessionsQuery.isLoading ? (
            <div className="glass-card rounded-[20px] divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 px-4 h-14">
                  <Skeleton className="size-8" rounded="full" />
                  <Skeleton className="h-3.5 w-[34%]" rounded="sm" />
                  <Skeleton className="h-3.5 w-16" rounded="sm" />
                  <Skeleton className="h-3.5 w-20 ml-auto" rounded="sm" />
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
            <ul className="glass-card rounded-[20px] p-1.5">
              {recentSessions.map((s, i) => (
                <li key={s.id}>
                  <button
                    onClick={() => nav(`/sessions/${s.id}`)}
                    className="group w-full grid grid-cols-[32px_minmax(0,1fr)_auto] md:grid-cols-[32px_minmax(0,1.4fr)_120px_minmax(0,1fr)_110px_16px] items-center gap-x-4 px-2.5 h-14 rounded-[14px] text-left hover:bg-hover transition-colors duration-150 outline-none focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <span className="inline-flex size-8 items-center justify-center rounded-full bg-hover text-fg-muted">
                      <SessionsIcon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[14px] font-medium text-fg truncate">
                        {s.title || "Untitled"}
                      </span>
                      <span className="block font-mono text-[11.5px] text-fg-subtle truncate">{s.id}</span>
                    </span>
                    <span className="hidden md:block">
                      <StatusPill status={s.status || "idle"} />
                    </span>
                    <span className="hidden md:block font-mono text-[12px] text-fg-muted truncate">
                      {s.agent_id}
                    </span>
                    <span className="text-[12.5px] text-fg-muted text-right tabular-nums" title={new Date(s.created_at).toLocaleString()}>
                      {formatRelative(Date.now() - new Date(s.created_at).getTime())}
                    </span>
                    <ChevronRight className="hidden md:block size-4 text-fg-subtle" />
                  </button>
                  {i < recentSessions.length - 1 && (
                    <div aria-hidden="true" className="ml-[58px] mr-2.5 h-px bg-border" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
