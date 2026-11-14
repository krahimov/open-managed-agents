import { useEffect, useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { IntegrationsApi } from "../api/client";
import type { LinearDispatchRule, LinearInstallation, LinearPublication } from "../api/types";
import {
  EditPublicationDialog,
  InstallationPage,
  NoPublications,
  PublicationCard,
  UnpublishDialog,
  type CapabilityGroup,
} from "../components/Publication";
import { toMillis } from "../components/relativeTime";
import { Callout } from "../../components/Callout";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { EntityRef } from "../../components/EntityRef";
import { Field } from "../../components/Field";
import { IdChip } from "../../components/IdChip";
import { TextInput } from "../../components/Input";
import { Modal } from "../../components/Modal";
import { PropertyList, Property } from "../../components/PropertyList";
import { ErrorState } from "../../components/QueryProblem";
import { RelativeTime } from "../../components/RelativeTime";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { SectionCard } from "../../components/SectionCard";
import { Skeleton } from "../../components/Skeleton";
import { plural } from "../../lib/format";
import { failureSentence, withReason } from "../../lib/failure-text";

const api = new IntegrationsApi();

const CAPABILITY_GROUPS: CapabilityGroup[] = [
  { label: "Issues", caps: ["issue.read", "issue.create", "issue.update", "issue.delete"] },
  { label: "Comments", caps: ["comment.write", "comment.delete"] },
  { label: "Labels", caps: ["label.add", "label.remove"] },
  { label: "Assignment", caps: ["assignee.set", "assignee.set_other"] },
  { label: "Triage", caps: ["status.set", "priority.set"] },
  { label: "Sub-issues, mentions and search", caps: ["subissue.create", "user.mention", "search.read"] },
];

/** One connected Linear workspace: published agents, what each may do, and its autopilot rules. */
export function IntegrationsLinearWorkspace() {
  const { id } = useParams<{ id: string }>();
  const [installations, setInstallations] = useState<LinearInstallation[]>([]);
  const [publications, setPublications] = useState<LinearPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<LinearPublication | null>(null);
  const [removing, setRemoving] = useState<LinearPublication | null>(null);

  async function load() {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      // Settled separately: an id that is not connected makes the publications
      // read fail, and that case is "not found", not an error.
      const [insts, pubs] = await Promise.allSettled([api.listInstallations(), api.listPublications(id)]);
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
      provider="linear"
      loading={loading}
      error={error}
      onRetry={() => void load()}
      installation={installation}
      publications={publications}
      description="Each agent published here is its own Linear app: assignable and mentionable."
      publishHref={`/integrations/linear/publish?workspace=${id}`}
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
              <Property label="Workspace" empty="Not reported">
                {installation.workspace_id ? <IdChip id={installation.workspace_id} label="Copy Linear workspace id" /> : null}
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
        <NoPublications provider="linear" />
      ) : (
        publications.map((p, i) => (
          <PublicationCard
            key={p.id}
            provider="linear"
            pub={p}
            groups={CAPABILITY_GROUPS}
            onEdit={() => setEditing(p)}
            onUnpublish={() => setRemoving(p)}
            className="stagger animate-rise-in"
            style={{ "--i": Math.min(i, 12) } as React.CSSProperties}
          >
            <AutopilotRules publicationId={p.id} personaName={p.persona.name} />
          </PublicationCard>
        ))
      )}

      <EditPublicationDialog
        provider="linear"
        pub={editing}
        groups={CAPABILITY_GROUPS}
        onClose={() => setEditing(null)}
        onSave={async (patch) => {
          if (!editing) return;
          await api.updatePublication(editing.id, patch);
          await load();
        }}
      />
      <UnpublishDialog
        provider="linear"
        pub={removing}
        onClose={() => setRemoving(null)}
        onConfirm={async (pub) => {
          await api.unpublish(pub.id);
          await load();
        }}
      />
    </InstallationPage>
  );
}

/** "10 minutes", "1 hour", "90 seconds". */
function interval(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return plural(seconds / 3600, "hour");
  if (seconds >= 60 && seconds % 60 === 0) return plural(seconds / 60, "minute");
  return plural(seconds, "second");
}

/** A rule's filter and pacing, said in words. */
function describeRule(r: LinearDispatchRule): string {
  const filters: string[] = [];
  if (r.filter_label) filters.push(`labelled ${r.filter_label}`);
  if (r.filter_states?.length) filters.push(`in ${r.filter_states.join(" or ")}`);
  if (r.filter_project_id) filters.push("in one project");
  const what = filters.length ? `Unassigned issues ${filters.join(", ")}` : "Unassigned issues";
  return `${what} · up to ${r.max_concurrent} at once · checked every ${interval(r.poll_interval_seconds)}`;
}

/**
 * Autopilot: a recurring sweep that assigns matching unassigned issues to
 * this agent ("an issue lands in Todo, the agent picks it up"). Rules are
 * per publication. Creating one opens a dialog; nothing is open by default.
 */
function AutopilotRules({ publicationId, personaName }: { publicationId: string; personaName: string }) {
  const [rules, setRules] = useState<LinearDispatchRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleting, setDeleting] = useState<LinearDispatchRule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      setRules(await api.listDispatchRules(publicationId));
    } catch (err) {
      setError(failureSentence(err));
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicationId]);

  async function toggle(rule: LinearDispatchRule, enabled: boolean) {
    setBusy(rule.id);
    try {
      await api.updateDispatchRule(publicationId, rule.id, { enabled });
      await load();
    } catch (err) {
      toast.error(withReason("The rule could not be changed", err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="border-t border-border px-5 py-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h4 className="text-small-size font-medium text-fg">Autopilot rules</h4>
          <p className="mt-0.5 text-xs text-fg-subtle">
            A recurring sweep assigns matching unassigned issues to {personaName || "this agent"}.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowCreate(true)} aria-label={`Add rule for ${personaName}`}>
          <PlusIcon data-icon="inline-start" />
          Add rule
        </Button>
      </div>

      <div className="mt-3">
        {error ? (
          <ErrorState compact title="Rules could not be loaded" error={new Error(error)} retry={load} />
        ) : rules === null ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-12 w-full" rounded="lg" />
          </div>
        ) : rules.length === 0 ? (
          <p className="rounded-lg bg-bg-soft px-3.5 py-3 text-small text-fg-muted">
            No rules yet. The agent only acts when someone assigns it an issue or mentions it.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-lg border border-border">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 border-t border-border py-2.5 pr-2 pl-3.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-small-size font-medium text-fg" title={r.name}>
                    {r.name || "Unnamed rule"}
                  </p>
                  <p className="text-xs text-fg-subtle">
                    {describeRule(r)}
                    {r.last_polled_at ? (
                      <>
                        {" "}
                        · last checked <RelativeTime value={toMillis(r.last_polled_at)} />
                      </>
                    ) : (
                      " · not checked yet"
                    )}
                  </p>
                </div>
                <Switch
                  checked={r.enabled}
                  disabled={busy === r.id}
                  onCheckedChange={(next) => void toggle(r, next)}
                  aria-label={`${r.enabled ? "Disable" : "Enable"} rule ${r.name}`}
                />
                <RowActionsMenu
                  label={`Actions for rule ${r.name}`}
                  actions={[{ label: "Delete rule", icon: <Trash2Icon />, destructive: true, onSelect: () => setDeleting(r) }]}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <CreateRuleDialog
        open={showCreate}
        publicationId={publicationId}
        personaName={personaName}
        onClose={() => setShowCreate(false)}
        onCreated={() => {
          setShowCreate(false);
          void load();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onClose={() => setDeleting(null)}
        destructive
        title={`Delete the rule ${deleting?.name || ""}?`}
        body="The sweep stops picking up issues for this rule. Issues already assigned stay assigned."
        confirmLabel="Delete rule"
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.deleteDispatchRule(publicationId, deleting.id);
            await load();
          } catch (err) {
            toast.error(withReason("The rule could not be deleted", err));
            throw err;
          }
        }}
      />
    </div>
  );
}

function CreateRuleDialog({
  open,
  publicationId,
  personaName,
  onClose,
  onCreated,
}: {
  open: boolean;
  publicationId: string;
  personaName: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("Auto-pickup");
  const [label, setLabel] = useState("bot-ready");
  const [states, setStates] = useState("Todo");
  const [maxC, setMaxC] = useState(5);
  const [poll, setPoll] = useState(600);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Start from the defaults each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setName("Auto-pickup");
    setLabel("bot-ready");
    setStates("Todo");
    setMaxC(5);
    setPoll(600);
    setError(null);
  }, [open]);

  async function submit() {
    setError(null);
    if (!label.trim() && !states.trim()) {
      setError("Add a label or at least one state. A rule that matches every issue would assign the whole backlog.");
      return;
    }
    setWorking(true);
    try {
      await api.createDispatchRule(publicationId, {
        name: name.trim() || "Auto-pickup",
        filter_label: label.trim() || null,
        filter_states: states.trim() ? states.split(",").map((s) => s.trim()).filter(Boolean) : null,
        filter_project_id: null,
        max_concurrent: maxC,
        poll_interval_seconds: poll,
      });
      toast.success("Autopilot rule created");
      onCreated();
    } catch (err) {
      setError(failureSentence(err));
    } finally {
      setWorking(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={() => !working && onClose()}
      title="New autopilot rule"
      subtitle={`Which unassigned issues ${personaName || "this agent"} should pick up without being asked.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={working}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={working}>
            Create rule
          </Button>
        </>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {error && (
          <Callout tone="danger" title="The rule was not created">
            {error}
          </Callout>
        )}
        <Field label="Name">
          <TextInput value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Issues with label" hint="Exact label name. Leave empty to match any label.">
            <TextInput value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bot-ready" className="font-mono" />
          </Field>
          <Field label="In states" hint="Comma-separated workflow states.">
            <TextInput value={states} onChange={(e) => setStates(e.target.value)} placeholder="Todo, Triage" className="font-mono" />
          </Field>
          <Field label="Work on at most" hint="Issues in progress at the same time.">
            <Input type="number" min={1} max={100} value={maxC} onChange={(e) => setMaxC(parseInt(e.target.value, 10) || 1)} />
          </Field>
          <Field label="Check every (seconds)" hint={`Every ${interval(poll)}. The minimum is 60.`}>
            <Input type="number" min={60} max={86400} step={60} value={poll} onChange={(e) => setPoll(parseInt(e.target.value, 10) || 60)} />
          </Field>
        </div>
        {/* Enter in a field submits. */}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
