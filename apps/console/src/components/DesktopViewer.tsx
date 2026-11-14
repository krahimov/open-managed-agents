import { useEffect, useRef, useState } from "react";
import { MonitorIcon, MonitorOffIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { failureSentence } from "@/lib/failure-text";
import { cn } from "@/lib/utils";

type ViewerState = "connecting" | "connected" | "disconnected";

const STATE_WORDS: Record<ViewerState, string> = {
  connecting: "Connecting to the desktop…",
  connected: "Connected. You are controlling the agent's desktop.",
  disconnected: "The desktop disconnected. Close it and open it again to reconnect.",
};

/**
 * The agent's live Linux desktop, over noVNC.
 *
 * Opening it asks the server for a single-use ticket
 * (`POST /v1/agents/:id/machine/desktop-ticket`) and connects a websocket
 * with it; the provider's own credentials never reach the browser. noVNC
 * is a lazy chunk, loaded the first time a desktop is opened. Closing the
 * viewer only disconnects it: the computer and its work keep running.
 */
export function DesktopViewer({ agentId }: { agentId: string }) {
  const { api } = useApi();
  const target = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<ViewerState>("connecting");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open || !target.current) return;
    let disposed = false;
    let rfb: import("@novnc/novnc").default | undefined;
    setState("connecting");
    setError("");
    void (async () => {
      const { url } = await api<{ url: string }>(`/v1/agents/${agentId}/machine/desktop-ticket`, {
        method: "POST",
        body: "{}",
        // The failure is said here, under the viewer.
        silentErrors: true,
      });
      const { default: RFB } = await import("@novnc/novnc");
      if (disposed || !target.current) return;
      const endpoint = new URL(url, window.location.href);
      endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
      rfb = new RFB(target.current, endpoint.href);
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.addEventListener("connect", () => setState("connected"));
      rfb.addEventListener("disconnect", () => {
        if (!disposed) setState("disconnected");
      });
      rfb.addEventListener("securityfailure", () =>
        setError("The desktop refused the connection. Close it and open it again."),
      );
    })().catch((err) => {
      if (!disposed) setError(`The desktop could not be opened. ${failureSentence(err)}`);
    });
    return () => {
      disposed = true;
      rfb?.disconnect();
    };
  }, [open, agentId, api]);

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
          {error ? (
            <p role="alert" className="mt-3 text-small text-danger">
              {error}
            </p>
          ) : (
            <p role="status" className={cn("mt-3 text-xs", state === "disconnected" ? "text-fg-muted" : "text-fg-subtle")}>
              {STATE_WORDS[state]}
            </p>
          )}
          {/* Kept mounted while the viewer is open: noVNC draws into it. */}
          <div
            ref={target}
            aria-label="The agent's Linux desktop"
            className={cn("mt-3 h-[600px] w-full overflow-hidden rounded-lg bg-bg-inset ring-1 ring-border", error && "hidden")}
          />
        </>
      )}
    </div>
  );
}
