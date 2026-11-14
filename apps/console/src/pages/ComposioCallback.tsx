import { useEffect, useMemo } from "react";

import { CheckIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { Callout } from "../components/Callout";
import { COMPOSIO_MANAGED_AGENT_INTEGRATIONS } from "../lib/composio-integrations";
import { AuthShell } from "./auth/AuthShell";

/** "github" → "GitHub" where the app is known; otherwise the slug, capitalised. */
function appName(slug: string | undefined): string | null {
  if (!slug) return null;
  const known = COMPOSIO_MANAGED_AGENT_INTEGRATIONS.find((e) => e.slug === slug.toLowerCase());
  return known?.name ?? slug.slice(0, 1).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

/**
 * Where an app's sign-in popup lands when it is done. It tells the window
 * that opened it (postMessage, with BroadcastChannel as a fallback for
 * providers that sever the opener) and then closes itself, unless
 * `keep_open=1` asks it to stay.
 */
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

  const closeButton = (
    <Button variant="outline" size="lg" className="h-11 w-full" onClick={() => window.close()}>
      Close this window
    </Button>
  );

  const app = appName(toolkit);

  if (error) {
    return (
      <AuthShell title="The connection failed" subtitle="Nothing was connected. You can close this window and try again.">
        <Callout tone="danger" title={`${app ?? "The app"} did not finish signing in`}>
          <span className="break-words">{error}</span>
        </Callout>
        <div className="mt-6">{closeButton}</div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={app ? `${app} is connected` : "Connection complete"}
      subtitle={keepOpen ? "You can continue in this window." : "This window closes by itself."}
      bare
    >
      <div className="flex flex-col items-center gap-6">
        <span className="flex size-12 items-center justify-center rounded-full bg-success-subtle text-success">
          <CheckIcon className="size-6 stroke-[2.25]" aria-hidden="true" />
        </span>
        {!keepOpen && <div className="w-64">{closeButton}</div>}
      </div>
    </AuthShell>
  );
}
