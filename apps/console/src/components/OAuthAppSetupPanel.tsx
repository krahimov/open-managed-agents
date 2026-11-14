import { useId, useState } from "react";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { BRAND_NAME } from "@/lib/brand";
import { standaloneLink } from "@/lib/links";
import { cn } from "@/lib/utils";

import { CodeWell } from "./EventCard";
import { Disclosure } from "./Disclosure";
import { CopyButton } from "./IdChip";
import { SecretInput, TextInput } from "./Input";

/** Mirrors OAuthAppRequirement in @open-managed-agents/api-types. */
export interface OAuthAppRequirement {
  required: boolean;
  configured: boolean;
  source?: "tenant" | "env";
  label: string;
  issuer: string;
  callback_uri: string;
  env: { client_id: string; client_secret: string };
  docs_url?: string;
  setup_steps: string[];
  manifest?: Record<string, unknown>;
}

/**
 * One-time OAuth app registration, for providers whose MCP server does not
 * register clients on its own (Slack, GitHub…). It stands in for a Connect
 * button that would only dead-end in the popup: the provider's steps, the
 * exact callback URL to paste, the app manifest when the provider takes
 * one, and the client ID and secret. Saving stores the app for this
 * workspace (PUT /v1/oauth/apps, done by the caller) and goes straight on
 * to the provider's sign-in, so the person never has to click Connect
 * a second time.
 *
 * Laid out for the inside of a needs-you card (AccessRequestCard) or a
 * dialog (AddCredentialDialog): no frame of its own, sections set apart by
 * space.
 */
export function OAuthAppSetupPanel({
  requirement,
  saving,
  onSave,
  className,
}: {
  requirement: OAuthAppRequirement;
  saving: boolean;
  onSave: (clientId: string, clientSecret: string) => void | Promise<void>;
  className?: string;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const headingId = useId();
  const label = requirement.label;
  const manifest = requirement.manifest ? JSON.stringify(requirement.manifest, null, 2) : null;
  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !saving;

  return (
    <section aria-labelledby={headingId} className={cn("space-y-4", className)}>
      <div className="space-y-1">
        <h4 id={headingId} className="text-small-size font-medium text-fg">
          First, register a {label} app. You only do this once.
        </h4>
        <p className="text-small text-fg-muted">
          {label} does not let {BRAND_NAME} register itself, so it needs an app you create with {label}. Every
          later {label} connection in this workspace uses the same app.
        </p>
        {requirement.docs_url && (
          <a href={requirement.docs_url} target="_blank" rel="noreferrer" className={cn(standaloneLink, "text-small")}>
            {label}&apos;s guide
            <ExternalLinkIcon className="size-3.5 shrink-0" />
          </a>
        )}
      </div>

      {requirement.setup_steps.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-small text-fg marker:text-fg-subtle">
          {requirement.setup_steps.map((step, i) => (
            <li key={i} className="pl-1">
              {step}
            </li>
          ))}
        </ol>
      )}

      <div>
        <p className="mb-1.5 text-small leading-5 font-medium text-fg">Callback URL</p>
        <div className="flex min-w-0 items-center gap-1 rounded-md border border-border bg-bg-surface py-1 pr-1 pl-3 dark:bg-bg-inset">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg" title={requirement.callback_uri}>
            {requirement.callback_uri}
          </code>
          <CopyButton value={requirement.callback_uri} label="Copy callback URL" />
        </div>
        <p className="mt-1.5 text-xs text-fg-subtle">Paste this into the app&apos;s redirect or callback field.</p>
      </div>

      {manifest && (
        <Disclosure title="App manifest" meta={`For “Create an app from a manifest”`}>
          <div className="relative">
            <CodeWell className="pr-10">{manifest}</CodeWell>
            <CopyButton value={manifest} label="Copy manifest" className="absolute top-1.5 right-1.5" />
          </div>
        </Disclosure>
      )}

      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void onSave(clientId.trim(), clientSecret.trim());
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput
            label="Client ID"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            spellCheck={false}
            className="font-mono"
          />
          <SecretInput
            label="Client secret"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
          />
        </div>
        <p className="text-xs text-fg-subtle">
          Kept for this workspace only and never shown to the agent. On a server you run yourself you can set{" "}
          <code className="font-mono text-micro-size text-fg-muted">{requirement.env.client_id}</code> and{" "}
          <code className="font-mono text-micro-size text-fg-muted">{requirement.env.client_secret}</code> instead.
        </p>
        <Button size="sm" type="submit" disabled={!canSave} loading={saving} loadingLabel="Saving…">
          Save and connect {label}
        </Button>
      </form>
    </section>
  );
}
