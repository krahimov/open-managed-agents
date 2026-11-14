import { useCallback, useEffect, useMemo, useState } from "react";
import { Navigate, useNavigate, useParams, useSearchParams } from "react-router";
import { CheckIcon, SlidersHorizontalIcon } from "lucide-react";
import { OMA_SETUP_HARNESS, OMA_SETUP_KIND_HARNESS_UPDATED } from "@open-managed-agents/api-types";

import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";

import { ApiError } from "../../lib/api";
import type { Event } from "../../lib/events";
import { useApiQuery } from "../../lib/useApiQuery";
import { AgentAvatar, RecordNotFound, ErrorState, Page, Skeleton } from "../../components/kit";
import { ConfigPanel, type Harness } from "./setup/ConfigPanel";
import { SessionChat } from "./SessionChat";

/**
 * Agent setup. Opens right after an agent is created: the agent's FIRST
 * session runs in setup mode, reading its own configuration and
 * interviewing the person to refine it.
 *
 * The conversation is the page. Beside it, a panel shows the agent's
 * configuration as it stands (seeded from the agent, then replaced each
 * time the agent edits itself), so every change the agent makes is
 * visible the moment it lands. One primary action: finish, which opens
 * the agent's profile. Below `lg` the panel moves into a sheet.
 */

const DISPLAY_FIELDS = ["name", "description", "model", "system", "mcp_servers", "tools", "skills"] as const;

function toHarnessView(agent: Record<string, unknown> | null | undefined): Harness {
  if (!agent) return {};
  const view: Harness = {};
  const model = typeof agent.model === "string" ? agent.model : (agent.model as { id?: string } | undefined)?.id;
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

/** True from the `lg` breakpoint up, where the panel fits beside the chat. */
function useWide(): boolean {
  const [wide, setWide] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(min-width: 1024px)").matches
      : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setWide(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return wide;
}

export function AgentSetup() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("session");
  const nav = useNavigate();
  const wide = useWide();
  const [panelOpen, setPanelOpen] = useState(false);

  // The agent seeds the panel; the setup session's markers then replace it.
  const agentQuery = useApiQuery<Record<string, unknown>>(id ? `/v1/agents/${id}` : null);
  const [live, setLive] = useState<{ harness: Harness; changed: string[]; at: number } | null>(null);
  const seeded = useMemo(() => toHarnessView(agentQuery.data), [agentQuery.data]);
  const harness = live?.harness ?? seeded;
  const agentName = (typeof harness.name === "string" && harness.name) || (agentQuery.data?.name as string) || "";

  // Capture live refinements off the setup session's markers.
  const handleEvent = useCallback((ev: Event) => {
    const m = ev.metadata as { harness?: string; kind?: string; harness_config?: Harness; changed?: string[] } | undefined;
    if (m?.harness === OMA_SETUP_HARNESS && m.kind === OMA_SETUP_KIND_HARNESS_UPDATED && m.harness_config) {
      const at = Date.parse(String((ev as { processed_at?: string; created_at?: string }).processed_at ?? (ev as { created_at?: string }).created_at ?? ""));
      setLive({ harness: m.harness_config, changed: m.changed ?? [], at: Number.isFinite(at) ? at : Date.now() });
    }
  }, []);

  if (!id) return null;
  // Setup only exists inside its session: without one, show the agent.
  if (!sessionId) return <Navigate to={`/agents/${id}`} replace />;

  if (agentQuery.error) {
    const missing = agentQuery.error instanceof ApiError && agentQuery.error.status === 404;
    return (
      <Page width="default">
        <div className="pt-6">
          {missing ? (
            <RecordNotFound thing="agent" kind="agent" back={{ to: "/agents", label: "agents" }} />
          ) : (
            <ErrorState title="This agent could not be loaded" error={agentQuery.error} retry={() => void agentQuery.refetch()} />
          )}
        </div>
      </Page>
    );
  }

  const panel = (
    <ConfigPanel
      harness={harness}
      loading={agentQuery.isLoading}
      error={null}
      retry={() => void agentQuery.refetch()}
      changed={live?.changed ?? []}
      changedAt={live?.at ?? null}
      className="h-full"
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3.5 border-b border-border px-5 pt-1 pb-3.5 lg:px-8">
        {agentQuery.isLoading ? (
          <Skeleton className="size-10" rounded="lg" />
        ) : (
          <AgentAvatar name={agentName} id={id} size="lg" />
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 text-fg" title={agentName ? `Setting up ${agentName}` : undefined}>
            {agentQuery.isLoading ? <Skeleton className="my-1 h-5 w-56" rounded="sm" /> : `Setting up ${agentName || "your agent"}`}
          </h1>
          <p className="truncate text-small text-fg-muted">
            Answer its questions. It rewrites its own configuration as you go.
          </p>
        </div>
        {!wide && (
          <Button variant="outline" onClick={() => setPanelOpen(true)}>
            <SlidersHorizontalIcon data-icon="inline-start" />
            Configuration
          </Button>
        )}
        <Button onClick={() => nav(`/agents/${id}`)}>
          <CheckIcon data-icon="inline-start" />
          Finish setup
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <SessionChat
            sessionId={sessionId}
            onEvent={handleEvent}
            placeholder="Answer the agent"
            emptyTitle="Getting ready"
            emptyDescription="The agent is reading its configuration. It will ask what you want it to do."
          />
        </div>
        {wide && <div className="w-[380px] shrink-0 border-l border-border xl:w-[440px]">{panel}</div>}
      </div>

      {!wide && (
        <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
          <SheetContent className="gap-0 p-0 sm:max-w-[440px]">
            <SheetTitle className="sr-only">Configuration</SheetTitle>
            <SheetDescription className="sr-only">The agent's configuration as it stands now.</SheetDescription>
            <div className="min-h-0 flex-1 pt-8">{panel}</div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
