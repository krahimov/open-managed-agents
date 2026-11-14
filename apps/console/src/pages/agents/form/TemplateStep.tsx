import { PlusIcon } from "lucide-react";

import { AGENT_TEMPLATES, type AgentTemplate } from "@/lib/agent-templates";
import { MCP_REGISTRY } from "@/lib/mcp-registry";
import { cn } from "@/lib/utils";

import { AgentAvatar, Chip, EmptyState, EntityAvatar } from "../../../components/kit";
import { Button } from "../../../components/ui/button";

/** An app as its maker writes it ("github" → "GitHub"), from the MCP registry. */
const appName = (id: string) =>
  MCP_REGISTRY.find((entry) => entry.id === id.toLowerCase())?.name ?? (id ? id[0].toUpperCase() + id.slice(1) : id);

/** What a template comes with, in a few words. */
function templateFacts(tmpl: AgentTemplate): string[] {
  const apps = tmpl.mcpServers.map((m) => appName(m.name));
  const skills = tmpl.skills.map((s) => (s.type === "anthropic" ? `${s.skill_id.toUpperCase()} skill` : "Skill"));
  return [...apps, ...skills];
}

/**
 * Step one of the new-agent dialog: choose a starting point. A template
 * fills in the name, instructions and apps; the blank agent starts with
 * only the core toolset. Either way the next step can change everything.
 */
export function TemplateStep({ search, onPick, onClearSearch }: { search: string; onPick: (tmpl: AgentTemplate) => void; onClearSearch: () => void }) {
  const q = search.trim().toLowerCase();
  const filtered = q
    ? AGENT_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(q) ||
          t.description.toLowerCase().includes(q) ||
          t.tags.some((tag) => tag.toLowerCase().includes(q)),
      )
    : AGENT_TEMPLATES;

  if (filtered.length === 0) {
    return (
      <EmptyState
        variant="plain"
        kind="agent"
        title="No templates match"
        body={`Nothing matches "${search.trim()}". Clear the search, or start from the blank agent.`}
        action={
          <Button variant="outline" onClick={onClearSearch}>
            Clear search
          </Button>
        }
      />
    );
  }

  return (
    <div className="grid auto-rows-fr gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {filtered.map((tmpl, i) => {
        const blank = tmpl.id === "blank";
        const facts = templateFacts(tmpl);
        return (
          <button
            key={tmpl.id}
            type="button"
            onClick={() => onPick(tmpl)}
            style={{ "--i": Math.min(i, 9) } as React.CSSProperties}
            className={cn(
              "lift stagger flex animate-rise-in flex-col rounded-xl border p-4 text-left",
              blank
                ? "border-dashed border-border-strong bg-transparent hover:bg-bg-surface"
                : "border-border bg-bg-surface shadow-[var(--shadow-xs)]",
            )}
          >
            <div className="flex items-center gap-3">
              {blank ? (
                <EntityAvatar icon={PlusIcon} size="lg" />
              ) : (
                <AgentAvatar name={tmpl.name} size="lg" face={tmpl.face ?? null} />
              )}
              <span className="min-w-0 text-h3 text-fg">{blank ? "Blank agent" : tmpl.name}</span>
            </div>
            {/* The whole description, on as many lines as it needs: it is how a template is chosen. */}
            <p className="mt-3 text-small leading-5 text-pretty text-fg-muted">
              {blank ? "Only the core toolset. Write the instructions and pick the apps yourself." : tmpl.description}
            </p>
            <div className="mt-auto flex min-h-[22px] flex-wrap gap-1.5 pt-3">
              {facts.length > 0 ? (
                <>
                  {facts.slice(0, 3).map((fact) => (
                    <Chip key={fact}>{fact}</Chip>
                  ))}
                  {facts.length > 3 && <Chip title={facts.slice(3).join(", ")}>+{facts.length - 3}</Chip>}
                </>
              ) : (
                <Chip>{blank ? "Start from scratch" : "Built-in tools only"}</Chip>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
