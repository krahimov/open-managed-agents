import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { PlayIcon, RefreshCwIcon, SquareIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { ApiError, getActiveTenantId, isNotOnServer, readApiError, useApi } from "@/lib/api";
import { getClerkBearerToken } from "@/lib/clerk-auth";
import { AGENT_COMPUTER_LABEL, isAgentComputerEnvironment, type EnvironmentChoice } from "@/lib/default-environment";
import { failureSentence, withReason } from "@/lib/failure-text";
import { inlineLink } from "@/lib/links";
import { useApiQuery } from "@/lib/useApiQuery";

import { Callout } from "./Callout";
import { DesktopViewer } from "./DesktopViewer";
import { OverflowTip } from "./OverflowTip";
import { Property, PropertyList } from "./PropertyList";
import { QueryProblem } from "./QueryProblem";
import { RelativeTime } from "./RelativeTime";
import { SectionCard } from "./SectionCard";
import { Skeleton } from "./Skeleton";
import { StatusBadge, type StatusTone } from "./Badge";

/**
 * The agent's persistent cloud computer, on its Overview.
 *
 * `GET /v1/agents/:id/machine` answers `{ machine, supported }`. It is read
 * every 3s while the computer is changing state and every 10s while it
 * runs. A running computer shows its desktop (DesktopViewer, when it has
 * one) and a screenshot of its browser, fetched with the bearer and
 * workspace headers (a bare <img src> cannot carry them).
 *
 * With no computer and `supported: false`, what it says depends on the
 * agent's default environment: one marked as a persistent agent computer
 * creates it on the next session; anything else runs each session in a
 * fresh sandbox, and the panel says how to change that. An agent on a
 * local runtime without a computer shows nothing, and so does a server
 * without the endpoint.
 */

interface AgentMachine {
  id: string;
  state: string;
  generation: number;
  workdir: string;
  browserEnabled: boolean;
  desktopEnabled?: boolean;
  lastActiveAt: number | null;
  errorReason: string | null;
}

export interface MachineResponse {
  machine: AgentMachine | null;
  supported: boolean;
}

/** Cache key of GET /v1/agents/:id/machine, the one `useApiQuery` gives the
 *  panel, so other callers (the delete confirmation) share its entry. */
export function agentMachineQueryKey(agentId: string) {
  return [`/v1/agents/${agentId}/machine`, {}] as const;
}

/** Whether the agent has a computer, asked of the server now: a session may
 *  have created one since the panel's cached answer. Shares the panel's key,
 *  so a fetch already in flight is reused. */
export async function loadAgentMachine(
  queryClient: QueryClient,
  api: ReturnType<typeof useApi>["api"],
  agentId: string,
): Promise<MachineResponse> {
  const queryKey = agentMachineQueryKey(agentId);
  return queryClient.fetchQuery({
    queryKey,
    queryFn: ({ signal }) => api<MachineResponse>(queryKey[0], { signal, silentErrors: true }),
    staleTime: 0,
  });
}

/** What deleting the agent does to its computer, as one sentence. `status`
 *  is null when that could not be checked. */
export function deleteAgentComputerSentence(status: MachineResponse | null): string {
  return !status
    ? "If it has a computer, the computer and all files on its disk are deleted too."
    : status.machine
      ? "Its computer and all files on its disk will be deleted too."
      : "It has no computer, so there is no computer or disk to delete.";
}

/** Delete confirmation that says for certain whether a computer goes with
 *  the agent. `status` is null when that could not be checked. */
export function deleteAgentConfirmText(name: string, status: MachineResponse | null): string {
  return `Delete agent "${name}"? ${deleteAgentComputerSentence(status)} This cannot be undone.`;
}

const STATE: Record<string, { label: string; tone: StatusTone; live?: boolean }> = {
  creating: { label: "Creating", tone: "info", live: true },
  bootstrapping: { label: "Setting up", tone: "info", live: true },
  starting: { label: "Starting", tone: "info", live: true },
  running: { label: "Running", tone: "info", live: true },
  stopping: { label: "Stopping", tone: "neutral", live: true },
  stopped: { label: "Stopped", tone: "neutral" },
  archived: { label: "Archived", tone: "neutral" },
  recreating: { label: "Recreating", tone: "info", live: true },
  deleting: { label: "Deleting", tone: "neutral", live: true },
  error: { label: "Failed", tone: "danger" },
};

const TRANSITIONING = new Set(["creating", "bootstrapping", "starting", "stopping", "recreating", "deleting"]);
const STARTABLE = new Set(["stopped", "archived", "error"]);

function MachineState({ machine }: { machine: AgentMachine | null | undefined }) {
  if (!machine) return <span className="text-fg-muted">Not started</span>;
  const def = STATE[machine.state];
  // `running` and `provisioning` carry the live halo in the vocabulary.
  const status = machine.state === "running" ? "running" : def?.live ? "provisioning" : machine.state;
  return <StatusBadge status={status} tone={def?.tone ?? "neutral"} label={def?.label ?? machine.state} />;
}

// Images need an authenticated fetch: a plain <img src> cannot attach the
// Clerk bearer token or the selected workspace header.
async function fetchScreenshot(path: string, signal: AbortSignal): Promise<Blob> {
  const clerkToken = await getClerkBearerToken();
  const activeTenant = getActiveTenantId();
  const response = await fetch(path, {
    signal,
    credentials: "include",
    cache: "no-store",
    headers: {
      ...(clerkToken ? { authorization: `Bearer ${clerkToken}` } : {}),
      ...(activeTenant ? { "x-active-tenant": activeTenant } : {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new ApiError({ ...readApiError(body, response.status), status: response.status });
  }
  if (!response.headers.get("content-type")?.startsWith("image/")) {
    throw new Error("The computer did not send back a picture. Try again.");
  }
  return response.blob();
}

function BrowserPreview({ agentId, machine }: { agentId: string; machine: AgentMachine }) {
  const [imageUrl, setImageUrl] = useState<string>();
  const screenshot = useQuery({
    queryKey: [`/v1/agents/${agentId}/machine/screenshot`, machine.id, machine.generation],
    queryFn: ({ signal }) => fetchScreenshot(`/v1/agents/${agentId}/machine/screenshot`, signal),
    refetchInterval: 15_000,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!screenshot.data) return;
    const url = URL.createObjectURL(screenshot.data);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot.data]);

  const what = machine.desktopEnabled ? "desktop" : "browser";
  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-small font-medium text-fg">{machine.desktopEnabled ? "Desktop snapshot" : "Browser"}</h4>
          <p className="text-xs text-fg-subtle">
            {screenshot.dataUpdatedAt ? (
              <>
                Captured <RelativeTime value={screenshot.dataUpdatedAt} />. A new picture every 15 seconds.
              </>
            ) : (
              "A new picture every 15 seconds while this page is open."
            )}
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          loading={screenshot.isFetching}
          onClick={() => void screenshot.refetch()}
          aria-label="Refresh screenshot"
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      {screenshot.error && (
        <p role="alert" className="mt-3 text-small text-danger">
          {withReason(`The ${what} picture could not be taken`, screenshot.error)}
        </p>
      )}
      <div className="mt-3 overflow-hidden rounded-lg bg-bg-inset ring-1 ring-border">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={
              machine.desktopEnabled
                ? "Current Linux desktop on the agent's cloud computer"
                : "Current Chromium browser on the agent's cloud computer"
            }
            className="block w-full"
          />
        ) : screenshot.isFetching ? (
          <Skeleton className="aspect-[16/9] w-full rounded-none" />
        ) : (
          <div className="flex aspect-[16/9] items-center justify-center px-6 text-center text-small text-fg-subtle">
            No picture yet.
          </div>
        )}
      </div>
    </div>
  );
}

export interface AgentComputerPanelProps {
  agentId: string;
  /** The agent runs on the user's own machine (`_oma.runtime_binding`),
   *  so a cloud computer does not apply to it. */
  localRuntime?: boolean;
  /** The agent's default environment: undefined while it loads, null when
   *  the agent has none (or it could not be loaded). */
  defaultEnvironment?: EnvironmentChoice | null;
  /** Opens the agent's settings, offered where the panel says how to give
   *  the agent a computer. */
  onEdit?: () => void;
}

export function AgentComputerPanel({ agentId, localRuntime = false, defaultEnvironment, onEdit }: AgentComputerPanelProps) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const machinePath = agentMachineQueryKey(agentId)[0];
  const status = useApiQuery<MachineResponse>(machinePath, undefined, {
    staleTime: 0,
    refetchInterval: (query) => {
      const state = query.state.data?.machine?.state;
      if (state && TRANSITIONING.has(state)) return 3_000;
      return state === "running" ? 10_000 : false;
    },
  });
  // The failure is said in the panel, so the request raises no toast.
  const control = useMutation<{ machine: AgentMachine }, Error, "start" | "stop">({
    mutationFn: (action) =>
      api<{ machine: AgentMachine }>(`${machinePath}/${action}`, { method: "POST", body: "{}", silentErrors: true }),
    onSuccess: (result) => {
      queryClient.setQueryData<MachineResponse>(agentMachineQueryKey(agentId), { supported: true, machine: result.machine });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [machinePath] }),
  });

  const machine = status.data?.machine;
  const supported = status.data?.supported === true;
  const transitioning = machine ? TRANSITIONING.has(machine.state) : false;
  const canStart = !machine || STARTABLE.has(machine.state);
  // Instance-wide support is off and there is no computer yet. Computers
  // are still given per environment: an agent whose default environment has
  // one gets it from its next session; any other agent runs each session in
  // a fresh sandbox, and Start would be refused.
  const noComputer = !!status.data && !supported;
  const environmentLoading = noComputer && defaultEnvironment === undefined;
  const fromNextSession = noComputer && !!defaultEnvironment && isAgentComputerEnvironment(defaultEnvironment);
  const sandboxOnly = noComputer && !environmentLoading && !fromNextSession;
  const loading = status.isLoading || environmentLoading;

  // A server without the endpoint: nothing to say about computers here.
  if (status.error && isNotOnServer(status.error)) return null;
  // Local-runtime agents run on the user's own machine.
  if (localRuntime && (status.isLoading || noComputer)) return null;

  const description = loading
    ? undefined
    : sandboxOnly
      ? "This agent runs each session in a fresh sandbox that is cleared when the session ends."
      : status.error
        ? undefined
        : "This agent's Linux computer runs in the cloud. Its sessions share its files and Chromium, and work goes on when you close this page.";

  const actions = supported ? (
    machine?.state === "running" ? (
      <Button
        variant="outline"
        size="sm"
        loading={control.isPending && control.variables === "stop"}
        disabled={control.isPending}
        onClick={() => control.mutate("stop")}
      >
        <SquareIcon data-icon="inline-start" />
        Stop computer
      </Button>
    ) : (
      <Button
        variant="outline"
        size="sm"
        loading={control.isPending && control.variables === "start"}
        disabled={!canStart || transitioning || control.isPending}
        onClick={() => control.mutate("start")}
      >
        <PlayIcon data-icon="inline-start" />
        Start computer
      </Button>
    )
  ) : undefined;

  return (
    <div role="region" aria-label="Computer" aria-busy={loading || undefined}>
      <SectionCard title="Computer" description={description} actions={actions} flush={supported}>
        {loading ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-3.5 w-[min(28rem,80%)]" rounded="sm" />
            <Skeleton className="h-3.5 w-[min(18rem,60%)]" rounded="sm" />
          </div>
        ) : status.error ? (
          <QueryProblem compact title="The computer could not be loaded" error={status.error} retry={() => void status.refetch()} />
        ) : fromNextSession ? (
          <p className="text-small text-fg-muted">Its computer is created when its next session starts.</p>
        ) : sandboxOnly ? (
          <p className="text-small text-fg-muted">
            To give it a persistent computer that keeps its files and browser between sessions, edit the agent, open
            All settings and, under Sandbox, choose a default environment marked “{AGENT_COMPUTER_LABEL}”.
            {onEdit && (
              <>
                {" "}
                <button type="button" onClick={onEdit} className={inlineLink}>
                  Edit agent
                </button>
              </>
            )}
          </p>
        ) : supported ? (
          <>
            <div className="px-5 py-3">
              <PropertyList>
                <Property label="Status">
                  <span aria-live="polite">
                    <MachineState machine={machine} />
                  </span>
                </Property>
                {machine && (
                  <>
                    <Property label="Files">
                      <OverflowTip label={machine.workdir} focusable>
                        <span className="block truncate font-mono text-xs text-fg">{machine.workdir}</span>
                      </OverflowTip>
                    </Property>
                    <Property label="Browser">
                      {machine.browserEnabled ? "Chromium" : <span className="text-fg-muted">Not turned on</span>}
                    </Property>
                    {machine.lastActiveAt != null && (
                      <Property label="Last active">
                        <RelativeTime value={machine.lastActiveAt} />
                      </Property>
                    )}
                  </>
                )}
              </PropertyList>
              <p className="mt-1 text-xs text-fg-subtle">
                {!machine
                  ? "Start it here, or start a session and it is created for you."
                  : machine.state === "running"
                    ? "Stop it once its sessions have finished. Its files are still there when it starts again."
                    : null}
              </p>
              {(machine?.errorReason || control.error) && (
                <div className="mt-3 space-y-2">
                  {machine?.errorReason && (
                    <Callout tone="danger" title="The computer stopped working">
                      {machine.errorReason}
                    </Callout>
                  )}
                  {control.error && (
                    <p role="alert" className="text-small text-danger">
                      {control.variables === "stop" ? "The computer was not stopped. " : "The computer was not started. "}
                      {failureSentence(control.error)}
                    </p>
                  )}
                </div>
              )}
            </div>
            {machine?.state === "running" && machine.browserEnabled && (
              <div key={`${agentId}:${machine.id}:${machine.generation}`}>
                {machine.desktopEnabled && <DesktopViewer agentId={agentId} />}
                <BrowserPreview agentId={agentId} machine={machine} />
              </div>
            )}
          </>
        ) : null}
      </SectionCard>
    </div>
  );
}
