import { useEffect, useState } from "react";

import { IntegrationsApi } from "../api/client";
import type { SlackInstallation, SlackPublication } from "../api/types";
import { IntegrationListPage } from "../components/IntegrationList";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: SlackInstallation;
  publications: SlackPublication[];
}

/** Slack — connected workspaces, the agents published into each, and unfinished installs. */
export function IntegrationsSlackList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [pending, setPending] = useState<SlackPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [installs, pendingPubs] = await Promise.all([
        api.slack.listInstallations(),
        api.slack.listPendingPublications(),
      ]);
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.slack.listPublications(installation.id),
        })),
      );
      setItems(withPubs);
      setPending(pendingPubs);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <IntegrationListPage
      provider="slack"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      items={items}
      pending={pending}
      // Discard goes through the existing DELETE (markUnpublished); the row
      // then leaves the pending list.
      onDiscard={async (pub) => {
        await api.slack.unpublish(pub.id);
        setPending((p) => p.filter((x) => x.id !== pub.id));
      }}
    />
  );
}
