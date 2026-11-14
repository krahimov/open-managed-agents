import { ExternalLinkIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { Callout } from "../../components/Callout";
import { IdChip } from "../../components/IdChip";
import { PROVIDERS, type ProviderId } from "./providers";

/**
 * What the provider reported when its install redirect came back
 * (`?install=ok&publication_id=…`, plus Slack's MCP probe). Rendered by
 * the list page and by the wizard, whichever the redirect lands on.
 */
export function InstallResult({ provider, params }: { provider: ProviderId; params: URLSearchParams }) {
  const meta = PROVIDERS[provider];
  if (params.get("install") !== "ok") return null;
  const publicationId = params.get("publication_id");
  const probe = params.get("probe_kind") === "slack_mcp" ? params.get("probe_ok") : null;
  const fixUrl = params.get("probe_fix_url");
  return (
    <div className="space-y-2">
      <Callout
        tone="success"
        title={`Installed in ${meta.name}`}
        action={publicationId ? <IdChip id={publicationId} label="Copy publication id" /> : undefined}
      >
        The agent is live. {provider === "github" ? "Assign it an issue or mention it" : "Mention it or assign it something"} to
        try it out.
        {probe === "1" && " Slack MCP server access is verified, so it can use the typed Slack tools."}
      </Callout>
      {probe === "0" && (
        <Callout
          tone="warning"
          title="Slack MCP server access is off"
          action={
            fixUrl ? (
              <Button variant="outline" size="sm" asChild>
                <a href={fixUrl} target="_blank" rel="noreferrer">
                  Open Agents and AI Apps
                  <ExternalLinkIcon data-icon="inline-end" />
                </a>
              </Button>
            ) : undefined
          }
        >
          {params.get("probe_message") ??
            "The agent is installed, but Slack's MCP server is rejecting its token. Turn the setting on to enable the typed Slack tools."}
        </Callout>
      )}
    </div>
  );
}
