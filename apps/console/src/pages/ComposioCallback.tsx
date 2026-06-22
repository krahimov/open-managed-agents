import { useEffect, useMemo } from "react";

export function ComposioCallback() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const toolkit = params.get("toolkit") || undefined;
  const connectedAccountId =
    params.get("connected_account_id") ||
    params.get("connectedAccountId") ||
    params.get("id") ||
    undefined;
  const authConfigId =
    params.get("auth_config_id") ||
    params.get("authConfigId") ||
    undefined;
  const error = params.get("error") || undefined;
  const keepOpen = params.get("keep_open") === "1";

  useEffect(() => {
    const payload = {
      type: "composio_auth_complete",
      toolkit,
      connected_account_id: connectedAccountId,
      auth_config_id: authConfigId,
      error,
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
    const timer = keepOpen ? 0 : window.setTimeout(() => window.close(), 900);
    return () => window.clearTimeout(timer);
  }, [authConfigId, connectedAccountId, error, keepOpen, toolkit]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg text-fg">
      <div className="text-sm text-fg-muted">
        {error
          ? "Connection failed. You can close this window."
          : keepOpen
            ? "Connection complete. Continue in this window."
            : "Connection complete. You can close this window."}
      </div>
    </div>
  );
}
