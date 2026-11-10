import { DesktopViewer } from "./DesktopViewer";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Monitor, RefreshCw } from "lucide-react";
import { ApiError, getActiveTenantId, readApiError, type useApi } from "../lib/api";
import { getClerkBearerToken } from "../lib/clerk-auth";
import { AGENT_COMPUTER_LABEL, isAgentComputerEnvironment, type EnvironmentChoice } from "../lib/default-environment";
import { useApiMutation, useApiQuery } from "../lib/useApiQuery";
import { Button } from "./ui/button";

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

/** Cache key of GET /v1/agents/:id/machine — the one `useApiQuery` gives the
 *  panel, so other callers (the delete confirm) share its entry. */
export function agentMachineQueryKey(agentId: string) {
  return [`/v1/agents/${agentId}/machine`, {}] as const;
}

/** Whether the agent has a computer, asked of the server right now: a
 *  session may have created one since the panel's cached answer. Shares the
 *  panel's key, so a fetch already in flight is reused. */
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

/** Delete confirmation that says for certain whether a computer goes with
 *  the agent. `status` is null when that could not be checked. */
export function deleteAgentConfirmText(name: string, status: MachineResponse | null): string {
  const what = !status
    ? "If it has a computer, the computer and all files on its disk are deleted too."
    : status.machine
      ? "Its computer and all files on its disk will be deleted too."
      : "It has no computer, so there is no computer or disk to delete.";
  return `Delete agent "${name}"? ${what} This cannot be undone.`;
}

const stateLabels: Record<string, string> = {
  creating: "Creating",
  bootstrapping: "Setting up",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  archived: "Archived",
  recreating: "Recreating",
  deleting: "Deleting",
  error: "Error",
};

const transitioningStates = new Set([
  "creating", "bootstrapping", "starting", "stopping", "recreating", "deleting",
]);

// Images need an authenticated fetch: a plain <img src> cannot attach
// the Clerk bearer token or the selected workspace header.
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
    throw new Error("The computer did not return a screenshot. Try refreshing.");
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

  return (
    <div className="mt-4 border-t border-border pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div>
          <h3 className="text-sm font-medium">{machine.desktopEnabled ? "Desktop screenshot" : "Browser preview"}</h3>
          <p className="text-xs text-fg-subtle">
            {screenshot.dataUpdatedAt
              ? `Captured ${new Date(screenshot.dataUpdatedAt).toLocaleTimeString()}. Updates every 15 seconds.`
              : "Updates every 15 seconds while this page is open."}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={screenshot.isFetching}
          loadingLabel="Refreshing..."
          onClick={() => void screenshot.refetch()}
        >
          <RefreshCw className="size-3.5" aria-hidden="true" />
          Refresh screenshot
        </Button>
      </div>
      {screenshot.error && (
        <p role="alert" className="text-sm text-danger mb-3">
          Screenshot unavailable. {screenshot.error.message}
        </p>
      )}
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={machine.desktopEnabled ? "Current Linux desktop on the agent's cloud computer" : "Current Chromium browser on the agent's cloud computer"}
          className="w-full rounded-md border border-border bg-bg"
        />
      ) : (
        <div className="flex min-h-40 items-center justify-center rounded-md border border-border bg-bg text-sm text-fg-subtle">
          {screenshot.isFetching ? "Loading browser preview..." : "No screenshot available yet."}
        </div>
      )}
    </div>
  );
}

export function AgentComputerPanel({
  agentId,
  localRuntime = false,
  defaultEnvironment,
}: {
  agentId: string;
  /** The agent runs on the user's own machine, so a cloud computer
   *  doesn't apply to it. */
  localRuntime?: boolean;
  /** The agent's default environment: undefined while it loads, null when
   *  the agent has none (or it could not be loaded). */
  defaultEnvironment?: EnvironmentChoice | null;
}) {
  const machinePath = agentMachineQueryKey(agentId)[0];
  const queryClient = useQueryClient();
  const status = useApiQuery<MachineResponse>(machinePath, undefined, {
    staleTime: 0,
    refetchInterval: (query) => {
      const state = query.state.data?.machine?.state;
      if (state && transitioningStates.has(state)) return 3_000;
      return state === "running" ? 10_000 : false;
    },
  });
  const control = useApiMutation<{ machine: AgentMachine }>({
    onSuccess: (result) => {
      queryClient.setQueryData<MachineResponse>(agentMachineQueryKey(agentId), {
        supported: true,
        machine: result.machine,
      });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [machinePath] }),
  });
  const machine = status.data?.machine;
  const supported = status.data?.supported === true;
  const transitioning = machine ? transitioningStates.has(machine.state) : false;
  const canStart = !machine || ["stopped", "archived", "error"].includes(machine.state);
  const starting = control.isPending && control.variables?.path.endsWith("/start");
  const stopping = control.isPending && control.variables?.path.endsWith("/stop");
  // Instance-wide support is off and there's no computer yet. Computers
  // are still given per environment: an agent whose default environment
  // has one gets it from its next session; any other agent runs each
  // session in a fresh sandbox, and Start would be refused.
  const noComputer = !!status.data && !supported;
  const environmentLoading = noComputer && defaultEnvironment === undefined;
  const computerFromNextSession =
    noComputer && !!defaultEnvironment && isAgentComputerEnvironment(defaultEnvironment);
  const sessionSandboxOnly = noComputer && !environmentLoading && !computerFromNextSession;

  // Local-runtime agents run on the user's own machine.
  if (localRuntime && (status.isLoading || noComputer)) return null;

  return (
    <section aria-labelledby="agent-computer-heading" className="max-w-4xl rounded-lg border border-border bg-bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="agent-computer-heading" className="font-display text-base font-semibold flex items-center gap-2">
            <Monitor className="size-4" aria-hidden="true" />
            Computer
          </h2>
          {sessionSandboxOnly ? (
            <p className="mt-1 text-sm text-fg-muted max-w-2xl">
              This agent runs each session in a fresh sandbox that is cleared when the session ends.
            </p>
          ) : !environmentLoading && (
            <p className="mt-1 text-sm text-fg-muted max-w-2xl">
              This agent's Linux computer runs in the cloud. Its sessions share files and Chromium,
              and active work continues when you close this page or your laptop.
            </p>
          )}
        </div>
        {supported && (
          <div className="flex gap-2">
            {machine?.state === "running" ? (
              <Button
                variant="outline"
                size="sm"
                loading={stopping}
                loadingLabel="Stopping..."
                disabled={control.isPending}
                onClick={() => control.mutate({ path: `${machinePath}/stop`, body: {} })}
              >
                Stop computer
              </Button>
            ) : (
              <Button
                size="sm"
                loading={starting}
                loadingLabel="Starting..."
                disabled={!canStart || transitioning || control.isPending}
                onClick={() => control.mutate({ path: `${machinePath}/start`, body: {} })}
              >
                Start computer
              </Button>
            )}
          </div>
        )}
      </div>

      {(status.isLoading || environmentLoading) && (
        <p className="mt-4 text-sm text-fg-subtle">Loading computer...</p>
      )}
      {status.error && (
        <div role="alert" className="mt-4 flex flex-wrap items-center gap-3">
          <p className="text-sm text-danger">Could not load computer. {status.error.message}</p>
          <Button variant="outline" size="sm" disabled={status.isFetching} onClick={() => void status.refetch()}>
            Retry
          </Button>
        </div>
      )}
      {computerFromNextSession && (
        <p className="mt-4 text-sm text-fg-muted">
          Its computer is created when its next session starts.
        </p>
      )}
      {sessionSandboxOnly && (
        <p className="mt-4 text-sm text-fg-muted">
          To give it a persistent computer that keeps its files and browser between sessions,
          click Edit, open the Sandbox tab, and choose a default environment marked
          “{AGENT_COMPUTER_LABEL}”.
        </p>
      )}
      {supported && (
        <>
          <dl className="mt-4 grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-fg-muted">Status</dt>
            <dd className={machine?.state === "error" ? "text-danger" : ""} aria-live="polite">
              {machine ? stateLabels[machine.state] ?? machine.state : "Not started"}
            </dd>
            {machine && (
              <>
                <dt className="text-fg-muted">Files</dt>
                <dd className="font-mono text-xs self-center break-all">{machine.workdir}</dd>
                <dt className="text-fg-muted">Browser</dt>
                <dd>{machine.browserEnabled ? "Chromium" : "Not enabled"}</dd>
                {machine.lastActiveAt != null && (
                  <>
                    <dt className="text-fg-muted">Last active</dt>
                    <dd>{new Date(machine.lastActiveAt).toLocaleString()}</dd>
                  </>
                )}
              </>
            )}
          </dl>
          {!machine && (
            <p className="mt-3 text-xs text-fg-subtle">
              Start the computer here, or start a session to create it automatically.
            </p>
          )}
          {machine?.state === "running" && (
            <p className="mt-3 text-xs text-fg-subtle">
              You can stop the computer when its sessions have finished working. Files remain available when it starts again.
            </p>
          )}
          {machine?.errorReason && <p role="alert" className="mt-3 text-sm text-danger">{machine.errorReason}</p>}
          {control.error && <p role="alert" className="mt-3 text-sm text-danger">{control.error.message}</p>}
          {machine?.state === "running" && machine.browserEnabled && (
            <div key={`${agentId}:${machine.id}:${machine.generation}`}>
              {machine.desktopEnabled && <DesktopViewer agentId={agentId} />}
              <BrowserPreview agentId={agentId} machine={machine} />
            </div>
          )}
        </>
      )}
    </section>
  );
}
