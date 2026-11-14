import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, SendIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

import { useApi } from "../lib/api";
import { withReason } from "../lib/failure-text";
import { quietLink, standaloneLink } from "../lib/links";

interface TelegramStatus {
  enabled: boolean;
  connected: boolean;
}

/** React-query key of the deployment's Telegram status. */
export const TELEGRAM_STATUS_QUERY_KEY = ["telegram", "status"] as const;

/**
 * The offer to meet your agents in Telegram: a quiet band across the top of
 * the panel, on every page, until this person has linked their Telegram
 * account.
 *
 * It is drawn only when the deployment has a Telegram bot
 * (`GET /v1/telegram/status` answers `enabled: true`) and this person is not
 * linked yet (`connected: false`). A server without the endpoint, or a read
 * that fails, draws nothing: the band is an offer, never an error.
 *
 *   Continue in Telegram   POST /v1/telegram/connect → a t.me link that
 *                          carries a one-time start token
 *   Open Telegram…         the link; pressing Start in Telegram links the
 *                          account
 *   I've connected         reads the status again (it is also read again
 *                          whenever the tab regains focus, so coming back
 *                          from Telegram hides the band by itself)
 *   Get a new link         asks for a fresh link (the old one may expire)
 */
export function TelegramOnboarding() {
  const { api } = useApi();
  const status = useQuery<TelegramStatus | null>({
    queryKey: TELEGRAM_STATUS_QUERY_KEY,
    queryFn: async ({ signal }) => {
      try {
        return await api<TelegramStatus>("/v1/telegram/status", { signal, silentErrors: true });
      } catch {
        return null;
      }
    },
    // Coming back from Telegram is a focus: read it again then.
    staleTime: 0,
    refetchOnWindowFocus: "always",
    retry: false,
  });

  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const s = status.data;
  if (!s?.enabled || s.connected) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await api<{ url?: string; connected: boolean }>("/v1/telegram/connect", {
        method: "POST",
        body: "{}",
        silentErrors: true,
      });
      if (result.url) setLink(result.url);
      if (result.connected) await status.refetch();
    } catch (e) {
      setError(withReason("Telegram could not be connected", e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      aria-label="Telegram"
      className="relative flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-bg-soft px-4 py-2.5 lg:px-5"
    >
      <div className="flex min-w-0 flex-1 basis-72 items-start gap-3">
        <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-full bg-bg-surface text-fg-muted shadow-[var(--shadow-xs)] dark:bg-bg-soft">
          <SendIcon className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0 text-small">
          <p className="font-medium text-fg">Your agents can meet you in Telegram</p>
          <p className="text-fg-muted">
            {link
              ? "Open Telegram and press Start. This band goes away once your account is linked."
              : "Connect once, then create agents and get work done from chat."}
          </p>
          {error && (
            <p role="alert" className="mt-0.5 text-danger">
              {error}
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1.5 pl-10 sm:pl-0">
        {link ? (
          <>
            <a className={cn(standaloneLink, "text-small")} href={link} target="_blank" rel="noopener noreferrer">
              Open Telegram and press Start
              <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
            </a>
            <button type="button" className={cn(quietLink, "text-small")} onClick={() => void status.refetch()}>
              I’ve connected
            </button>
            <button
              type="button"
              className={cn(quietLink, "text-small disabled:pointer-events-none disabled:opacity-50")}
              disabled={busy}
              onClick={() => void connect()}
            >
              Get a new link
            </button>
          </>
        ) : (
          <Button size="sm" variant="outline" loading={busy} onClick={() => void connect()}>
            Continue in Telegram
          </Button>
        )}
      </div>
    </aside>
  );
}
