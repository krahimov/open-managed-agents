import { useEffect, useMemo } from "react";

export function ComposioCallback() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const toolkit = params.get("toolkit") || undefined;
  const connectedAccountId =
    params.get("connected_account_id") ||
    params.get("connectedAccountId") ||
    params.get("id") ||
    undefined;

  useEffect(() => {
    const payload = {
      type: "composio_auth_complete",
      toolkit,
      connected_account_id: connectedAccountId,
    };
    try {
      window.opener?.postMessage(payload, window.location.origin);
    } catch {
      // Popup may not have an opener if the provider used strict COOP.
    }
    try {
      const bc = new BroadcastChannel("openma-oauth");
      bc.postMessage(payload);
      bc.close();
    } catch {
      // BroadcastChannel is best-effort.
    }
    const timer = window.setTimeout(() => window.close(), 900);
    return () => window.clearTimeout(timer);
  }, [connectedAccountId, toolkit]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <div className="text-sm text-fg-muted">Connection complete. You can close this window.</div>
    </div>
  );
}
