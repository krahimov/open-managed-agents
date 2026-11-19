import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MonitorIcon, MousePointerClickIcon, PlayIcon, RefreshCwIcon, XIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { isNotOnServer, useApi } from "@/lib/api";
import { failureSentence, withReason } from "@/lib/failure-text";
import { usePageVisible } from "@/lib/page-visibility";
import { useApiQuery } from "@/lib/useApiQuery";
import { cn } from "@/lib/utils";

import {
  agentMachineQueryKey,
  fetchScreenshot,
  machineRefetchInterval,
  MachineState,
  STARTABLE,
  TRANSITIONING,
  type AgentMachine,
  type MachineResponse,
} from "../AgentComputerPanel";
import { DesktopScreen, type DesktopStatus } from "../DesktopViewer";
import { COMPUTER_PANE_DEFAULT, COMPUTER_PANE_MAX, COMPUTER_PANE_MIN } from "./computer";
import { QueryProblem } from "../QueryProblem";
import { RelativeTime } from "../RelativeTime";
import { Skeleton } from "../Skeleton";
import { Tip } from "../Tip";

/**
 * The agent's computer, beside the conversation: watch it work.
 *
 * A running computer with a desktop is shown live over noVNC, view-only
 * until the person takes control. Without a desktop, or when the live view
 * cannot connect, it is a picture retaken every 2 seconds while the session
 * runs. Either way it holds nothing while it cannot be seen: the desktop is
 * connected (and counted as a viewer, which keeps the computer from
 * idle-stopping) only while this pane is mounted and the tab is in front.
 */

/** How often the picture is retaken while the session runs. */
export const SCREENSHOT_POLL_MS = 2_000;
/** …and after a picture could not be taken. */
const SCREENSHOT_RETRY_MS = 10_000;

export interface ComputerPaneProps {
  agentId: string;
  /** The session is running now: pictures are retaken while it does. */
  sessionRunning: boolean;
  /** The turn in progress is using the browser or the desktop. */
  inUse?: boolean;
  onClose: () => void;
  /** Beside the conversation (`side`, resizable) or in a sheet over it. */
  variant?: "side" | "sheet";
  /** Width in px beside the conversation, and how it is changed. */
  width?: number;
  onWidthChange?: (width: number) => void;
  /** Room the rest of the row keeps (the conversation, the details panel). */
  reserve?: number;
  className?: string;
}

const KEY_STEP = 32;

export function ComputerPane({
  agentId,
  sessionRunning,
  inUse = false,
  onClose,
  variant = "side",
  width = COMPUTER_PANE_DEFAULT,
  onWidthChange,
  reserve = 400,
  className,
}: ComputerPaneProps) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const machinePath = agentMachineQueryKey(agentId)[0];
  const status = useApiQuery<MachineResponse>(machinePath, undefined, { staleTime: 0, refetchInterval: machineRefetchInterval });
  const control = useMutation<{ machine: AgentMachine }, Error, void>({
    mutationFn: () => api<{ machine: AgentMachine }>(`${machinePath}/start`, { method: "POST", body: "{}", silentErrors: true }),
    onSuccess: (result) => {
      queryClient.setQueryData<MachineResponse>(agentMachineQueryKey(agentId), { supported: true, machine: result.machine });
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: [machinePath] }),
  });

  const machine = status.data?.machine ?? null;
  const supported = status.data?.supported === true;
  const running = machine?.state === "running";
  const canStart = supported && (!machine || STARTABLE.has(machine.state)) && !control.isPending;

  const side = variant === "side";
  return (
    <aside
      aria-label="Computer"
      className={cn(
        "relative flex min-h-0 flex-col bg-bg",
        side && "shrink-0 border-l border-border",
        !side && "h-full w-full",
        className,
      )}
      style={side ? { width: `min(${width}px, max(${COMPUTER_PANE_MIN}px, calc(100% - ${reserve}px)))`, minWidth: COMPUTER_PANE_MIN } : undefined}
    >
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <MonitorIcon className="size-4 shrink-0 text-fg-subtle" />
        <h2 className="text-small font-medium text-fg">Computer</h2>
        {status.data && (
          <span aria-live="polite" className="inline-flex min-w-0">
            <MachineState machine={machine} />
          </span>
        )}
        <span className="ml-auto" />
        <Tip label="Hide computer">
          <Button variant="ghost" size="icon-sm" aria-label="Hide computer" onClick={onClose}>
            <XIcon />
          </Button>
        </Tip>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
        {status.isLoading ? (
          <Skeleton className="aspect-[16/10] w-full shrink-0" rounded="lg" />
        ) : status.error && !status.data ? (
          isNotOnServer(status.error) ? (
            <Quiet>This server does not show agent computers.</Quiet>
          ) : (
            <QueryProblem compact title="The computer could not be loaded" error={status.error} retry={() => void status.refetch()} />
          )
        ) : running && machine ? (
          <RunningComputer
            // A new box (restarted, recreated) starts with a fresh view.
            key={`${machine.id}:${machine.generation}`}
            agentId={agentId}
            machine={machine}
            active={visible}
            sessionRunning={sessionRunning}
            inUse={inUse}
          />
        ) : machine && TRANSITIONING.has(machine.state) ? (
          <Idle
            title={machine.state === "stopping" ? "The computer is stopping." : "The computer is starting."}
            detail="Its screen appears here once it is running."
            busy
          />
        ) : (
          <Idle
            title={!machine ? "This agent's computer has not been created yet." : "The computer is stopped."}
            detail={
              !machine
                ? "It is created when a session needs it. Start it now to watch it here."
                : "Its files are still on its disk. Start it to watch it here; a new message starts it too."
            }
            action={
              canStart || control.isPending ? (
                <Button variant="outline" size="sm" loading={control.isPending} onClick={() => control.mutate()}>
                  <PlayIcon data-icon="inline-start" />
                  Start computer
                </Button>
              ) : undefined
            }
            error={control.error ? `The computer was not started. ${failureSentence(control.error)}` : machine?.errorReason ?? undefined}
          />
        )}
      </div>
      {/* Last, so it is drawn over the pane's edge without a z-index. */}
      {side && onWidthChange && <ResizeHandle width={width} onWidthChange={onWidthChange} />}
    </aside>
  );
}

function Quiet({ children }: { children: string }) {
  return <p className="px-1 py-2 text-small text-fg-muted">{children}</p>;
}

function Idle({
  title,
  detail,
  action,
  error,
  busy,
}: {
  title: string;
  detail: string;
  action?: ReactNode;
  error?: string;
  busy?: boolean;
}) {
  return (
    <div
      aria-busy={busy || undefined}
      className="flex aspect-[16/10] w-full flex-col items-center justify-center gap-3 rounded-lg bg-bg-inset px-6 text-center ring-1 ring-border"
    >
      <MonitorIcon className={cn("size-6 text-fg-faint", busy && "animate-pulse")} aria-hidden="true" />
      <div className="max-w-[22rem] space-y-1">
        <p className="text-small font-medium text-fg">{title}</p>
        <p className="text-xs text-fg-subtle">{detail}</p>
      </div>
      {action}
      {error && (
        <p role="alert" className="max-w-[22rem] text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

/** The screen's well: a desktop's proportions, as wide as the pane, never
 *  taller than the room left above its status line (noVNC and the picture
 *  letterbox inside it). */
const SCREEN_FRAME = "relative aspect-[16/10] max-h-[calc(100%-2.5rem)] w-full shrink-0 overflow-hidden rounded-lg bg-bg-inset ring-1";

const LIVE_WORDS: Record<DesktopStatus, string> = {
  connecting: "Connecting to the live desktop…",
  connected: "Live. You are watching; nothing you do reaches the computer.",
  reconnecting: "The live desktop disconnected. Reconnecting…",
  failed: "The live desktop could not be reached.",
};

function RunningComputer({
  agentId,
  machine,
  active,
  sessionRunning,
  inUse,
}: {
  agentId: string;
  machine: AgentMachine;
  active: boolean;
  sessionRunning: boolean;
  inUse: boolean;
}) {
  const [desktop, setDesktop] = useState<{ state: DesktopStatus; reason?: string }>({ state: "connecting" });
  const [controlling, setControlling] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const live = !!machine.desktopEnabled && desktop.state !== "failed";

  // Control is taken on purpose, for one connection: a reconnect or a fall
  // back to pictures gives it back.
  useEffect(() => {
    if (desktop.state !== "connected") setControlling(false);
  }, [desktop.state]);

  if (!machine.desktopEnabled && !machine.browserEnabled) {
    return <Quiet>This computer has no browser or desktop to show.</Quiet>;
  }

  return (
    <>
      {live ? (
        <>
          <div
            className={cn(
              SCREEN_FRAME,
              "transition-quick",
              controlling ? "ring-2 ring-plum" : "ring-border",
            )}
          >
            <DesktopScreen
              agentId={agentId}
              active={active}
              viewOnly={!controlling}
              attempt={attempt}
              onStatusChange={(state, reason) => setDesktop({ state, reason })}
              className="absolute inset-0 h-full w-full"
            />
            {active && desktop.state !== "connected" && (
              <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <span className="rounded-full bg-bg-raised px-3 py-1 text-xs text-fg-muted shadow-[var(--shadow-xs)]">
                  {desktop.state === "reconnecting" ? "Reconnecting…" : "Connecting…"}
                </span>
              </div>
            )}
          </div>
          <div className="flex min-h-8 shrink-0 items-center gap-2">
            <p role="status" className="min-w-0 flex-1 text-xs text-fg-subtle">
              {!active
                ? "Paused while this tab is in the background."
                : controlling
                  ? "You have control. Your keys and clicks go to the agent's computer."
                  : inUse && desktop.state === "connected"
                    ? "Live. The agent is using its computer; you are watching."
                    : LIVE_WORDS[desktop.state]}
            </p>
            <Button
              variant="outline"
              size="sm"
              aria-pressed={controlling}
              className={cn(controlling && "border-plum bg-plum-subtle text-fg hover:bg-plum-subtle")}
              disabled={desktop.state !== "connected" || !active}
              onClick={() => setControlling((v) => !v)}
            >
              <MousePointerClickIcon data-icon="inline-start" />
              {controlling ? "Release control" : "Take control"}
            </Button>
          </div>
        </>
      ) : (
        <>
          <ScreenshotView agentId={agentId} machine={machine} active={active} sessionRunning={sessionRunning} />
          {machine.desktopEnabled && (
            <p className="flex shrink-0 flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
              <span>
                The live desktop could not be reached{desktop.reason ? `: ${desktop.reason.replace(/\.$/, "")}` : ""}. Showing
                pictures instead.
              </span>
              <button
                type="button"
                className="font-medium text-fg-muted underline-offset-2 transition-quick hover:text-fg hover:underline"
                onClick={() => {
                  setDesktop({ state: "connecting" });
                  setAttempt((n) => n + 1);
                }}
              >
                Try live view again
              </button>
            </p>
          )}
        </>
      )}
    </>
  );
}

/**
 * A picture of the computer's screen, retaken every 2 seconds while the
 * session runs and this tab is in front (every 10 after a failed one). A
 * session at rest shows its last picture and a Refresh button.
 */
function ScreenshotView({
  agentId,
  machine,
  active,
  sessionRunning,
}: {
  agentId: string;
  machine: AgentMachine;
  active: boolean;
  sessionRunning: boolean;
}) {
  const path = `/v1/agents/${agentId}/machine/screenshot`;
  const [imageUrl, setImageUrl] = useState<string>();
  const screenshot = useQuery({
    // Its own entry: the Overview's picture is retaken every 15 seconds.
    queryKey: [path, machine.id, machine.generation, "session-pane"],
    queryFn: ({ signal }) => fetchScreenshot(path, signal),
    enabled: active,
    refetchInterval: (query) => (active && sessionRunning ? (query.state.status === "error" ? SCREENSHOT_RETRY_MS : SCREENSHOT_POLL_MS) : false),
    refetchIntervalInBackground: false,
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
    <>
      <div className={cn(SCREEN_FRAME, "flex items-center justify-center ring-border")}>
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={machine.desktopEnabled ? "The agent's desktop, a moment ago" : "The agent's browser, a moment ago"}
            className="block max-h-full max-w-full object-contain"
          />
        ) : screenshot.isFetching ? (
          <Skeleton className="absolute inset-0 rounded-none" />
        ) : (
          <span className="px-6 text-center text-small text-fg-subtle">No picture yet.</span>
        )}
      </div>
      <div className="flex min-h-8 shrink-0 items-center gap-2">
        <p role="status" className="min-w-0 flex-1 text-xs text-fg-subtle">
          {screenshot.error ? (
            <span className="text-danger">{withReason(`The ${what} picture could not be taken`, screenshot.error)}</span>
          ) : !active ? (
            "Paused while this tab is in the background."
          ) : screenshot.dataUpdatedAt ? (
            <>
              Captured <RelativeTime value={screenshot.dataUpdatedAt} />.
              {sessionRunning ? " A new picture every 2 seconds while the session runs." : ""}
            </>
          ) : (
            "Taking a picture…"
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          loading={screenshot.isFetching}
          disabled={!active}
          onClick={() => void screenshot.refetch()}
          aria-label="Refresh picture"
        >
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
    </>
  );
}

/**
 * The pane's left edge: drag it, or focus it and use ← →, to change how
 * wide the computer is. Wider to the left.
 */
function ResizeHandle({ width, onWidthChange }: { width: number; onWidthChange: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null);
  const clamp = (w: number) => Math.round(Math.min(COMPUTER_PANE_MAX, Math.max(COMPUTER_PANE_MIN, w)));
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    // Start from the width on screen: it may be less than the one asked for.
    const shown = e.currentTarget.parentElement?.getBoundingClientRect().width || width;
    drag.current = { x: e.clientX, width: shown };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag.current) return;
    onWidthChange(clamp(drag.current.width + (drag.current.x - e.clientX)));
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") onWidthChange(clamp(width + KEY_STEP));
    else if (e.key === "ArrowRight") onWidthChange(clamp(width - KEY_STEP));
    else return;
    e.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize computer view"
      aria-valuenow={width}
      aria-valuemin={COMPUTER_PANE_MIN}
      aria-valuemax={COMPUTER_PANE_MAX}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 -left-1 w-2 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <span className="absolute inset-y-0 left-1 w-px bg-transparent transition-quick group-hover:bg-border-strong group-focus-visible:bg-plum group-active:bg-plum" />
    </div>
  );
}
