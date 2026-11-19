import { useEffect, useRef, useState } from "react";
import { MonitorIcon, MonitorOffIcon, RefreshCwIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { failureSentence } from "@/lib/failure-text";
import { usePageVisible } from "@/lib/page-visibility";
import { cn } from "@/lib/utils";

/** Where a live desktop connection is. `failed` is final until asked again. */
export type DesktopStatus = "connecting" | "connected" | "reconnecting" | "failed";

/** Waits before each reconnect. Once they are used up the screen gives up
 *  and says so (the session pane then falls back to pictures). */
export const DESKTOP_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000] as const;
/** A connection that held this long was a good one: its drop starts the
 *  waits over instead of using one up. */
const STEADY_AFTER_MS = 15_000;

export interface DesktopScreenProps {
  agentId: string;
  /** Connected only while true. Going false disconnects at once, so the
   *  server stops counting a viewer and the computer may idle-stop. */
  active: boolean;
  /** Watch only: the viewer's keys and pointer are not sent. */
  viewOnly: boolean;
  /** Bump to connect again after `failed`. */
  attempt?: number;
  /** Waits before each reconnect (DESKTOP_RETRY_DELAYS_MS). */
  retryDelaysMs?: readonly number[];
  onStatusChange?: (status: DesktopStatus, reason?: string) => void;
  className?: string;
}

/**
 * The agent's live Linux desktop, over noVNC, scaled to fit its box.
 *
 * Each connection asks the server for a fresh single-use ticket
 * (`POST /v1/agents/:id/machine/desktop-ticket`, valid 30s) and opens a
 * websocket with it; the provider's own credentials never reach the
 * browser. A dropped connection is retried with a new ticket after 1, 2, 4
 * and 8 seconds, then the screen reports `failed`. noVNC is a lazy chunk,
 * loaded the first time a desktop is shown.
 */
export function DesktopScreen({
  agentId,
  active,
  viewOnly,
  attempt = 0,
  retryDelaysMs = DESKTOP_RETRY_DELAYS_MS,
  onStatusChange,
  className,
}: DesktopScreenProps) {
  const { api } = useApi();
  const target = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<import("@novnc/novnc").default | undefined>(undefined);
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const onStatusRef = useRef(onStatusChange);
  onStatusRef.current = onStatusChange;
  const delaysRef = useRef(retryDelaysMs);
  delaysRef.current = retryDelaysMs;
  const [status, setStatus] = useState<DesktopStatus>("connecting");

  useEffect(() => {
    if (!active || !target.current) return;
    const host = target.current;
    let disposed = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (next: DesktopStatus, reason?: string) => {
      if (disposed) return;
      setStatus(next);
      onStatusRef.current?.(next, reason);
    };
    const retry = (reason?: string) => {
      if (disposed) return;
      rfbRef.current = undefined;
      const delays = delaysRef.current;
      if (failures >= delays.length) {
        report("failed", reason);
        return;
      }
      const wait = delays[failures++];
      report("reconnecting", reason);
      timer = setTimeout(connect, wait);
    };
    function connect() {
      if (disposed) return;
      let connectedAt = 0;
      let refused = false;
      void (async () => {
        const { url } = await api<{ url: string }>(`/v1/agents/${agentId}/machine/desktop-ticket`, {
          method: "POST",
          body: "{}",
          // The failure is said with the screen, not as a toast.
          silentErrors: true,
        });
        const { default: RFB } = await import("@novnc/novnc");
        if (disposed) return;
        const endpoint = new URL(url, window.location.href);
        endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
        const rfb = new RFB(host, endpoint.href);
        rfbRef.current = rfb;
        rfb.viewOnly = viewOnlyRef.current;
        rfb.focusOnClick = !viewOnlyRef.current;
        rfb.scaleViewport = true;
        rfb.clipViewport = false;
        rfb.resizeSession = false;
        rfb.background = "transparent";
        rfb.addEventListener("connect", () => {
          connectedAt = Date.now();
          report("connected");
        });
        rfb.addEventListener("securityfailure", () => {
          refused = true;
        });
        rfb.addEventListener("disconnect", () => {
          if (disposed || rfbRef.current !== rfb) return;
          if (refused) {
            rfbRef.current = undefined;
            report("failed", "The desktop refused the connection.");
            return;
          }
          if (connectedAt && Date.now() - connectedAt >= STEADY_AFTER_MS) failures = 0;
          retry();
        });
      })().catch((err) => retry(failureSentence(err)));
    }
    report("connecting");
    connect();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
      const rfb = rfbRef.current;
      rfbRef.current = undefined;
      rfb?.disconnect();
    };
  }, [active, agentId, api, attempt]);

  // Taking or giving back control changes the live connection in place.
  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = viewOnly;
    rfb.focusOnClick = !viewOnly;
    if (!viewOnly) rfb.focus?.({ preventScroll: true });
  }, [viewOnly]);

  return (
    <div
      ref={target}
      role={viewOnly ? "img" : "application"}
      aria-label={
        viewOnly
          ? "Live view of the agent's desktop"
          : "The agent's desktop. Your keys and clicks go to it."
      }
      aria-busy={status !== "connected" || undefined}
      data-status={status}
      data-view-only={viewOnly || undefined}
      className={cn("overflow-hidden bg-bg-inset", viewOnly ? "cursor-default" : "cursor-auto", className)}
    />
  );
}

const STATE_WORDS: Record<DesktopStatus, string> = {
  connecting: "Connecting to the desktop…",
  connected: "Connected. You are controlling the agent's desktop.",
  reconnecting: "The desktop disconnected. Reconnecting…",
  failed: "The desktop could not be reached.",
};

/**
 * The live desktop on the agent's Overview, behind "Open desktop". It is
 * connected only while it is open and this tab is in front. Closing the
 * viewer only disconnects it: the computer and its work keep running.
 */
export function DesktopViewer({ agentId }: { agentId: string }) {
  const visible = usePageVisible();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<{ state: DesktopStatus; reason?: string }>({ state: "connecting" });
  const [attempt, setAttempt] = useState(0);

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h4 className="text-small font-medium text-fg">Live desktop</h4>
          <p className="text-xs text-fg-subtle">
            Watch and control the agent's desktop. Closing the viewer leaves its work running.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? <MonitorOffIcon data-icon="inline-start" /> : <MonitorIcon data-icon="inline-start" />}
          {open ? "Close desktop" : "Open desktop"}
        </Button>
      </div>
      {open && (
        <>
          {status.state === "failed" ? (
            <div role="alert" className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-danger">
              <span>
                {STATE_WORDS.failed}
                {status.reason ? ` ${status.reason}` : ""}
              </span>
              <Button variant="ghost" size="sm" onClick={() => setAttempt((n) => n + 1)}>
                <RefreshCwIcon data-icon="inline-start" />
                Try again
              </Button>
            </div>
          ) : (
            <p role="status" className={cn("mt-3 text-xs", status.state === "reconnecting" ? "text-fg-muted" : "text-fg-subtle")}>
              {visible ? STATE_WORDS[status.state] : "Paused while this tab is in the background."}
            </p>
          )}
          {/* Kept mounted while the viewer is open: noVNC draws into it. */}
          <DesktopScreen
            agentId={agentId}
            active={visible}
            viewOnly={false}
            attempt={attempt}
            onStatusChange={(state, reason) => setStatus({ state, reason })}
            className={cn("mt-3 h-[600px] w-full rounded-lg ring-1 ring-border", status.state === "failed" && "hidden")}
          />
        </>
      )}
    </div>
  );
}
