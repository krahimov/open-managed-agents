import { useEffect, useMemo, useRef, useState } from "react";
import yaml from "js-yaml";
import { PuzzleIcon, TerminalIcon, WrenchIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import { AppIcon } from "../../../components/agents/controls";
import { harnessFieldLabel } from "../../../components/HarnessDiffCard";
import {
  Chip,
  CodeWell,
  CopyButton,
  EntityAvatar,
  ErrorState,
  ModelBadge,
  RelativeTime,
  SegmentedControl,
  Skeleton,
} from "../../../components/kit";
import type { AgentRecord } from "../../../types/agent";
import { TOOL_POLICY, localBrandIcon, summarizeTools } from "../detail/parts";

/** The agent's configuration as the setup view tracks it: the fields the
 *  agent can rewrite about itself. */
export type Harness = Record<string, unknown>;

type View = "summary" | "yaml";

const DOCUMENT_SKILL: Record<string, string> = {
  xlsx: "Excel spreadsheets",
  pdf: "PDF documents",
  pptx: "PowerPoint decks",
  docx: "Word documents",
};

export function harnessToYaml(harness: Harness): string {
  try {
    return yaml.dump(harness, { lineWidth: 80, noRefs: true });
  } catch {
    return JSON.stringify(harness, null, 2);
  }
}

/**
 * The live configuration beside the setup chat: what the agent is, right
 * now, as it rewrites itself. The summary reads like the agent's profile
 * (name, model, instructions, what it can reach); the same data is one
 * switch away as YAML. Parts the agent has just changed are marked.
 *
 * It is a panel, not a card: it sits on the canvas with a left hairline,
 * like the context panel of a session.
 */
export function ConfigPanel({
  harness,
  loading,
  error,
  retry,
  changed,
  changedAt,
  className,
}: {
  harness: Harness;
  loading: boolean;
  error: unknown;
  retry: () => void;
  /** Fields the agent changed in its latest update. */
  changed: string[];
  /** When that update arrived (ms). */
  changedAt: number | null;
  className?: string;
}) {
  const [view, setView] = useState<View>("summary");
  const yamlText = useMemo(() => harnessToYaml(harness), [harness]);
  const empty = Object.keys(harness).length === 0;

  return (
    <aside aria-label="Configuration" className={cn("flex min-h-0 flex-col", className)}>
      <div className="flex shrink-0 items-center gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 flex-1">
          <h2 className="text-h3 text-fg">Configuration</h2>
          <p className="truncate text-xs text-fg-subtle">
            {changedAt ? (
              <>
                The agent changed it <RelativeTime value={changedAt} />
              </>
            ) : (
              "Updates as the agent rewrites itself."
            )}
          </p>
        </div>
        <SegmentedControl<View>
          label="Configuration view"
          size="sm"
          value={view}
          onChange={setView}
          options={[
            { value: "summary", label: "Summary" },
            { value: "yaml", label: "YAML" },
          ]}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-8">
        {error ? (
          <ErrorState title="The configuration could not be loaded" error={error} retry={retry} />
        ) : loading ? (
          <PanelSkeleton />
        ) : empty ? (
          <p className="text-small text-fg-subtle">Nothing is configured yet. It will appear here as the agent sets itself up.</p>
        ) : view === "yaml" ? (
          <div className="relative">
            <CodeWell className="max-h-none py-3.5 pr-10 whitespace-pre">{yamlText}</CodeWell>
            <CopyButton value={yamlText} label="Copy YAML" className="absolute top-2 right-2" />
          </div>
        ) : (
          <Summary harness={harness} changed={changed} />
        )}
      </div>
    </aside>
  );
}

function Summary({ harness, changed }: { harness: Harness; changed: string[] }) {
  const name = typeof harness.name === "string" ? harness.name : "";
  const description = typeof harness.description === "string" ? harness.description : "";
  const model = typeof harness.model === "string" ? harness.model : "";
  const system = typeof harness.system === "string" ? harness.system : "";
  const skills = (Array.isArray(harness.skills) ? harness.skills : []) as Array<{ type?: string; skill_id?: string }>;
  const tools = useMemo(
    () => summarizeTools({ tools: harness.tools, mcp_servers: harness.mcp_servers } as unknown as AgentRecord),
    [harness.tools, harness.mcp_servers],
  );

  const { data: skillsRes, isLoading: skillsLoading } = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    skills.length > 0 ? "/v1/skills" : null,
  );
  const skillName = useMemo(() => new Map((skillsRes?.data ?? []).map((s) => [s.id, s.name])), [skillsRes]);

  const was = (field: string) => changed.includes(field);
  const hasTools = !!tools.builtIn || tools.custom.length > 0 || tools.servers.length > 0;

  return (
    <div className="space-y-6">
      <Group label="Agent" changed={was("name") || was("description")}>
        <p className="text-h3 break-words text-fg">{name || <span className="text-fg-subtle">Unnamed agent</span>}</p>
        <p className="mt-0.5 text-small text-fg-muted">{description || <span className="text-fg-subtle">No description yet.</span>}</p>
      </Group>

      <Group label={harnessFieldLabel("model")} changed={was("model")}>
        {model ? <ModelBadge model={model} /> : <span className="text-small text-fg-subtle">Not chosen yet</span>}
      </Group>

      <Group label={harnessFieldLabel("system")} changed={was("system")}>
        {system.trim() ? (
          <ClampedText text={system} />
        ) : (
          <p className="text-small text-fg-subtle">No instructions yet. Tell the agent what it is for and it will write them.</p>
        )}
      </Group>

      <Group label="Tools and apps" changed={was("tools") || was("mcp_servers")}>
        {!hasTools ? (
          <p className="text-small text-fg-subtle">No tools. It can only talk.</p>
        ) : (
          <ul className="space-y-2.5">
            {tools.builtIn && (
              <Row
                leading={<EntityAvatar icon={TerminalIcon} size="md" />}
                title="Built-in tools"
                description={
                  tools.builtIn.off.length > 0
                    ? `${tools.builtIn.off.length} turned off`
                    : "Files, shell, web and scheduling"
                }
                trailing={
                  <Chip tone={TOOL_POLICY[tools.builtIn.policy].tone} title={TOOL_POLICY[tools.builtIn.policy].title}>
                    {TOOL_POLICY[tools.builtIn.policy].label}
                  </Chip>
                }
              />
            )}
            {tools.custom.map((tool) => (
              <Row
                key={`custom-${tool.name}`}
                leading={<EntityAvatar icon={WrenchIcon} size="md" />}
                title={<span className="font-mono text-xs font-normal">{tool.name}</span>}
                description={tool.description || "Custom tool"}
              />
            ))}
            {tools.servers.map((server) => {
              const Brand = localBrandIcon(server.name);
              return (
                <Row
                  key={`mcp-${server.name}`}
                  leading={Brand ? <EntityAvatar icon={Brand} size="md" /> : <AppIcon name={server.label} size="md" />}
                  title={server.label}
                  description={server.host ? `MCP server · ${server.host}` : "MCP server"}
                />
              );
            })}
          </ul>
        )}
      </Group>

      {skills.length > 0 && (
        <Group label={harnessFieldLabel("skills")} changed={was("skills")}>
          <ul className="flex flex-wrap gap-1.5">
            {skills.map((s, i) => {
              const id = s.skill_id ?? "";
              const known = skillName.get(id) ?? (s.type === "anthropic" ? (DOCUMENT_SKILL[id] ?? id) : undefined);
              return (
                <li key={`${id}-${i}`}>
                  {known ? (
                    <Chip icon={PuzzleIcon}>{known}</Chip>
                  ) : skillsLoading ? (
                    <Skeleton className="h-[22px] w-24" rounded="full" />
                  ) : (
                    <Chip icon={PuzzleIcon} title={id}>
                      Removed skill
                    </Chip>
                  )}
                </li>
              );
            })}
          </ul>
        </Group>
      )}
    </div>
  );
}

/** A quiet labelled group, with a mark when the agent has just changed it. */
function Group({ label, changed, children }: { label: string; changed?: boolean; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-1.5 flex h-[22px] items-center gap-2">
        <h3 className="text-xs font-medium text-fg-subtle">{label}</h3>
        {changed && (
          <Chip tone="success" className="animate-pop-in">
            Updated
          </Chip>
        )}
      </div>
      {children}
    </section>
  );
}

function Row({
  leading,
  title,
  description,
  trailing,
}: {
  leading: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  trailing?: React.ReactNode;
}) {
  return (
    <li className="flex items-center gap-3">
      {leading}
      <div className="min-w-0 flex-1">
        <div className="truncate text-small leading-5 font-medium text-fg">{title}</div>
        {description && (
          <div className="truncate text-xs text-fg-subtle" title={typeof description === "string" ? description : undefined}>
            {description}
          </div>
        )}
      </div>
      {trailing}
    </li>
  );
}

/** Long instructions, folded to about ten lines until asked for. */
function ClampedText({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > 232);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);
  return (
    <div>
      <div className={cn("relative", !open && "max-h-[14.25rem] overflow-hidden")}>
        <p ref={ref} className="text-small leading-relaxed break-words whitespace-pre-line text-fg">
          {text}
        </p>
        {!open && overflows && (
          <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-bg to-transparent" />
        )}
      </div>
      {overflows && (
        <Button variant="secondary" size="xs" className="mt-2.5" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? "Show less" : "Show all"}
        </Button>
      )}
    </div>
  );
}

function PanelSkeleton() {
  return (
    <div className="space-y-6" aria-hidden="true">
      <div className="space-y-2">
        <Skeleton className="h-3 w-12" rounded="sm" />
        <Skeleton className="h-4 w-44" rounded="sm" />
        <Skeleton className="h-3.5 w-full" rounded="sm" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-12" rounded="sm" />
        <Skeleton className="h-[22px] w-24" rounded="full" />
      </div>
      <div className="space-y-2">
        <Skeleton className="h-3 w-20" rounded="sm" />
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className={cn("h-3.5", i === 4 ? "w-3/5" : "w-full")} rounded="sm" />
        ))}
      </div>
      <div className="space-y-2.5">
        <Skeleton className="h-3 w-24" rounded="sm" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3">
            <Skeleton className="size-8" rounded="lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-28" rounded="sm" />
              <Skeleton className="h-3 w-40" rounded="sm" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
