import { useEffect, useState } from "react";

import { IntegrationsApi } from "../api/client";
import type { GitHubInstallation, GitHubPublication } from "../api/types";
import { IntegrationListPage } from "../components/IntegrationList";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: GitHubInstallation;
  publications: GitHubPublication[];
}

/** GitHub — organizations with the app installed, the agents bound to each, and unfinished installs. */
export function IntegrationsGitHubList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [pending, setPending] = useState<GitHubPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [installs, pendingPubs] = await Promise.all([
        api.github.listInstallations(),
        api.github.listPendingPublications(),
      ]);
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.github.listPublications(installation.id),
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
      provider="github"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      items={items}
      pending={pending}
      installationCaption={(i) => (i.bot_login ? <span className="font-mono">@{i.bot_login}</span> : null)}
      onDiscard={async (pub) => {
        await api.github.unpublish(pub.id);
        setPending((p) => p.filter((x) => x.id !== pub.id));
      }}
    />
  );
}
