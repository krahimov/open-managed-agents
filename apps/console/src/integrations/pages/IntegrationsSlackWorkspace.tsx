import { useEffect, useState } from "react";
import { useParams } from "react-router";

import { IntegrationsApi } from "../api/client";
import type { SlackInstallation, SlackPublication } from "../api/types";
import {
  EditPublicationDialog,
  InstallationPage,
  NoPublications,
  PublicationCard,
  UnpublishDialog,
  type CapabilityGroup,
} from "../components/Publication";
import { toMillis } from "../components/relativeTime";
import { EntityRef } from "../../components/EntityRef";
import { IdChip } from "../../components/IdChip";
import { PropertyList, Property } from "../../components/PropertyList";
import { RelativeTime } from "../../components/RelativeTime";
import { SectionCard } from "../../components/SectionCard";
import { failureSentence } from "../../lib/failure-text";

const api = new IntegrationsApi();

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { label: "Messages", caps: ["message.read", "message.write", "message.update", "message.delete"] },
  { label: "Threads", caps: ["thread.reply"] },
  { label: "Reactions", caps: ["reaction.add", "reaction.remove"] },
  { label: "People and search", caps: ["user.read", "search.read"] },
  { label: "Canvases", caps: ["canvas.write"] },
];

/** One connected Slack workspace: the agents published into it and what each may do. */
export function IntegrationsSlackWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [installations, setInstallations] = useState<SlackInstallation[]>([]);
  const [publications, setPublications] = useState<SlackPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<SlackPublication | null>(null);
  const [removing, setRemoving] = useState<SlackPublication | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Settled separately: an id that is not connected makes the publications
      // read fail, and that case is "not found", not an error.
      const [insts, pubs] = await Promise.allSettled([api.slack.listInstallations(), api.slack.listPublications(id)]);
      if (insts.status === "rejected") throw insts.reason;
      setInstallations(insts.value);
      if (pubs.status === "fulfilled") setPublications(pubs.value);
      else if (insts.value.some((i) => i.id === id)) throw pubs.reason;
      else setPublications([]);
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const installation = installations.find((i) => i.id === id);

  return (
    <InstallationPage
      provider="slack"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      installation={installation}
      publications={publications}
      description="Each agent published here is its own Slack app, with its own name and avatar."
      publishHref={`/integrations/slack/publish?workspace=${id}`}
      aside={
        installation && (
          <SectionCard title="Details">
            <PropertyList labelWidth="narrow">
              <Property label="Connected">
                <RelativeTime value={toMillis(installation.created_at)} fallback="Not recorded" />
              </Property>
              <Property label="Credentials" empty="No vault">
                {installation.vault_id ? <EntityRef kind="vault" id={installation.vault_id} /> : null}
              </Property>
              <Property label="Slack team" empty="Not reported">
                {installation.workspace_id ? <IdChip id={installation.workspace_id} label="Copy Slack team id" /> : null}
              </Property>
              <Property label="Bot user" empty="Not reported">
                {installation.bot_user_id ? <IdChip id={installation.bot_user_id} label="Copy bot user id" /> : null}
              </Property>
              <Property label="Connection id">
                <IdChip id={installation.id} label="Copy connection id" />
              </Property>
            </PropertyList>
          </SectionCard>
        )
      }
    >
      {publications.length === 0 ? (
        <NoPublications provider="slack" />
      ) : (
        publications.map((p, i) => (
          <PublicationCard
            key={p.id}
            provider="slack"
            pub={p}
            groups={CAPABILITY_GROUPS}
            onEdit={() => setEditing(p)}
            onUnpublish={() => setRemoving(p)}
            className="stagger animate-rise-in"
            style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
          />
        ))
      )}

      <EditPublicationDialog
        provider="slack"
        pub={editing}
        groups={CAPABILITY_GROUPS}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (!editing) return;
          await api.slack.updatePublication(editing.id, patch);
          await load();
        }}
      />
      <UnpublishDialog
        provider="slack"
        pub={removing}
        onClose={() => setRemoving(null)}
        onConfirm={async (pub) => {
          await api.slack.unpublish(pub.id);
          await load();
        }}
      />
    </InstallationPage>
  );
}
