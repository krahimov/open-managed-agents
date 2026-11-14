import { useEffect, useMemo, useState } from "react";
import { LaptopIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { CheckRow, RowBox } from "../components/agents/controls";
import { Avatar } from "../components/Avatar";
import { Chip } from "../components/Badge";
import { Callout } from "../components/Callout";
import { Skeleton } from "../components/Skeleton";
import { BRAND_NAME } from "../lib/brand";
import { AuthShell } from "./auth/AuthShell";

// Browser-side handler for `oma auth login`. The CLI opens this URL with
// callback + state in the query string, the user authenticates (cookie
// session) + picks one or more workspaces, and the page redirects back
// to the CLI's loopback server with N freshly-minted per-tenant tokens.
//
// Flow:
//   1. Read query params (callback, state, hostname, tenant?).
//   2. If no cookie session → bounce through /login with `next=` set to here.
//   3. Fetch /v1/me to learn user + memberships.
//   4. Show approval UI: when N==1, just an Approve button; when N>1, a
//      checkbox list (defaults: ?tenant pre-selected, otherwise all).
//   5. POST /v1/me/cli-tokens N times — one token per selected tenant.
//   6. window.location = `${callback}?tokens=<base64-json>&user=...&state=...`
//      — the array form so the CLI can populate every selected tenant's
//      profile in one round trip.
//
// Security notes:
//   - The `state` param is opaque to us; the CLI generates a nonce, stashes
//     it locally, and verifies it on the callback. We just round-trip it.
//   - The `callback` param MUST be a 127.0.0.1 / localhost URL — we reject
//     anything else so a malicious link can't trick a logged-in user into
//     handing tokens to an attacker-controlled host.
//   - One mint failure aborts the whole batch — partial tokens are
//     surfaced as an error, not silently delivered, so the user can see
//     exactly what landed.

interface MeResponse {
  user: { id: string; email: string; name: string | null } | null;
  tenant: { id: string; name: string };
  tenants: Array<{ id: string; name: string; role: string }>;
}

interface MintedToken {
  tenant_id: string;
  tenant_name: string;
  role: string;
  token: string;
  key_id: string;
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

/** A workspace's name, or null when it never got a real one (an empty
 *  name, or the "'s workspace" left behind by a sign-up with no user name). */
function tenantName(t: { id: string; name: string }): string | null {
  const trimmed = (t.name ?? "").trim();
  if (!trimmed || trimmed === "'s workspace" || trimmed.startsWith("'s ")) return null;
  return trimmed;
}

const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };
const roleLabel = (role: string) => ROLE_LABEL[role] ?? (role ? role[0].toUpperCase() + role.slice(1) : "Member");

/** Browser-safe base64-encode of a UTF-8 JSON string. */
function encodeTokensParam(tokens: MintedToken[]): string {
  const json = JSON.stringify(tokens);
  // Use the binary-safe TextEncoder→btoa pattern; raw btoa() chokes on
  // multibyte characters that may appear in tenant names.
  const bytes = new TextEncoder().encode(json);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function CliLogin() {
  const { api } = useApi();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const callback = params.get("callback") ?? "";
  const state = params.get("state") ?? "";
  const hostname = params.get("hostname") ?? "this device";
  const requestedTenant = params.get("tenant") ?? "";
  const callbackOk = isLoopback(callback);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [working, setWorking] = useState(false);
  /** Why approving failed. Load failures are read from the query below. */
  const [error, setError] = useState<string>("");

  // /v1/me lookup via TQ. `enabled: callbackOk` defers the fetch until
  // we've validated the callback URL — an invalid callback short-circuits
  // straight to the error screen with no API roundtrip. /v1/me's 401 is
  // already on useApi's silent-auth list so a pre-auth visit doesn't
  // produce a stray toast.
  const meQuery = useApiQuery<MeResponse>(
    callbackOk ? "/v1/me" : null,
  );
  const me = meQuery.data ?? null;
  // Everything below is derived from the query during render (not copied
  // into state by an effect), so the page never shows one state for a
  // frame before settling on another.
  const loadFailure = meQuery.error ? String((meQuery.error as Error).message ?? meQuery.error) : "";
  // /v1/me failure handling: 401 → offer to sign in; anything else → say
  // what failed and offer a retry.
  const authNeeded = !!meQuery.error && /401|Unauthorized/i.test(loadFailure);
  const loading = callbackOk && !me && !meQuery.error;

  // Seed the default workspace selection when the account arrives. Kept in
  // an effect so a TQ refetch (tab focus, etc.) re-applies the same
  // defaults if data changes shape.
  useEffect(() => {
    const res = meQuery.data;
    if (!res) return;
    // Default selection: respect ?tenant if it's a real membership,
    // otherwise select all (the "authorize CLI for everything" intent
    // most multi-tenant users have on first login).
    const ids = res.tenants.map((t) => t.id);
    if (requestedTenant && ids.includes(requestedTenant)) {
      setSelected(new Set([requestedTenant]));
    } else {
      setSelected(new Set(ids));
    }
  }, [meQuery.data, requestedTenant]);

  const goLogin = () => {
    const next = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/login?next=${next}`;
  };

  const toggle = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () => {
    if (!me) return;
    setSelected(new Set(me.tenants.map((t) => t.id)));
  };

  const selectNone = () => setSelected(new Set());

  const approve = async () => {
    if (selected.size === 0 || !me) return;
    setWorking(true);
    setError("");
    try {
      // Mint per-tenant tokens. Run in parallel — the endpoint is cheap
      // and the user already consented to all selected workspaces.
      const orderedSelection = me.tenants.filter((t) => selected.has(t.id));
      const minted = await Promise.all(
        orderedSelection.map(async (t) => {
          const res = await api<{ token: string; tenant_id: string; user_id: string; key_id: string }>(
            "/v1/me/cli-tokens",
            {
              method: "POST",
              body: JSON.stringify({
                tenant_id: t.id,
                name: `CLI on ${hostname}`,
              }),
              // Force the mint call to operate against THIS tenant — the
              // sidebar's stored localStorage might point elsewhere, and
              // the auth middleware would otherwise mint for the wrong one.
              headers: { "x-active-tenant": t.id },
            },
          );
          return {
            tenant_id: res.tenant_id,
            tenant_name: t.name,
            role: t.role,
            token: res.token,
            key_id: res.key_id,
          } satisfies MintedToken;
        }),
      );
      const url = new URL(callback);
      url.searchParams.set("tokens", encodeTokensParam(minted));
      url.searchParams.set("user", me.user?.id ?? minted[0]?.tenant_id ?? "");
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

  const device = (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-bg-soft py-0.5 pr-2.5 pl-2 align-middle font-mono text-xs text-fg">
      <LaptopIcon className="size-3.5 shrink-0 text-fg-muted" aria-hidden="true" />
      <span className="truncate" title={hostname}>
        {hostname}
      </span>
    </span>
  );

  // The link itself is wrong: nothing to approve, and nowhere safe to send a token.
  if (!callbackOk) {
    return (
      <AuthShell title="This link cannot be used" subtitle={`It did not come from the ${BRAND_NAME} CLI on this computer.`}>
        <Callout tone="danger" title="The sign-in link is not valid">
          Invalid callback URL — only loopback addresses (127.0.0.1, localhost) are permitted.
        </Callout>
        <p className="mt-4 text-small leading-relaxed text-fg-muted">
          Run <code className="rounded-sm bg-bg-soft px-1 py-0.5 font-mono text-xs text-fg">oma auth login</code> again
          and use the link it prints. Nothing was authorized.
        </p>
        <Button variant="outline" size="lg" className="mt-6 h-11 w-full" onClick={cancel}>
          Open the console
        </Button>
      </AuthShell>
    );
  }

  if (loading) {
    return (
      <AuthShell title="Authorize the CLI" subtitle="Checking who is signed in on this browser.">
        <div aria-hidden="true">
          <Skeleton className="h-3.5 w-3/5" rounded="sm" />
          <Skeleton className="mt-2.5 h-3.5 w-4/5" rounded="sm" />
          <div className="mt-6 flex items-center gap-3 rounded-lg border border-border px-3.5 py-3">
            <Skeleton className="size-7" rounded="md" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-3.5 w-32" rounded="sm" />
              <Skeleton className="h-3 w-16" rounded="sm" />
            </div>
          </div>
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
      <AuthShell title="Authorize the CLI" subtitle={<>Sign in first, then come back to approve {device}.</>}>
        <p className="text-small leading-relaxed text-fg-muted">
          The {BRAND_NAME} command-line client is waiting in your terminal. After you sign in, this page asks which
          workspaces it may use.
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
      <AuthShell title="Authorize the CLI" subtitle="Your account could not be loaded.">
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
  const none = me.tenants.length === 0;
  const single = me.tenants.length === 1;

  return (
    <AuthShell
      title="Authorize the CLI"
      subtitle={
        <>
          The {BRAND_NAME} CLI on {device} wants to act on your behalf.
        </>
      }
      below={
        <>
          Signed in as <span className="font-medium text-fg">{account}</span>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title="The CLI was not authorized" className="mb-5">
          {error}
        </Callout>
      )}

      {none ? (
        <Callout tone="warning" title="No workspaces found on this account">
          There is nothing to give the CLI access to. Create a workspace in the console, then run{" "}
          <code className="font-mono text-xs text-fg">oma auth login</code> again.
        </Callout>
      ) : (
        <>
          <div className="mb-2 flex min-h-7 items-center justify-between gap-3">
            <h2 className="text-small leading-5 font-medium text-fg">
              {single ? "Workspace" : "Workspaces"}
              {!single && (
                <span className="ml-1.5 font-normal text-fg-subtle">
                  {selected.size} of {me.tenants.length} selected
                </span>
              )}
            </h2>
            {!single && (
              <div className="-mr-1.5 flex items-center">
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={selectAll}
                  disabled={selected.size === me.tenants.length}
                >
                  All
                </Button>
                <Button type="button" variant="ghost" size="xs" onClick={selectNone} disabled={selected.size === 0}>
                  None
                </Button>
              </div>
            )}
          </div>

          {single ? (
            <RowBox>
              <WorkspaceRow tenant={me.tenants[0]} />
            </RowBox>
          ) : (
            <RowBox className="max-h-64 overflow-y-auto">
              {me.tenants.map((t) => {
                const name = tenantName(t);
                return (
                  <CheckRow
                    key={t.id}
                    checked={selected.has(t.id)}
                    onCheckedChange={() => toggle(t.id)}
                    disabled={working}
                    leading={<Avatar name={name ?? "W"} squared />}
                    title={name ?? <span className="font-mono text-xs font-normal">{t.id}</span>}
                    description={name ? undefined : "Unnamed workspace"}
                    trailing={<Chip>{roleLabel(t.role)}</Chip>}
                  />
                );
              })}
            </RowBox>
          )}

          <p className="mt-3 text-xs leading-relaxed text-fg-subtle">
            Approving creates one API key per workspace, named "CLI on {hostname}". You can see and revoke them on
            the API keys page at any time.
          </p>
        </>
      )}

      <div className="mt-6 space-y-2">
        <Button
          size="lg"
          className="h-11 w-full"
          onClick={approve}
          loading={working}
          disabled={selected.size === 0 || none}
        >
          {working
            ? "Authorizing…"
            : single || none
              ? "Approve"
              : selected.size === 0
                ? "Select a workspace"
                : `Approve ${selected.size} workspace${selected.size === 1 ? "" : "s"}`}
        </Button>
        <Button variant="ghost" size="lg" className="h-11 w-full" onClick={cancel} disabled={working}>
          Cancel
        </Button>
      </div>
    </AuthShell>
  );
}

/** The one workspace of a single-workspace account: shown, not chosen. */
function WorkspaceRow({ tenant }: { tenant: { id: string; name: string; role: string } }) {
  const name = tenantName(tenant);
  return (
    <div className="flex min-h-[52px] items-center gap-3 px-3.5 py-2.5">
      <Avatar name={name ?? "W"} squared />
      <div className="min-w-0 flex-1">
        <div className="truncate text-small leading-5 font-medium text-fg" title={name ?? tenant.id}>
          {name ?? <span className="font-mono text-xs font-normal">{tenant.id}</span>}
        </div>
        {!name && <div className="text-xs text-fg-subtle">Unnamed workspace</div>}
      </div>
      <Chip>{roleLabel(tenant.role)}</Chip>
    </div>
  );
}
