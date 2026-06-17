import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import yaml from "js-yaml";
import {
  OMA_SETUP_HARNESS,
  OMA_SETUP_KIND_HARNESS_UPDATED,
} from "@open-managed-agents/api-types";
import { Button } from "@/components/ui/button";
import { useApi } from "../../lib/api";
import type { Event } from "../../lib/events";
import { CodeBlock } from "../../components/ai-elements/code-block";
import { SessionChat } from "./SessionChat";

/**
 * Agent setup view. Spawned right after an agent is created from the form: the
 * agent's FIRST session runs in setup mode, reading its own harness and
 * interviewing the user to refine it. Left = that conversation; right = the
 * live harness YAML (seeded from the agent's current config, updated as the
 * agent edits itself).
 */
type Harness = Record<string, unknown>;

const DISPLAY_FIELDS = [
  "name",
  "description",
  "model",
  "system",
  "mcp_servers",
  "tools",
  "skills",
] as const;

function toHarnessView(agent: Record<string, unknown> | null): Harness {
  if (!agent) return {};
  const view: Harness = {};
  const model =
    typeof agent.model === "string"
      ? agent.model
      : (agent.model as { id?: string } | undefined)?.id;
  for (const key of DISPLAY_FIELDS) {
    if (key === "model") {
      if (model) view.model = model;
      continue;
    }
    const value = agent[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    view[key] = value;
  }
  return view;
}

function harnessToYaml(harness: Harness): string {
  if (!harness || Object.keys(harness).length === 0) {
    return "# Your harness will appear here as the agent refines it.";
  }
  try {
    return yaml.dump(harness, { lineWidth: 80, noRefs: true });
  } catch {
    return JSON.stringify(harness, null, 2);
  }
}

export function AgentSetup() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");
  const nav = useNavigate();
  const { api } = useApi();
  const [harness, setHarness] = useState<Harness>({});
  const [agentName, setAgentName] = useState("");

  // Seed the harness pane from the agent's current config.
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api<Record<string, unknown>>(`/v1/agents/${id}`)
      .then((a) => {
        if (cancelled) return;
        setHarness(toHarnessView(a));
        setAgentName((a.name as string) || "");
      })
      .catch(() => {
        /* api() surfaces the error */
      });
    return () => {
      cancelled = true;
    };
  }, [id, api]);

  // Capture live harness refinements off the setup session's markers.
  const handleEvent = useCallback((ev: Event) => {
    const m = ev.metadata as
      | { harness?: string; kind?: string; harness_config?: Harness }
      | undefined;
    if (
      m?.harness === OMA_SETUP_HARNESS &&
      m.kind === OMA_SETUP_KIND_HARNESS_UPDATED &&
      m.harness_config
    ) {
      setHarness(m.harness_config);
    }
  }, []);

  const yamlText = useMemo(() => harnessToYaml(harness), [harness]);

  if (!id) return null;
  if (!sessionId) {
    nav(`/agents/${id}`, { replace: true });
    return null;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2.5">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-fg">{agentName || "New agent"}</div>
          <div className="text-xs text-fg-muted">Setup — refine the harness together with the agent</div>
        </div>
        <Button size="sm" className="ml-auto" onClick={() => nav(`/agents/${id}`)}>
          Done
        </Button>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex w-1/2 min-w-0 flex-col border-r border-border">
          <SessionChat
            sessionId={sessionId}
            onEvent={handleEvent}
            placeholder="Answer the agent…  (it refines its harness as you go)"
            emptyTitle="Setting up…"
            emptyDescription="The agent will ask what you want it to do."
          />
        </div>
        <div className="flex w-1/2 min-w-0 flex-col">
          <div className="flex shrink-0 items-center border-b border-border px-3 py-2 text-xs font-medium text-fg-muted">
            Harness
          </div>
          <div className="min-h-0 flex-1 overflow-auto p-3">
            <CodeBlock code={yamlText} language="yaml" />
          </div>
        </div>
      </div>
    </div>
  );
}
