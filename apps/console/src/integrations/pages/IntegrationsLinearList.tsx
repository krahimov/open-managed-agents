import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Button } from "@/components/ui/button";

import { IntegrationsApi } from "../api/client";
import type { LinearInstallation, LinearPublication } from "../api/types";
import { IntegrationListPage } from "../components/IntegrationList";
import { Tip } from "../../components/Tip";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

interface InstallationWithPublications {
  installation: LinearInstallation;
  publications: LinearPublication[];
}

const PAT_PATH = "/integrations/linear/install-pat";

/** Linear — connected workspaces, the agents published into each, and unfinished installs. */
export function IntegrationsLinearList() {
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [pending, setPending] = useState<LinearPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [installs, pendingPubs] = await Promise.all([
        api.listInstallations(),
        api.linear.listPendingPublications(),
      ]);
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.listPublications(installation.id),
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
      provider="linear"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      items={items}
      pending={pending}
      onDiscard={async (pub) => {
        await api.linear.unpublish(pub.id);
        setPending((p) => p.filter((x) => x.id !== pub.id));
      }}
      // The fast path: a personal API key instead of an OAuth app.
      headerActions={
        <Tip label="Skip the OAuth app: the agent acts as the key's owner">
          <Button variant="outline" asChild>
            <Link to={PAT_PATH}>Install with an API key</Link>
          </Button>
        </Tip>
      }
      emptySecondaryAction={
        <Button variant="ghost" asChild>
          <Link to={PAT_PATH}>Install with an API key</Link>
        </Button>
      }
    />
  );
}
