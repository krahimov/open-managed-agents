import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { CheckIcon, ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { BrandLoader } from "../components/BrandLoader";
import { Callout } from "../components/Callout";
import { Field } from "../components/Field";
import { Select, SelectOption } from "../components/Select";
import { AppIcon } from "../components/agents/controls";
import { BRAND_NAME } from "../lib/brand";
import { COMPOSIO_MANAGED_AGENT_INTEGRATIONS } from "../lib/composio-integrations";
import { loadTelegramMiniApp, type TelegramMiniApp } from "../lib/telegram-mini-app";
import { AuthShell } from "./auth/AuthShell";

/** What the server knows about this connection request. */
interface View {
  /** The app's id, lower case ("linear"). */
  service: string;
  /** Why the agent asked, in its own words. */
  reason?: string;
  vaults: Array<{ id: string; name: string }>;
  /** The agent's default vaults. */
  vault_ids: string[];
}

/** A started authorization: the provider's consent page, and the flow to check. */
interface Flow {
  url: string;
  flow_id: string;
}

const NO_INIT_DATA =
  "Open this page using a fresh Connect button in your linked Telegram chat. Send /connect followed by the app name to get one.";

/** "linear" → "Linear"; "googledrive" → "Google Drive" where the app is known. */
function appName(slug: string): string {
  const known = COMPOSIO_MANAGED_AGENT_INTEGRATIONS.find((e) => e.slug === slug.toLowerCase());
  return known?.name ?? slug.slice(0, 1).toUpperCase() + slug.slice(1).replace(/[_-]+/g, " ");
}

/** The vault picked to begin with: the agent's own, then "Connected Apps", then the first. */
function startingVault(view: View): string {
  return (
    view.vaults.find((v) => view.vault_ids.includes(v.id))?.id ??
    view.vaults.find((v) => v.name === "Connected Apps")?.id ??
    view.vaults[0]?.id ??
    ""
  );
}

/**
 * Connecting an app for an agent you talk to in Telegram. The bot's Connect
 * button opens this page inside Telegram as a Mini App, with
 * `/telegram/connect/:sessionId/:requestId` naming the agent's access request.
 *
 * There is no console sign-in here. Telegram's signed launch data (`initData`)
 * is the proof of who is asking: every request sends it as
 * `x-telegram-init-data` and sends no cookies (`credentials: "omit"`), so a
 * link opened in a browser cannot act as anyone. Without launch data the page
 * says how to get a fresh button and asks the server nothing.
 *
 *   view       what is being connected, and the vaults to keep it in
 *   authorize  starts the provider's consent; its page opens only when the
 *              person presses Authorize (Telegram's openLink), never by itself
 *   complete   checks that consent finished; until it has, the page says so
 *              and the check can be run again
 *
 * The provider still asks for consent on its own page: Telegram only proves
 * whose agent this is.
 */
export function TelegramConnect() {
  const { sessionId, requestId } = useParams();
  const [app, setApp] = useState<TelegramMiniApp>();
  const [view, setView] = useState<View>();
  const [selected, setSelected] = useState("");
  const [flow, setFlow] = useState<Flow>();
  const [opened, setOpened] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/integrations/telegram/connect/${encodeURIComponent(sessionId ?? "")}/${encodeURIComponent(requestId ?? "")}`;

  async function request<T>(telegram: TelegramMiniApp, action: string, body = {}): Promise<T> {
    const response = await fetch(`${base}/${action}`, {
      method: "POST",
      credentials: "omit",
      cache: "no-store",
      headers: { "content-type": "application/json", "x-telegram-init-data": telegram.initData },
      body: JSON.stringify(body),
    });
    // A server that does not have this page answers with something that is
    // not JSON: that is a failure in words, not a parse error.
    const result = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok || result === null) {
      throw new Error(result?.error || "The connection could not be made. Try again.");
    }
    return result;
  }

  useEffect(() => {
    document.title = `Connect an app · ${BRAND_NAME}`;
  }, []);

  useEffect(() => {
    let disposed = false;
    setView(undefined);
    setFlow(undefined);
    setConnected(false);
    setOpened(false);
    setError("");
    void loadTelegramMiniApp()
      .then(async (telegram) => {
        telegram.ready();
        if (!telegram.initData) throw new Error(NO_INIT_DATA);
        const result = await request<View>(telegram, "view");
        if (disposed) return;
        setApp(telegram);
        setView(result);
        setSelected(startingVault(result));
      })
      .catch((e: unknown) => {
        if (!disposed) setError(e instanceof Error ? e.message : "Telegram could not be reached. Close this page and press Connect again.");
      });
    return () => {
      disposed = true;
    };
    // `request` reads only `base`.
  }, [base]);

  const authorize = async () => {
    if (!app) return;
    setBusy(true);
    setError("");
    try {
      const result = await request<Flow>(app, "authorize", { vault_id: selected || undefined });
      if (new URL(result.url).protocol !== "https:") throw new Error("The app sent back a sign-in link that is not secure, so it was not opened.");
      setFlow(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Authorization could not be started. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const complete = async () => {
    if (!app || !flow) return;
    setBusy(true);
    setError("");
    try {
      await request(app, "complete", { flow_id: flow.flow_id });
      setConnected(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The authorization could not be checked. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const problem = error ? (
    <Callout tone="danger" title={view ? "That did not work" : "This page cannot connect anything yet"}>
      {error}
    </Callout>
  ) : null;

  // Before the request is known: checking, or why it cannot be.
  if (!view) {
    return (
      <AuthShell
        title="Connect your Telegram agent"
        subtitle={error ? undefined : "Checking your Telegram account…"}
        bare={!error}
      >
        {problem ?? <BrandLoader size="lg" label="Checking your Telegram account" />}
      </AuthShell>
    );
  }

  const name = appName(view.service);

  if (connected) {
    return (
      <AuthShell title={`${name} is connected`} bare>
        <div className="flex max-w-[24rem] flex-col items-center gap-5 text-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-success-subtle text-success">
            <CheckIcon className="size-6 stroke-[2.25]" aria-hidden="true" />
          </span>
          <p role="status" className="text-[0.9375rem] leading-relaxed text-balance text-fg-muted">
            Connected. Go back to Telegram to carry on with setup. Send /run when you are ready to start work.
          </p>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Connect ${name}`}
      subtitle={view.reason || "Authorize the app, then come back here to finish connecting your agent."}
      contentKey={flow ? "consent" : "choose"}
    >
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <AppIcon name={name} slug={view.service} size="lg" />
          <div className="min-w-0 text-small">
            <p className="font-medium text-fg">{name}</p>
            <p className="text-fg-muted">Your credentials stay out of Telegram.</p>
          </div>
        </div>

        {problem}

        {!flow ? (
          <>
            {view.vaults.length > 0 ? (
              <Field
                label="Credential vault"
                hint="Your agent can use this vault in its future work sessions."
              >
                <Select value={selected} onValueChange={setSelected} placeholder="Choose a vault">
                  {view.vaults.map((v) => (
                    <SelectOption key={v.id} value={v.id}>
                      {v.name}
                    </SelectOption>
                  ))}
                </Select>
              </Field>
            ) : (
              <p className="text-small text-fg-muted">
                A vault named Connected Apps is made to keep this connection for your agent.
              </p>
            )}
            <Button size="lg" className="h-11 w-full" disabled={busy} onClick={() => void authorize()}>
              {busy ? "Preparing…" : "Continue to authorization"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-small text-fg-muted">
              {opened
                ? `Finish on ${name}'s page, then come back and check.`
                : `${name} opens its own page to ask for your consent. Approve it there, then come back here.`}
            </p>
            <div className="space-y-2">
              <Button
                size="lg"
                variant={opened ? "outline" : "default"}
                className="h-11 w-full"
                onClick={() => {
                  app!.openLink(flow.url);
                  setOpened(true);
                }}
              >
                {opened ? `Open ${name} again` : `Authorize ${name}`}
                <ExternalLinkIcon data-icon="inline-end" aria-hidden="true" />
              </Button>
              {opened && (
                <Button size="lg" className="h-11 w-full" disabled={busy} onClick={() => void complete()}>
                  {busy ? "Checking…" : "I've authorized the app"}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </AuthShell>
  );
}
