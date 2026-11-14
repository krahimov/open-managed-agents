import { useEffect, useMemo, useState } from "react";
import { LaptopIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { EntityAvatar } from "../components/AgentAvatar";
import { Avatar } from "../components/Avatar";
import { Callout } from "../components/Callout";
import { Skeleton } from "../components/Skeleton";
import { useApi } from "../lib/api";
import { useServerFeatures } from "../lib/server-features";
import { BRAND_NAME } from "../lib/brand";
import { useApiQuery } from "../lib/useApiQuery";
import { AuthShell } from "./auth/AuthShell";

/** Browser-side handler for `oma bridge setup`. The CLI binds a random
 *  127.0.0.1 port and opens this URL with `?cb=http://127.0.0.1:<port>/cb&state=<nonce>`.
 *  The user authenticates (cookie session), POSTs /v1/runtimes/connect-runtime
 *  to mint a one-time exchange code, then this page redirects back to the
 *  CLI's loopback listener with `?code=...&state=...`. The CLI exchanges
 *  the code at /agents/runtime/exchange for a permanent runtime token.
 *
 *  Mirror of CliLogin.tsx — same frame, different mint endpoint, just one
 *  code per setup (no per-tenant fan-out — the token belongs to the active
 *  tenant at code-mint time).
 *
 *  A server that cannot bridge to a machine (`runtimes` off) says so once the
 *  person is signed in, and Cancel tells the CLI, so nothing waits. */

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

function isLoopback(callbackUrl: string): boolean {
  try {
    const u = new URL(callbackUrl);
    if (u.protocol !== "http:") return false;
    return u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  } catch {
    return false;
  }
}

const TITLE = "Connect this machine";
const code = "rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg";

export function ConnectRuntime() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("cb") ?? "";
  const state = params.get("state") ?? "";
  const callbackOk = isLoopback(callback);
  const stateOk = !!state && state.length >= 8;

  const [authNeeded, setAuthNeeded] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const [loadFailure, setLoadFailure] = useState("");

  // Validate URL params synchronously so an invalid callback never wastes
  // a /v1/me roundtrip. The `enabled` gate on the query below carries the
  // same guard for the actual fetch.
  const paramsValid = callbackOk && stateOk;

  // /v1/me lookup via TQ. Deduped across the page's lifetime; a tab switch
  // away and back doesn't re-hit the endpoint within staleTime.
  const meQuery = useApiQuery<MeResponse>(paramsValid ? "/v1/me" : null);
  const me = meQuery.data ?? null;
  const features = useServerFeatures();
  const supported = features.data?.features.has("runtimes") ?? false;
  const loading = paramsValid ? meQuery.isLoading || (!!me && features.isLoading) : false;

  // /v1/me failure: 401 → the "Sign in" step; everything else → shown as is.
  useEffect(() => {
    const err = meQuery.error;
    if (!err) return;
    if (/401|Unauthorized/i.test(String((err as Error).message))) {
      setAuthNeeded(true);
    } else {
      setLoadFailure(String((err as Error).message ?? err));
    }
  }, [meQuery.error]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const approve = async () => {
    if (!me) return;
    setWorking(true);
    setError("");
    try {
      const { code: exchangeCode } = await api<{ code: string; expires_at: number }>("/v1/runtimes/connect-runtime", {
        method: "POST",
        body: JSON.stringify({ state }),
      });
      const url = new URL(callback);
      url.searchParams.set("code", exchangeCode);
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setWorking(false);
    }
  };

  const cancel = () => {
    if (callbackOk) {
      const url = new URL(callback);
      url.searchParams.set("error", "user_cancelled");
      url.searchParams.set("state", state);
      window.location.href = url.toString();
    } else {
      window.location.href = "/";
    }
  };

  if (!paramsValid) {
    return (
      <AuthShell title="This link cannot be used" subtitle={`It did not come from ${BRAND_NAME} setup running on this computer.`}>
        <Callout tone="danger" title="The setup link is not valid">
          {!callbackOk
            ? "Invalid callback URL — only loopback addresses (127.0.0.1, localhost) are permitted."
            : "The state parameter is missing or too short."}
        </Callout>
        <p className="mt-4 text-small leading-relaxed text-fg-muted">
          Run <code className={code}>oma bridge setup</code> again and use the link it opens. Nothing was connected.
        </p>
        <Button variant="outline" size="lg" className="mt-6 h-11 w-full" onClick={cancel}>
          Open the console
        </Button>
      </AuthShell>
    );
  }

  if (loading) {
    return (
      <AuthShell title={TITLE} subtitle="Checking who is signed in on this browser.">
        <div aria-hidden="true">
          <div className="flex items-center gap-3 rounded-lg border border-border px-3.5 py-3">
            <Skeleton className="size-7" rounded="md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" rounded="sm" />
              <Skeleton className="h-3 w-16" rounded="sm" />
            </div>
          </div>
          <Skeleton className="mt-4 h-3.5 w-4/5" rounded="sm" />
          <Skeleton className="mt-2.5 h-3.5 w-3/5" rounded="sm" />
          <Skeleton className="mt-6 h-11 w-full" rounded="full" />
        </div>
        <span className="sr-only" role="status">
          Checking session
        </span>
      </AuthShell>
    );
  }

  if (authNeeded) {
    return (
      <AuthShell title={TITLE} subtitle="Sign in first, then come back to approve it.">
        <p className="text-small leading-relaxed text-fg-muted">
          {BRAND_NAME} setup is waiting in your terminal. After you sign in, this page asks whether the machine may attach to
          your workspace.
        </p>
        <Button size="lg" className="mt-6 h-11 w-full" onClick={goLogin}>
          Sign in
        </Button>
        <Button variant="ghost" size="lg" className="mt-2 h-11 w-full" onClick={cancel}>
          Cancel
        </Button>
      </AuthShell>
    );
  }

  // /v1/me failed for a reason other than "not signed in".
  if (!me) {
    return (
      <AuthShell title={TITLE} subtitle="Your account could not be loaded.">
        <Callout tone="danger" title="We could not check your account">
          {loadFailure || "The server did not answer."}
        </Callout>
        <Button variant="outline" size="lg" className="mt-6 h-11 w-full" onClick={() => void meQuery.refetch()}>
          Try again
        </Button>
        <Button variant="ghost" size="lg" className="mt-2 h-11 w-full" onClick={cancel}>
          Cancel
        </Button>
      </AuthShell>
    );
  }

  const account = me.user?.email ?? me.user?.id ?? "this user";
  const workspace = me.tenant.name?.trim() || "Your workspace";

  if (!supported) {
    return (
      <AuthShell
        title="This server cannot connect machines"
        subtitle="Local runtimes are not available here, so setup cannot finish."
        below={
          <>
            Signed in as <span className="font-medium text-fg">{account}</span>
          </>
        }
      >
        <p className="text-small leading-relaxed text-fg-muted">
          Agents on this server run in its environments. Close setup in your terminal, or choose Cancel to tell it. Nothing was
          connected.
        </p>
        <Button variant="outline" size="lg" className="mt-6 h-11 w-full" onClick={cancel}>
          Cancel setup
        </Button>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={TITLE}
      subtitle={`${BRAND_NAME} setup on this computer wants to attach it to your workspace as a local runtime.`}
      below={
        <>
          Signed in as <span className="font-medium text-fg">{account}</span>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title="The machine was not connected" className="mb-5">
          {error}
        </Callout>
      )}

      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-3 px-3.5 py-3">
          <EntityAvatar icon={LaptopIcon} size="sm" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-small-size font-medium text-fg">This machine</p>
            <p className="truncate text-xs text-fg-subtle">Runs the bridge daemon</p>
          </div>
        </div>
        <div className="flex items-center gap-3 border-t border-border px-3.5 py-3">
          <Avatar name={workspace} size="sm" squared />
          <div className="min-w-0 flex-1">
            <p className="truncate text-small-size font-medium text-fg" title={workspace}>
              {workspace}
            </p>
            <p className="truncate text-xs text-fg-subtle">Workspace it attaches to</p>
          </div>
        </div>
      </div>

      <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
        Once connected, the daemon starts ACP-compatible agents such as Claude Code and Codex on this machine when you bind an
        agent to it. You can revoke the machine at any time on the Local runtimes page.
      </p>

      <div className="mt-6 space-y-2">
        <Button size="lg" className="h-11 w-full" onClick={() => void approve()} loading={working}>
          {working ? "Connecting" : "Allow this machine"}
        </Button>
        <Button variant="ghost" size="lg" className="h-11 w-full" onClick={cancel} disabled={working}>
          Cancel
        </Button>
      </div>
    </AuthShell>
  );
}
