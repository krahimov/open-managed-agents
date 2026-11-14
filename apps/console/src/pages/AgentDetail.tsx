import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  ArchiveIcon,
  CopyIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  PencilIcon,
  PlusIcon,
  PrinterIcon,
  RocketIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";

import { ApiError, useApi } from "../lib/api";
import { agentCapabilities } from "../lib/agents";
import { copyText } from "../lib/clipboard";
import { inlineLink } from "../lib/links";
import { startSession as openSessionStarter } from "../lib/shell-events";
import { useApiQuery } from "../lib/useApiQuery";
import type { AmbientRule } from "../components/agents/triggers";
import { CreateDeploymentDialog } from "../components/CreateDeploymentDialog";
import {
  AgentAvatar,
  Callout,
  Chip,
  ConfirmDialog,
  DetailHeader,
  RecordNotFound,
  ErrorState,
  ModelBadge,
  Page,
  RowActionsMenu,
  SkeletonDetail,
  StatusBadge,
  TabBar,
  useTabParam,
  type RowAction,
  type TabItem,
} from "../components/kit";
import { RunUntilDoneDialog } from "../components/RunUntilDoneDialog";
import type { AgentRecord as Agent } from "../types/agent";
import type { SessionRecord } from "../types/session";
import { AccessTab, printAuditTrail } from "./agents/detail/AccessTab";
import { ACTIVITY_LIMIT, ActivityTab } from "./agents/detail/ActivityTab";
import { OverviewTab } from "./agents/detail/OverviewTab";
import { AddTriggerDialog, TriggersTab } from "./agents/detail/TriggersTab";
import { VersionsTab } from "./agents/detail/VersionsTab";
import { EditAgentDialog } from "./agents/EditAgentDialog";
import { useSessionReadings } from "../components/sessions/readings";

type Tab = "overview" | "activity" | "triggers" | "versions" | "access";
const TABS: ReadonlyArray<Tab> = ["overview", "activity", "triggers", "versions", "access"];

/**
 * Agent profile. A record page: who the agent is and what state it is in
 * (header), one primary action (start a session), and its content in tabs:
 *
 *   Overview   instructions, tools and apps, skills, integrations, details
 *   Activity   its sessions
 *   Triggers   the rules that wake it on its own
 *   Versions   history with diffs, and version comparison on a test suite
 *   Access     the access policy and its audit trail
 *
 * Secondary actions (edit, run until done) sit beside the primary;
 * rare and destructive ones (deploy, archive, delete) are in the menu
 * and go through a confirmation.
 */
export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [tab, setTab] = useTabParam<Tab>("overview", TABS);

  const [editing, setEditing] = useState(false);
  const [showDeploy, setShowDeploy] = useState(false);
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [showAddTrigger, setShowAddTrigger] = useState(false);
  const [confirm, setConfirm] = useState<"archive" | "delete" | null>(null);

  // Each read is its own query: a failure on one (a provider that is not
  // installed, a slow audit endpoint) never blocks the rest of the profile.
  const agentQuery = useApiQuery<Agent>(id ? `/v1/agents/${id}` : null);
  const agent = agentQuery.data;
  const versionsQuery = useApiQuery<{ data: Agent[] }>(id ? `/v1/agents/${id}/versions` : null);
  const rulesQuery = useApiQuery<{ data: AmbientRule[] }>(id ? `/v1/agents/${id}/ambient-rules` : null);
  const sessionParams = useMemo(() => ({ agent_id: id, limit: String(ACTIVITY_LIMIT) }), [id]);
  const sessionsQuery = useApiQuery<{ data: SessionRecord[] }>(id ? "/v1/sessions" : null, sessionParams);

  const versions = versionsQuery.data?.data ?? EMPTY_AGENTS;
  const rules = rulesQuery.data?.data ?? EMPTY_RULES;
  const sessions = sessionsQuery.data?.data ?? EMPTY_SESSIONS;
  // "Running" in the header is the one reading's: a stalled session is not work in progress.
  const { read: readSession } = useSessionReadings();

  // The conversation the agent was set up in, when there is one.
  const setupSession = useMemo(
    () => sessions.find((s) => (s.metadata as { oma_setup?: unknown } | undefined)?.oma_setup),
    [sessions],
  );

  if (agentQuery.error) {
    const missing = agentQuery.error instanceof ApiError && agentQuery.error.status === 404;
    return (
      <Page width="default">
        <div className="pt-6">
          {missing ? (
            <RecordNotFound thing="agent" kind="agent" back={{ to: "/agents", label: "agents" }} />
          ) : (
            <ErrorState title="This agent could not be loaded" error={agentQuery.error} retry={() => void agentQuery.refetch()} />
          )}
        </div>
      </Page>
    );
  }

  if (!agent) {
    return (
      <Page width="default">
        <SkeletonDetail />
      </Page>
    );
  }

  const archived = !!agent.archived_at;
  const running = sessions.some((s) => !s.archived_at && readSession(s).working);
  const longRunning = agent.metadata?.long_running === true;
  const versionCount = new Set([agent.version, ...versions.map((v) => v.version)]).size;
  const caps = agentCapabilities(agent);
  // The starter opens over the profile with this agent chosen; its Options
  // hold the environment, vaults, resources and title.
  const startSession = () => openSessionStarter({ agentId: agent.id });

  const menu: RowAction[] = [
    { label: "Deploy", icon: <RocketIcon />, disabled: archived, onSelect: () => setShowDeploy(true) },
    ...(setupSession
      ? [
          {
            label: "Open setup chat",
            icon: <MessagesSquareIcon />,
            onSelect: () => nav(`/agents/${agent.id}/setup?session=${setupSession.id}`),
          },
        ]
      : []),
    { label: "Copy agent id", icon: <CopyIcon />, onSelect: () => void copyText(agent.id) },
    { label: "Archive", icon: <ArchiveIcon />, disabled: archived, onSelect: () => setConfirm("archive") },
    { label: "Delete", icon: <Trash2Icon />, destructive: true, onSelect: () => setConfirm("delete") },
  ];

  const tabs: TabItem<Tab>[] = [
    { value: "overview", label: "Overview" },
    { value: "activity", label: "Activity", count: sessionsQuery.isLoading ? undefined : sessions.length },
    { value: "triggers", label: "Triggers", count: rulesQuery.isLoading ? undefined : rules.length },
    { value: "versions", label: "Versions", count: versionCount },
    { value: "access", label: "Access" },
  ];

  return (
    <Page width="default">
      <DetailHeader
        wash
        avatar={<AgentAvatar name={agent.name} id={agent.id} size="xl" archived={archived} />}
        title={agent.name}
        status={<StatusBadge status={archived ? "archived" : running ? "running" : "active"} variant="soft" />}
        description={
          agent.description?.trim() ? (
            agent.description
          ) : (
            <span className="text-fg-subtle">
              No description yet.{" "}
              {!archived && (
                <button
                  type="button"
                  onClick={() => setEditing(true)}
                  className={inlineLink}
                >
                  Add one
                </button>
              )}
            </span>
          )
        }
        meta={
          <>
            <ModelBadge model={agent.model} />
            {caps.map((c) => (
              <Chip key={c.key} icon={c.icon} title={c.title}>
                {c.label}
              </Chip>
            ))}
            {longRunning && (
              <Chip icon={TargetIcon} title="Sessions can run until a goal is verified">
                Long-running
              </Chip>
            )}
            <Chip tone="outline" mono title={`Version ${agent.version}`}>
              v{agent.version}
            </Chip>
          </>
        }
        actions={
          <>
            {longRunning && !archived && (
              <Button variant="outline" onClick={() => setShowRunDialog(true)}>
                <TargetIcon data-icon="inline-start" />
                Run until done
              </Button>
            )}
            <Button variant="outline" onClick={() => setEditing(true)}>
              <PencilIcon data-icon="inline-start" />
              Edit
            </Button>
            <Button onClick={startSession} disabled={archived}>
              <MessageSquarePlusIcon data-icon="inline-start" />
              Start session
            </Button>
          </>
        }
        menu={<RowActionsMenu label={`More actions for ${agent.name}`} actions={menu} />}
      >
        {archived && (
          // Neutral, not amber: archived is a state at rest. Amber is kept for "a person is needed".
          <Callout tone="neutral" icon={ArchiveIcon} title="This agent is archived" className="mb-5">
            It no longer accepts new sessions. Its history, versions and triggers are kept.
          </Callout>
        )}
        <TabBar
          label="Agent sections"
          tabs={tabs}
          value={tab}
          onChange={setTab}
          trailing={
            tab === "triggers" && !archived && rules.length > 0 ? (
              <Button variant="outline" size="sm" onClick={() => setShowAddTrigger(true)}>
                <PlusIcon data-icon="inline-start" />
                Add trigger
              </Button>
            ) : tab === "access" ? (
              <Button variant="outline" size="sm" onClick={printAuditTrail}>
                <PrinterIcon data-icon="inline-start" />
                Export
              </Button>
            ) : undefined
          }
        />
      </DetailHeader>

      <div key={tab} role="tabpanel" aria-label={tabs.find((t) => t.value === tab)?.label as string} className="animate-fade-in mt-6">
        {tab === "overview" && (
          <OverviewTab
            agent={agent}
            sessions={sessions}
            sessionsLoading={sessionsQuery.isLoading}
            onEdit={() => setEditing(true)}
            onShowActivity={() => setTab("activity")}
          />
        )}
        {tab === "activity" && (
          <ActivityTab
            agent={agent}
            sessions={sessions}
            loading={sessionsQuery.isLoading}
            error={sessionsQuery.error}
            retry={() => void sessionsQuery.refetch()}
            onStart={startSession}
          />
        )}
        {tab === "triggers" && (
          <TriggersTab
            agentId={agent.id}
            agentName={agent.name}
            rules={rules}
            loading={rulesQuery.isLoading}
            error={rulesQuery.error}
            retry={() => void rulesQuery.refetch()}
            archived={archived}
            onAdd={() => setShowAddTrigger(true)}
          />
        )}
        {tab === "versions" && (
          <VersionsTab
            agent={agent}
            versions={versions}
            loading={versionsQuery.isLoading}
            error={versionsQuery.error}
            retry={() => void versionsQuery.refetch()}
          />
        )}
        {tab === "access" && <AccessTab agentId={agent.id} agentName={agent.name} sessions={sessions} />}
      </div>

      <EditAgentDialog agent={agent} open={editing} onClose={() => setEditing(false)} />
      <AddTriggerDialog agentId={agent.id} agentName={agent.name} open={showAddTrigger} onClose={() => setShowAddTrigger(false)} />
      <RunUntilDoneDialog agentId={agent.id} open={showRunDialog} onClose={() => setShowRunDialog(false)} />
      <CreateDeploymentDialog open={showDeploy} onClose={() => setShowDeploy(false)} initialAgentId={agent.id} />
      <ConfirmDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        destructive={confirm === "delete"}
        title={confirm === "delete" ? `Delete ${agent.name}?` : `Archive ${agent.name}?`}
        body={
          confirm === "delete"
            ? "The agent and all of its versions are removed. Past sessions stay in history. This cannot be undone."
            : "Archived agents stop accepting new sessions and move out of the gallery. Their history is kept."
        }
        confirmLabel={confirm === "delete" ? "Delete agent" : "Archive agent"}
        onConfirm={async () => {
          if (confirm === "delete") {
            await api(`/v1/agents/${agent.id}`, { method: "DELETE" });
            toast.success("Agent deleted");
          } else {
            await api(`/v1/agents/${agent.id}/archive`, { method: "POST", body: "{}" });
            toast.success("Agent archived");
          }
          void qc.invalidateQueries({ queryKey: ["/v1/agents"] });
          nav("/agents");
        }}
      />
    </Page>
  );
}

const EMPTY_AGENTS: Agent[] = [];
const EMPTY_RULES: AmbientRule[] = [];
const EMPTY_SESSIONS: SessionRecord[] = [];
