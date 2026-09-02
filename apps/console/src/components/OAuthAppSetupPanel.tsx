import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

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

async function copy(text: string, what: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied.`);
  } catch {
    toast.error(`Couldn't copy the ${what.toLowerCase()} — select and copy it manually.`);
  }
}

/**
 * One-time OAuth-app registration for providers whose MCP server has no
 * Dynamic Client Registration (Slack, GitHub…). Rendered inside the connect
 * card instead of a Connect button that would dead-end in the popup:
 * numbered steps, the exact callback URL, a pre-filled app manifest when
 * the provider has one, and the Client ID / Secret form that stores the app
 * for this tenant and immediately continues to the provider's OAuth.
 */
export function OAuthAppSetupPanel({
  requirement,
  saving,
  onSave,
}: {
  requirement: OAuthAppRequirement;
  saving: boolean;
  onSave: (clientId: string, clientSecret: string) => void | Promise<void>;
}) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const manifest = requirement.manifest ? JSON.stringify(requirement.manifest, null, 2) : null;
  const canSave = clientId.trim().length > 0 && clientSecret.trim().length > 0 && !saving;

  return (
    <div className="mt-3 rounded-md border border-border bg-bg px-3 py-2.5 text-xs">
      <div className="font-medium text-sm">
        One-time setup: create a {requirement.label} app
      </div>
      <div className="mt-0.5 text-fg-subtle">
        {requirement.label}&apos;s MCP server doesn&apos;t register clients automatically, so
        Orrery needs an OAuth app you create once. Every later connect in this workspace
        reuses it.
        {requirement.docs_url && (
          <>
            {" "}
            <a
              href={requirement.docs_url}
              target="_blank"
              rel="noreferrer"
              className="underline text-fg"
            >
              Provider docs
            </a>
            .
          </>
        )}
      </div>

      <ol className="mt-2 list-decimal pl-4 space-y-1">
        {requirement.setup_steps.map((step, i) => (
          <li key={i}>{step}</li>
        ))}
      </ol>

      <div className="mt-2 flex items-center gap-2">
        <span className="text-fg-subtle whitespace-nowrap">Callback URL</span>
        <code className="flex-1 min-w-0 truncate rounded bg-bg-surface border border-border px-1.5 py-0.5 font-mono">
          {requirement.callback_uri}
        </code>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void copy(requirement.callback_uri, "Callback URL")}
        >
          Copy
        </Button>
      </div>

      {manifest && (
        <details className="mt-2">
          <summary className="cursor-pointer select-none text-fg">
            App manifest (paste into &quot;Create New App → From a manifest&quot;)
          </summary>
          <div className="mt-1 flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copy(manifest, "Manifest")}
            >
              Copy manifest
            </Button>
          </div>
          <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg-surface border border-border p-2 font-mono text-[11px] leading-snug">
            {manifest}
          </pre>
        </details>
      )}

      <form
        className="mt-3 grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) void onSave(clientId.trim(), clientSecret.trim());
        }}
      >
        <div className="grid grid-cols-[6rem_1fr] items-center gap-2">
          <label className="text-fg-subtle" htmlFor={`oauth-app-client-id-${requirement.issuer}`}>
            Client ID
          </label>
          <input
            id={`oauth-app-client-id-${requirement.issuer}`}
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            className="h-8 rounded-md border border-border bg-bg-surface px-2 font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
          <label className="text-fg-subtle" htmlFor={`oauth-app-secret-${requirement.issuer}`}>
            Client Secret
          </label>
          <input
            id={`oauth-app-secret-${requirement.issuer}`}
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            autoComplete="off"
            className="h-8 rounded-md border border-border bg-bg-surface px-2 font-mono focus:outline-none focus:ring-1 focus:ring-brand"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] text-fg-subtle">
            Stored for this workspace only; never shown to the agent. Self-hosters can set{" "}
            <code className="font-mono">{requirement.env.client_id}</code> /{" "}
            <code className="font-mono">{requirement.env.client_secret}</code> instead.
          </span>
          <Button size="sm" type="submit" disabled={!canSave}>
            {saving ? "Saving…" : `Save & connect ${requirement.label}`}
          </Button>
        </div>
      </form>
    </div>
  );
}
