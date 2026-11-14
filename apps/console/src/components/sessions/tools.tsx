import { createContext, useContext, useMemo, useState, type ComponentType, type ReactNode } from "react";
import {
  AlarmClockIcon,
  BrainIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  FilePenLineIcon,
  FileSearchIcon,
  FileTextIcon,
  FolderSearchIcon,
  GlobeIcon,
  LayersIcon,
  ListChecksIcon,
  PlugIcon,
  SearchIcon,
  TerminalIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";

import { parseSearchMcpTools } from "@/lib/deferred-mcp";
import { useAgents } from "@/lib/directory";
import { cn } from "@/lib/utils";
import { inlineLink, standaloneLink } from "@/lib/links";

import { AgentAvatar } from "../AgentAvatar";
import { BRAND_MARKS } from "../brand-marks";
import { CodeWell, EventCard } from "../EventCard";
import { GitHubIcon, LinearIcon, SlackIcon } from "../icons";
import { CopyButton } from "../IdChip";
import { Markdown } from "../Markdown";
import type { EventStatus } from "../EventCard";
import { formatElapsed, handoffKey, handoffKeyOf, type ToolCall } from "./model";

/**
 * How a tool call is shown: its icon, name, a one-line preview of what it
 * was asked to do, and a body shaped for the tool (a command and its
 * output for bash, a file and its contents for read/write, results for a
 * web search, named arguments for an MCP call).
 *
 * Everything renders through the shared <EventCard>, so calls look the same
 * in the conversation, in an approval card and in the timeline inspector.
 */

type IconType = ComponentType<{ className?: string }>;

/** Brand marks from icons.tsx default to 16px; keep them on the 14px optical size of a filled glyph. */
const brand = (Icon: IconType): IconType =>
  function BrandMark({ className }: { className?: string }) {
    return <Icon className={cn("size-4 p-px", className)} />;
  };

/** MCP servers and apps people know by name. Anything else is title-cased. */
const SERVERS: Record<string, { label: string; icon?: IconType }> = {
  linear: { label: "Linear", icon: brand(LinearIcon) },
  github: { label: "GitHub", icon: brand(GitHubIcon) },
  slack: { label: "Slack", icon: brand(SlackIcon) },
  notion: { label: "Notion" },
  sentry: { label: "Sentry" },
  stripe: { label: "Stripe" },
  intercom: { label: "Intercom" },
  zendesk: { label: "Zendesk" },
  pagerduty: { label: "PagerDuty" },
  composio: { label: "Composio" },
  hubspot: { label: "HubSpot" },
  jira: { label: "Jira" },
  gmail: { label: "Gmail" },
  googledrive: { label: "Google Drive" },
  airtable: { label: "Airtable" },
  asana: { label: "Asana" },
};

/** The app's own vendored mark (components/brand-marks.ts), as an icon. One component per app, made once. */
const markIcons = new Map<string, IconType>();
function markIcon(key: string): IconType | undefined {
  const path = BRAND_MARKS[key] ?? BRAND_MARKS[key.replace(/(mcp|app|cloud)$/, "")];
  if (!path) return undefined;
  let icon = markIcons.get(key);
  if (!icon) {
    icon = function AppMark({ className }: { className?: string }) {
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={cn("size-4 p-px", className)}>
          <path d={path} />
        </svg>
      );
    };
    markIcons.set(key, icon);
  }
  return icon;
}

export function serverInfo(server: string | undefined): { label: string; icon: IconType } {
  const key = (server ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const known = SERVERS[key];
  if (known) return { label: known.label, icon: known.icon ?? markIcon(key) ?? PlugIcon };
  const label = (server ?? "").replace(/[-_]+/g, " ").trim();
  return { label: label ? label[0].toUpperCase() + label.slice(1) : "App", icon: markIcon(key) ?? PlugIcon };
}

const BUILT_IN: Record<string, { icon: IconType; verb: string }> = {
  bash: { icon: TerminalIcon, verb: "run a command" },
  shell: { icon: TerminalIcon, verb: "run a command" },
  read: { icon: FileTextIcon, verb: "read a file" },
  write: { icon: FilePenLineIcon, verb: "write a file" },
  edit: { icon: FilePenLineIcon, verb: "edit a file" },
  multiedit: { icon: FilePenLineIcon, verb: "edit a file" },
  glob: { icon: FolderSearchIcon, verb: "list files" },
  grep: { icon: FileSearchIcon, verb: "search files" },
  web_search: { icon: SearchIcon, verb: "search the web" },
  websearch: { icon: SearchIcon, verb: "search the web" },
  web_fetch: { icon: GlobeIcon, verb: "open a web page" },
  webfetch: { icon: GlobeIcon, verb: "open a web page" },
  browser: { icon: GlobeIcon, verb: "use the browser" },
  schedule: { icon: AlarmClockIcon, verb: "schedule a wake-up" },
  memory: { icon: BrainIcon, verb: "use its memory" },
  todowrite: { icon: ListChecksIcon, verb: "update its task list" },
  task: { icon: UsersRoundIcon, verb: "delegate to another agent" },
  general_subagent: { icon: UsersRoundIcon, verb: "delegate to another agent" },
};

const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

/**
 * Slack-style shortcodes an agent writes into a message (":rotating_light:").
 * A one-line preview shows what the reader in Slack would see: the common
 * ones become their emoji, and any other shortcode is dropped rather than
 * printed as markup. The full input, exactly as sent, is in the open card.
 */
const SHORTCODES: Record<string, string> = {
  rotating_light: "🚨", warning: "⚠️", white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌",
  red_circle: "🔴", large_orange_circle: "🟠", large_yellow_circle: "🟡", large_green_circle: "🟢",
  fire: "🔥", eyes: "👀", tada: "🎉", rocket: "🚀", bug: "🐛", memo: "📝", pushpin: "📌",
  point_right: "👉", bell: "🔔", hourglass: "⏳", mag: "🔍", wrench: "🔧", link: "🔗",
  chart_with_upwards_trend: "📈", chart_with_downwards_trend: "📉", information_source: "ℹ️",
  thumbsup: "👍", "+1": "👍", wave: "👋", thread: "🧵", lock: "🔒", zap: "⚡", sos: "🆘",
};
// Only a shortcode that stands alone as a word is read, so "10:30:45" and
// "host:8080:tcp" are left as they are.
const readShortcodes = (s: string): string =>
  s
    .replace(/(^|\s):([a-z+][a-z0-9_+-]{1,31}):(?=\s|$|[.,!?])/g, (_, lead: string, code: string) => lead + (SHORTCODES[code] ?? ""))
    .replace(/\s{2,}/g, " ");

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
/** A one-line preview of prose (a message, a title): shortcodes are read. */
const oneLineText = (s: string, max = 120): string => oneLine(readShortcodes(s.replace(/\s+/g, " ")), max);

export interface ToolPresentation {
  icon: IconType;
  /** App / MCP server display name, shown before the tool name. */
  source?: string;
  /** The tool name as the agent calls it. */
  title: string;
  /** One-line preview of the input. */
  preview?: string;
  /** "run a command" — completes "<Agent> wants to …". */
  verb: string;
  kind: "tool" | "mcp";
  /** The title is words ("Searched Linear tools"), not a tool's name: set it in the text face. */
  plain?: boolean;
}

/** SDK harnesses name MCP tools `mcp__<server>__<tool>`. */
function splitMcpName(name: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1], tool: m[2] } : null;
}

function previewOf(name: string, input: Record<string, unknown>): string | undefined {
  const n = name.toLowerCase();
  if (n === "bash" || n === "shell") return text(input.command) && oneLine(String(input.command));
  if (n === "read") {
    const path = text(input.file_path) ?? text(input.path);
    if (!path) return undefined;
    const offset = typeof input.offset === "number" ? input.offset : undefined;
    const limit = typeof input.limit === "number" ? input.limit : undefined;
    if (offset == null) return path;
    return limit ? `${path}  lines ${offset}–${offset + limit - 1}` : `${path}  from line ${offset}`;
  }
  if (n === "write" || n === "edit" || n === "multiedit") return text(input.file_path) ?? text(input.path);
  if (n === "glob" || n === "grep") return text(input.pattern) ?? text(input.query);
  if (n === "web_search" || n === "websearch") return text(input.query) && `“${oneLine(String(input.query), 120)}”`;
  if (n === "web_fetch" || n === "webfetch") return text(input.url)?.replace(/^https?:\/\//, "");
  // Anything else: the first argument that reads as the "subject" of the call.
  for (const key of ["query", "q", "title", "name", "text", "body", "prompt", "url", "path", "channel", "issueId", "issue_id", "id"]) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) return oneLineText(v, 120);
  }
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") parts.push(`${k}: ${v}`);
    if (parts.length === 3) break;
  }
  return parts.length ? oneLineText(parts.join(" · "), 120) : undefined;
}

export function presentTool(call: Pick<ToolCall, "name" | "server" | "flavor" | "input">): ToolPresentation {
  const split = call.flavor !== "mcp" ? splitMcpName(call.name) : null;
  if (call.flavor === "mcp" || split) {
    const server = serverInfo(call.server ?? split?.server);
    const tool = split?.tool ?? call.name;
    return {
      icon: server.icon,
      source: server.label,
      title: tool,
      preview: previewOf(tool, call.input),
      verb: `use ${server.label} (${tool.replace(/_/g, " ")})`,
      kind: "mcp",
    };
  }
  // A deferred MCP server's tools are found by search first
  // (`search_mcp_tools`): say what was looked for, and where.
  const search = call.flavor === "tool" ? parseSearchMcpTools(call.name, call.input) : null;
  if (search) {
    const where = search.server ? serverInfo(search.server).label : null;
    return {
      icon: SearchIcon,
      title: where ? `Searched ${where} tools` : "Searched all tools",
      preview: `“${oneLine(search.query, 120)}”`,
      verb: where ? `search ${where}'s tools` : "search its tools",
      kind: "tool",
      plain: true,
    };
  }
  // One agent asking another. The name is resolved where the directory is
  // at hand (<HandoffCard>); here it is at least never the raw tool name.
  if (handoffKey(call.name)) {
    return {
      icon: UsersRoundIcon,
      title: "Hand-off",
      preview: text(call.input.message) && oneLineText(String(call.input.message), 120),
      verb: "ask another agent for help",
      kind: "tool",
    };
  }
  const builtIn = BUILT_IN[call.name.toLowerCase()];
  return {
    icon: builtIn?.icon ?? WrenchIcon,
    title: call.name,
    preview: previewOf(call.name, call.input),
    verb: builtIn?.verb ?? `use ${call.name}`,
    kind: "tool",
  };
}

// ── long output that collapses well ─────────────────────────────────────

const COLLAPSED_LINES = 12;

/**
 * The provider's exact response to a failed request, folded away. An error
 * card leads with the cause in plain words and what to do next; the raw
 * text is one click down for whoever needs the status code or request id.
 */
export function ProviderResponse({ children, label = "Provider response" }: { children: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1.5 inline-flex h-7 items-center gap-1 rounded-full pr-2.5 pl-1.5 text-xs font-medium text-fg-muted transition-quick hover:bg-bg-hover hover:text-fg"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
            open && "rotate-90",
          )}
        />
        {label}
      </button>
      {open && (
        <OutputWell tone="danger" className="mt-1.5 animate-fade-in">
          {children}
        </OutputWell>
      )}
    </div>
  );
}

/**
 * A code well for output of any length. Up to 12 lines it is shown whole.
 * Beyond that it is cut with a soft fade and a "Show all 86 lines" control;
 * expanded, it scrolls inside a taller well so a 5,000-line log never takes
 * over the conversation.
 */
export function OutputWell({
  children,
  tone = "neutral",
  className,
}: {
  children: string;
  tone?: "neutral" | "danger";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const lines = useMemo(() => children.split("\n"), [children]);
  const long = lines.length > COLLAPSED_LINES + 3 || children.length > 2400;
  if (!long) {
    return (
      <CodeWell tone={tone} className={className}>
        {children}
      </CodeWell>
    );
  }
  const head = lines.length > COLLAPSED_LINES ? lines.slice(0, COLLAPSED_LINES).join("\n") : children.slice(0, 1200);
  return (
    <div className="relative">
      <CodeWell tone={tone} className={cn(open ? "max-h-[28rem] pb-11" : "max-h-none overflow-hidden pb-10", className)}>
        {open ? children : head}
      </CodeWell>
      <div
        className={cn(
          "pointer-events-none absolute inset-x-px bottom-px flex items-end justify-center rounded-b-md pb-2",
          open ? "h-10" : "h-16 bg-gradient-to-t from-bg-surface from-40% to-transparent dark:from-bg-inset",
        )}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="pointer-events-auto inline-flex h-7 items-center gap-1 rounded-full border border-border bg-bg-raised px-2.5 text-xs font-medium text-fg-muted shadow-[var(--shadow-xs)] transition-quick hover:border-border-strong hover:text-fg"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
              open ? "-rotate-90" : "rotate-90",
            )}
          />
          {open ? "Show less" : lines.length > COLLAPSED_LINES ? `Show all ${lines.length.toLocaleString()} lines` : "Show all"}
        </button>
      </div>
    </div>
  );
}

function sizeHint(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const n = s.split("\n").length;
  return n > 1 ? `${n.toLocaleString()} lines` : undefined;
}

/** A labelled part of a tool body, with an optional quiet hint beside the label. */
function Part({ label, hint, copy, children }: { label: string; hint?: string; copy?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex h-6 items-center gap-2">
        <span className="text-xs font-medium text-fg-subtle">{label}</span>
        {hint && <span className="text-xs text-fg-subtle">{hint}</span>}
        {copy !== undefined && <CopyButton value={copy} label={`Copy ${label.toLowerCase()}`} className="ml-auto size-6" />}
      </div>
      {children}
    </div>
  );
}

/** Named arguments as a quiet definition list; long text keeps its line breaks. */
function Arguments({ input }: { input: Record<string, unknown> }) {
  const entries = Object.entries(input);
  if (entries.length === 0) return <p className="text-small text-fg-subtle">No arguments.</p>;
  return (
    <dl className="grid grid-cols-[minmax(4.5rem,max-content)_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-border bg-bg-surface px-3 py-2.5 dark:bg-bg-inset">
      {entries.map(([k, v]) => {
        const scalar = typeof v === "string" || typeof v === "number" || typeof v === "boolean";
        return (
          <div key={k} className="col-span-2 grid grid-cols-subgrid items-baseline">
            <dt className="font-mono text-xs text-fg-subtle">{k}</dt>
            <dd
              className={cn(
                "min-w-0 text-xs leading-relaxed break-words text-fg",
                scalar && typeof v === "string" ? "whitespace-pre-wrap" : "font-mono whitespace-pre-wrap",
              )}
            >
              {scalar ? String(v) : JSON.stringify(v, null, 2)}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

/** "1. Title — https://… (date)" lines from web_search, as links. */
function parseSearchResults(out: string): Array<{ title: string; url: string; meta?: string }> | null {
  const rows: Array<{ title: string; url: string; meta?: string }> = [];
  for (const line of out.split("\n")) {
    const l = line.trim();
    if (!l) continue;
    const m = /^\d+[.)]\s+(.*?)\s+[—–-]\s+(https?:\/\/\S+)(?:\s+\((.+)\))?$/.exec(l);
    if (!m) return null;
    rows.push({ title: m[1].replace(/^"|"$/g, ""), url: m[2], meta: m[3] });
  }
  return rows.length ? rows : null;
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(standaloneLink, "max-w-full min-w-0 gap-1.5 text-small")}
    >
      <span className="truncate">{children}</span>
      <ExternalLinkIcon className="size-3.5 shrink-0" />
    </a>
  );
}

/** The open body of a tool call, shaped for the tool. */
export function ToolBody({ call }: { call: ToolCall }) {
  const p = presentTool(call);
  const n = (p.kind === "mcp" ? "" : call.name).toLowerCase();
  const { input, output } = call;
  const outTone = call.isError ? "danger" : "neutral";
  const outLabel = call.isError ? "Error" : "Output";
  const waiting =
    !call.result &&
    (call.status === "running"
      ? "Still running…"
      : call.status === "waiting"
        ? "This is a custom tool: the app that started the session runs it and sends back the result. The agent carries on once it does."
        : call.approval === "denied"
        ? call.denyMessage
          ? `Denied, so the call did not run. The agent was told: “${call.denyMessage}”`
          : "Denied, so the call did not run."
        : null);

  const outputPart =
    output !== undefined ? (
      <Part label={outLabel} hint={sizeHint(output)} copy={output}>
        {output.trim() ? <OutputWell tone={outTone}>{output}</OutputWell> : <p className="text-small text-fg-subtle">No output.</p>}
      </Part>
    ) : waiting ? (
      <p className="text-small text-fg-subtle">{waiting}</p>
    ) : null;

  if (n === "bash" || n === "shell") {
    const command = text(input.command) ?? "";
    return (
      <>
        <Part label="Command" copy={command}>
          <CodeWell>
            <span className="text-fg-faint select-none">$ </span>
            {command}
          </CodeWell>
        </Part>
        {outputPart}
      </>
    );
  }

  if (n === "read" || n === "write" || n === "edit" || n === "multiedit") {
    const path = text(input.file_path) ?? text(input.path) ?? "";
    const content = text(input.content);
    const oldStr = text(input.old_string);
    const newStr = text(input.new_string);
    return (
      <>
        <Part label="File" copy={path}>
          <p className="font-mono text-xs break-all text-fg">{path || "Not given"}</p>
        </Part>
        {content !== undefined && (
          <Part label="Content" hint={sizeHint(content)} copy={content}>
            <OutputWell>{content}</OutputWell>
          </Part>
        )}
        {oldStr !== undefined && (
          <Part label="Replace">
            <OutputWell tone="danger">{oldStr}</OutputWell>
          </Part>
        )}
        {newStr !== undefined && (
          <Part label="With">
            <OutputWell>{newStr}</OutputWell>
          </Part>
        )}
        {output !== undefined &&
          (n === "read" || call.isError ? (
            <Part label={call.isError ? "Error" : "Contents"} hint={sizeHint(output)} copy={output}>
              <OutputWell tone={outTone}>{output}</OutputWell>
            </Part>
          ) : (
            <p className="text-small text-fg-muted">{output}</p>
          ))}
        {output === undefined && waiting && <p className="text-small text-fg-subtle">{waiting}</p>}
      </>
    );
  }

  if (n === "web_search" || n === "websearch") {
    const results = output && !call.isError ? parseSearchResults(output) : null;
    return (
      <>
        <Part label="Query">
          <p className="text-small text-fg">{text(input.query) ?? "Not given"}</p>
        </Part>
        {results ? (
          <Part label="Results" hint={`${results.length}`}>
            <ol className="divide-y divide-border overflow-hidden rounded-md border border-border bg-bg-surface dark:bg-bg-inset">
              {results.map((r) => (
                <li key={r.url}>
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-3 px-3 py-2 transition-quick hover:bg-bg-hover"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-small font-medium text-fg">{r.title}</span>
                      <span className="block truncate text-xs text-fg-subtle">
                        {hostOf(r.url)}
                        {r.meta ? ` · ${r.meta}` : ""}
                      </span>
                    </span>
                    <ExternalLinkIcon className="size-3.5 shrink-0 text-fg-faint" />
                  </a>
                </li>
              ))}
            </ol>
          </Part>
        ) : (
          outputPart
        )}
      </>
    );
  }

  if (n === "web_fetch" || n === "webfetch") {
    const url = text(input.url);
    const prompt = text(input.prompt);
    return (
      <>
        <Part label="Page">{url ? <ExternalLink href={url}>{url.replace(/^https?:\/\//, "")}</ExternalLink> : <p className="text-small text-fg-subtle">Not given</p>}</Part>
        {prompt && (
          <Part label="Asked for">
            <p className="text-small text-fg">{prompt}</p>
          </Part>
        )}
        {output !== undefined ? (
          <Part label={call.isError ? "Error" : "Extract"} hint={sizeHint(output)} copy={output}>
            <OutputWell tone={outTone} className="font-sans text-small">
              {output}
            </OutputWell>
          </Part>
        ) : (
          waiting && <p className="text-small text-fg-subtle">{waiting}</p>
        )}
      </>
    );
  }

  // MCP calls, custom tools and anything unrecognised: named arguments + result.
  const hasInput = Object.keys(input).length > 0;
  return (
    <>
      {(hasInput || call.use !== call.result) && (
        <Part label="Arguments" copy={hasInput ? JSON.stringify(input, null, 2) : undefined}>
          <Arguments input={input} />
        </Part>
      )}
      {output !== undefined ? (
        <Part label={call.isError ? "Error" : "Result"} hint={sizeHint(output)} copy={output}>
          {output.trim() ? <OutputWell tone={outTone}>{output}</OutputWell> : <p className="text-small text-fg-subtle">Empty result.</p>}
        </Part>
      ) : (
        waiting && <p className="text-small text-fg-subtle">{waiting}</p>
      )}
    </>
  );
}

/** Just the exact input, for an approval card: what will run if you allow it. */
export function ToolInputPreview({ call }: { call: ToolCall }) {
  const n = call.name.toLowerCase();
  if ((n === "bash" || n === "shell") && typeof call.input.command === "string") {
    return (
      <CodeWell>
        <span className="text-fg-faint select-none">$ </span>
        {call.input.command}
      </CodeWell>
    );
  }
  return <Arguments input={call.input} />;
}

// ── cards ───────────────────────────────────────────────────────────────

/**
 * How to open a sub-agent's thread from inside the conversation (a hand-off
 * row offers it). Null where there are no threads to go to: the timeline's
 * inspector, an eval trial.
 */
export const ThreadNav = createContext<((threadId: string) => void) | null>(null);

/** Who a hand-off went to, by name: from the thread it started, else from the workspace's agents. */
export function useHandoffAgent(call: Pick<ToolCall, "handoff">): { id?: string; name: string } {
  const { agents, byId } = useAgents();
  const h = call.handoff;
  const known = h?.agentId ? byId.get(h.agentId) : agents.find((a) => handoffKeyOf(a.id) === h?.agentKey);
  return { id: known?.id ?? h?.agentId, name: h?.agentName ?? known?.name ?? "another agent" };
}

/**
 * One agent asking another for help. The row names who was asked and shows
 * the opening of the request; open, it holds the whole request, the answer
 * that came back and the way into that agent's own thread.
 */
function HandoffCard({ call, defaultOpen }: { call: ToolCall; defaultOpen?: boolean }) {
  const agent = useHandoffAgent(call);
  const openThread = useContext(ThreadNav);
  const message = text(call.input.message) ?? "";
  const threadId = call.handoff?.threadId;
  const Face = useMemo(
    () =>
      function HandoffFace() {
        return <AgentAvatar name={agent.name} id={agent.id} size="xs" className="shrink-0" />;
      },
    [agent.id, agent.name],
  );
  return (
    <EventCard
      kind="tool"
      icon={Face}
      title={<span className="font-sans">Asked {agent.name}</span>}
      subtitle={message ? <span className="font-sans text-small">{oneLineText(message, 160)}</span> : undefined}
      status={glyphOf(call.status)}
      meta={call.durationMs != null ? formatElapsed(call.durationMs) : undefined}
      defaultOpen={defaultOpen}
    >
      {message && (
        <Part label="The request" copy={message}>
          <p className="rounded-md bg-bg-surface px-3 py-2.5 text-small leading-relaxed break-words whitespace-pre-wrap text-fg dark:bg-bg-inset">
            {message}
          </p>
        </Part>
      )}
      {call.output !== undefined ? (
        <Part label={call.isError ? "Error" : `What ${agent.name} answered`} copy={call.output}>
          {call.isError ? (
            <OutputWell tone="danger">{call.output}</OutputWell>
          ) : (
            <div className="rounded-md bg-bg-surface px-3 py-2.5 text-small leading-relaxed text-fg dark:bg-bg-inset">
              <Markdown>{call.output}</Markdown>
            </div>
          )}
        </Part>
      ) : (
        call.status === "running" && <p className="text-small text-fg-subtle">{agent.name} is still working on it.</p>
      )}
      {threadId && openThread && (
        <p className="text-small">
          <button type="button" onClick={() => openThread(threadId)} className={inlineLink}>
            Open {agent.name}'s thread
          </button>
        </p>
      )}
    </EventCard>
  );
}

/** The row's state glyph: a custom tool the app still owes has none (its meta says so). */
const glyphOf = (status: ToolCall["status"]): EventStatus | undefined => (status === "waiting" ? "pending" : status);

/** One tool or MCP call as a 40px row that opens to its body. */
export function ToolCallCard({ call, defaultOpen }: { call: ToolCall; defaultOpen?: boolean }) {
  if (call.handoff) return <HandoffCard call={call} defaultOpen={defaultOpen} />;
  const p = presentTool(call);
  const meta =
    call.status === "waiting"
      ? "Waiting for the app's result"
      : call.approval === "denied"
        ? "Denied"
        : [call.approval === "allowed" ? "Approved" : null, call.durationMs != null ? formatElapsed(call.durationMs) : null]
            .filter(Boolean)
            .join(" · ") || undefined;
  return (
    <EventCard
      kind={p.kind}
      icon={p.icon}
      source={p.source}
      title={p.plain ? <span className="font-sans">{p.title}</span> : p.title}
      subtitle={p.preview}
      status={glyphOf(call.status)}
      meta={meta}
      defaultOpen={defaultOpen}
    >
      <ToolBody call={call} />
    </EventCard>
  );
}

const RUN_LIMIT = 4;

/**
 * A run of consecutive tool calls. Up to four are stacked as rows. A longer
 * run folds into one "7 tool calls" row that names what was used and opens
 * to the full stack; it stays open while a call is running or has failed.
 */
export function ToolRun({ calls }: { calls: ToolCall[] }) {
  const needsEyes = calls.some((c) => c.status === "running" || c.status === "errored" || c.status === "waiting");
  const [open, setOpen] = useState(needsEyes);
  const expanded = open || needsEyes;

  if (calls.length <= RUN_LIMIT) {
    return (
      <div className="space-y-1.5">
        {calls.map((c) => (
          <ToolCallCard key={c.key} call={c} />
        ))}
      </div>
    );
  }

  const counts = new Map<string, number>();
  for (const c of calls) {
    const p = presentTool(c);
    const label = p.source ?? p.title;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = Array.from(counts.entries())
    .map(([label, n]) => (n > 1 ? `${label} ×${n}` : label))
    .join(" · ");
  const total = calls.reduce((ms, c) => ms + (c.durationMs ?? 0), 0);
  const failed = calls.filter((c) => c.status === "errored").length;

  return (
    <div className="rounded-lg bg-bg-soft">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setOpen(!expanded)}
        className="flex h-10 w-full min-w-0 items-center gap-2.5 rounded-lg pr-3 pl-2.5 text-left transition-quick hover:bg-bg-hover"
      >
        <LayersIcon className="size-4 shrink-0 text-fg-subtle" />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-small font-medium text-fg">{calls.length} tool calls</span>
          <span className="min-w-0 truncate text-xs text-fg-subtle">{summary}</span>
        </span>
        {failed > 0 && <span className="shrink-0 text-xs font-medium text-danger">{failed} failed</span>}
        {total > 0 && <span className="shrink-0 text-xs text-fg-subtle">{formatElapsed(total)}</span>}
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-fg-faint transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
            expanded && "rotate-90",
          )}
        />
      </button>
      {expanded && (
        <div className="animate-fade-in space-y-1 px-1.5 pb-1.5">
          {calls.map((c) => (
            <ToolCallCard key={c.key} call={c} />
          ))}
        </div>
      )}
    </div>
  );
}
