import { useMemo, useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import { DEFAULT_REASONING_LEVEL, REASONING_LEVEL_LABELS, isReasoningLevel } from "@open-managed-agents/api-types";

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { FACE_METADATA_KEY, describeFace, naturalFace, parseFace } from "@/lib/agent-face";
import { describeModel, modelId } from "@/lib/models";
import { cn } from "@/lib/utils";

import { DiffLines, collapseContext, diffLines, hasChanges, valueToLines, type DiffRow } from "../../../components/agents/diff";
import { Chip, ErrorState, ModelBadge, RelativeTime, SectionCard, Skeleton, StatusBadge } from "../../../components/kit";
import type { AgentRecord } from "../../../types/agent";
import { AgentVersionComparison } from "../AgentVersionComparison";
import { MEMORY_MODE_LABELS, parseMemoryMode } from "../../../components/MemoryModeControl";
import { engineLabel } from "../form/model";

/** A level as people read it; unset is the default, said as such. */
function reasoningWords(level: unknown): string {
  if (!isReasoningLevel(level)) return `${REASONING_LEVEL_LABELS[DEFAULT_REASONING_LEVEL]} (default)`;
  return REASONING_LEVEL_LABELS[level];
}

const TOOL_LOADING_WORDS: Record<string, string> = {
  auto: "Automatic",
  eager: "Every tool up front",
  deferred: "Tools found when needed",
};

/** The parts of an agent that a new version can change, in reading order. */
const FIELDS: Array<{ key: string; label: string; read: (a: AgentRecord) => unknown }> = [
  { key: "name", label: "Name", read: (a) => a.name },
  { key: "description", label: "Description", read: (a) => a.description ?? "" },
  // A chosen avatar is saved with the agent, so changing it is a version too.
  {
    key: "avatar",
    label: "Avatar",
    read: (a) => (parseFace(a.metadata?.[FACE_METADATA_KEY]) ? describeFace(naturalFace(a)) : "Automatic"),
  },
  { key: "model", label: "Model", read: (a) => modelId(a.model) },
  { key: "system", label: "Instructions", read: (a) => a.system ?? "" },
  { key: "tools", label: "Tools", read: (a) => a.tools ?? [] },
  { key: "mcp_servers", label: "MCP servers", read: (a) => a.mcp_servers ?? [] },
  { key: "skills", label: "Skills", read: (a) => a.skills ?? [] },
  { key: "multiagent", label: "Delegation", read: (a) => a.multiagent?.agents ?? [] },
  { key: "harness", label: "Engine", read: (a) => engineLabel(a._oma?.harness) },
  { key: "reasoning", label: "Reasoning", read: (a) => reasoningWords(a._oma?.reasoning_level) },
  { key: "memory", label: "Memory", read: (a) => MEMORY_MODE_LABELS[parseMemoryMode(a._oma?.memory)] },
  {
    key: "mcp_tool_loading",
    label: "MCP tool loading",
    read: (a) => TOOL_LOADING_WORDS[a._oma?.mcp_tool_loading ?? "auto"] ?? a._oma?.mcp_tool_loading,
  },
  {
    key: "vault_mcp_servers",
    label: "Servers from vaults",
    read: (a) => (a._oma?.vault_mcp_servers === "all" ? "Every server a vault signs in to" : "Only the agent's own"),
  },
];

interface Change {
  key: string;
  label: string;
  rows: DiffRow[];
}

function changesBetween(prev: AgentRecord, next: AgentRecord): Change[] {
  const out: Change[] = [];
  for (const field of FIELDS) {
    const before = field.read(prev);
    const after = field.read(next);
    if (JSON.stringify(before) === JSON.stringify(after)) continue;
    const rows = collapseContext(diffLines(valueToLines(before), valueToLines(after)));
    if (hasChanges(rows)) out.push({ key: field.key, label: field.label, rows });
  }
  return out;
}

/**
 * Versions: every saved configuration of the agent, newest first. Each row
 * names what changed from the version before it and opens to the exact
 * diff. Below, two versions can be run against the same test suite.
 */
export function VersionsTab({
  agent,
  versions,
  loading,
  error,
  retry,
}: {
  agent: AgentRecord;
  /** Earlier versions from `/versions`. May or may not include the current one. */
  versions: AgentRecord[];
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  const ordered = useMemo(() => {
    const byVersion = new Map<number, AgentRecord>();
    for (const v of versions) byVersion.set(v.version, v);
    byVersion.set(agent.version, agent); // the live record is the truth for the current version
    return [...byVersion.values()].sort((a, b) => b.version - a.version);
  }, [agent, versions]);

  const [open, setOpen] = useState<number | null>(null);

  return (
    <div className="space-y-4">
      {error ? (
        <ErrorState title="Version history could not be loaded" error={error} retry={retry} />
      ) : (
        <SectionCard
          title="History"
          description="Saving an edit creates a new version. Sessions keep the version they started with."
          flush
        >
          {loading && ordered.length <= 1 && agent.version > 1 ? (
            <div aria-hidden="true">
              {Array.from({ length: Math.min(agent.version, 3) }).map((_, i) => (
                <div key={i} className="flex h-14 items-center gap-3 border-t border-border px-5 first:border-t-0">
                  <Skeleton className="h-[22px] w-9" rounded="full" />
                  <Skeleton className="h-3.5 w-44" rounded="sm" />
                  <Skeleton className="ml-auto h-3.5 w-16" rounded="sm" />
                </div>
              ))}
            </div>
          ) : (
            ordered.map((v, i) => {
              const prev = ordered[i + 1];
              const changes = prev ? changesBetween(prev, v) : [];
              return (
                <VersionRow
                  key={v.version}
                  version={v}
                  current={v.version === agent.version}
                  first={!prev}
                  changes={changes}
                  open={open === v.version}
                  onOpenChange={(next) => setOpen(next ? v.version : null)}
                />
              );
            })
          )}
        </SectionCard>
      )}

      {/* Renders nothing where the server runs no comparisons. */}
      <AgentVersionComparison key={agent.id} agent={agent} versions={versions} />
    </div>
  );
}

function VersionRow({
  version,
  current,
  first,
  changes,
  open,
  onOpenChange,
}: {
  version: AgentRecord;
  current: boolean;
  first: boolean;
  changes: Change[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const model = describeModel(version.model);
  return (
    <Collapsible open={open} onOpenChange={onOpenChange} className="border-t border-border first:border-t-0">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex min-h-14 w-full items-center gap-3 px-5 py-2.5 text-left transition-quick hover:bg-bg-hover"
        >
          <ChevronRightIcon
            aria-hidden="true"
            className={cn(
              "size-4 shrink-0 text-fg-subtle transition-transform duration-[var(--dur-base)] ease-[var(--ease-rise)]",
              open && "rotate-90",
            )}
          />
          <Chip tone="outline" mono className="w-9 justify-center">
            v{version.version}
          </Chip>
          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-small-size font-medium text-fg">
              {first ? "First version" : changes.length === 0 ? "Saved with no visible changes" : "Changed"}
            </span>
            {changes.map((c) => (
              <Chip key={c.key}>{c.label}</Chip>
            ))}
            {first && <span className="truncate text-xs text-fg-subtle">{model.label}</span>}
          </span>
          {current && <StatusBadge status="active" label="Current" variant="soft" />}
          <RelativeTime
            value={version.updated_at || version.created_at}
            className="w-20 shrink-0 text-right text-xs text-fg-subtle"
            fallback="Unknown"
          />
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent className="collapsible-content overflow-hidden">
        <div className="space-y-4 bg-bg-inset/60 px-5 pt-3 pb-5 pl-[3.25rem]">
          {first || changes.length === 0 ? (
            <VersionSnapshot version={version} />
          ) : (
            changes.map((c) => (
              <div key={c.key}>
                <h4 className="mb-1.5 text-xs font-medium text-fg-subtle">{c.label}</h4>
                <div className="overflow-hidden rounded-md border border-border bg-bg-surface py-1.5 dark:bg-bg-inset">
                  <DiffLines rows={c.rows} />
                </div>
              </div>
            ))
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** What a version said, for the first version (nothing to diff against). */
function VersionSnapshot({ version }: { version: AgentRecord }) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1.5">
        <ModelBadge model={version.model} />
        <Chip>{engineLabel(version._oma?.harness)}</Chip>
      </div>
      <div>
        <h4 className="mb-1.5 text-xs font-medium text-fg-subtle">Instructions</h4>
        {version.system?.trim() ? (
          <p className="max-h-72 overflow-y-auto rounded-md border border-border bg-bg-surface px-4 py-3 text-small break-words whitespace-pre-line text-fg dark:bg-bg-inset">
            {version.system}
          </p>
        ) : (
          <p className="text-small text-fg-subtle">This version had no instructions.</p>
        )}
      </div>
    </div>
  );
}
