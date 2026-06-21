import { useMemo, useState } from "react";
import { Link } from "react-router";
import { KeyRoundIcon, PauseCircleIcon, PlayCircleIcon, TrashIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery, useInfiniteApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { RowActionsMenu } from "../components/RowActionsMenu";
import {
  CreateDeploymentDialog,
  DeploymentKeyModal,
  type Deployment,
} from "../components/CreateDeploymentDialog";
import type { AgentRecord } from "../types/agent";

export function DeploymentsList() {
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const [rotatedKey, setRotatedKey] = useState("");

  const {
    items: deployments,
    isLoading: loading,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: load,
  } = useInfiniteApiQuery<Deployment>("/v1/deployments", {});

  // Aux lookups for display only — failures here must never block the
  // deployments table, so they ride separate queries (same pattern as
  // AgentsList's coordinator picker fetch).
  const { data: agentsRes } = useApiQuery<{ data: AgentRecord[] }>("/v1/agents", {
    limit: "200",
    status: "any",
  });
  const { data: envsRes } = useApiQuery<{ data: { id: string; name: string }[] }>(
    "/v1/environments",
    { limit: "200", status: "any" },
  );

  const agentNames = useMemo(
    () => new Map((agentsRes?.data ?? []).map((a) => [a.id, a.name])),
    [agentsRes],
  );
  const envNames = useMemo(
    () => new Map((envsRes?.data ?? []).map((e) => [e.id, e.name])),
    [envsRes],
  );

  const columns = useMemo<ColumnDef<Deployment>[]>(
    () => [
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.name}</div>
            <div className="text-xs text-fg-subtle font-mono">{row.original.id}</div>
          </>
        ),
        enableHiding: false,
      },
      {
        id: "agent",
        accessorKey: "agent_id",
        header: "Agent",
        cell: ({ row }) => (
          <Link
            to={`/agents/${row.original.agent_id}`}
            onClick={(e) => e.stopPropagation()}
            className="text-brand hover:underline"
          >
            {agentNames.get(row.original.agent_id) ?? (
              <span className="font-mono text-xs">{row.original.agent_id}</span>
            )}
          </Link>
        ),
      },
      {
        id: "key",
        accessorKey: "key_prefix",
        header: "Key",
        cell: ({ row }) => (
          <span className="font-mono text-xs text-fg-muted">
            {row.original.key_prefix}…
          </span>
        ),
      },
      {
        id: "environment",
        accessorFn: (d) => d.environment_id ?? "",
        header: "Environment",
        cell: ({ row }) =>
          row.original.environment_id ? (
            <span className="text-fg-muted">
              {envNames.get(row.original.environment_id) ?? (
                <span className="font-mono text-xs">{row.original.environment_id}</span>
              )}
            </span>
          ) : (
            <span className="text-fg-subtle">—</span>
          ),
      },
      {
        id: "version",
        accessorFn: (d) => d.agent_version ?? "latest",
        header: "Version",
        cell: ({ row }) =>
          row.original.agent_version !== null ? (
            <span className="text-fg-muted">v{row.original.agent_version}</span>
          ) : (
            <span className="text-fg-subtle">latest</span>
          ),
      },
      {
        id: "status",
        accessorFn: (d) => (d.disabled ? "disabled" : "active"),
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.disabled
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.disabled ? "disabled" : "active"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (d) => d.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const d = row.original;
          return (
            <RowActionsMenu
              label={`Actions for ${d.name}`}
              actions={[
                {
                  label: "Rotate key",
                  icon: <KeyRoundIcon className="size-4" />,
                  onSelect: async () => {
                    if (
                      !confirm(
                        `Rotate the key for ${d.name}? The current key stops working immediately and the new one is shown only once.`,
                      )
                    )
                      return;
                    try {
                      const res = await api<Deployment & { key: string }>(
                        `/v1/deployments/${d.id}/rotate_key`,
                        { method: "POST", body: "{}" },
                      );
                      setRotatedKey(res.key);
                      load();
                    } catch {}
                  },
                },
                {
                  label: d.disabled ? "Enable" : "Disable",
                  icon: d.disabled ? (
                    <PlayCircleIcon className="size-4" />
                  ) : (
                    <PauseCircleIcon className="size-4" />
                  ),
                  onSelect: async () => {
                    try {
                      await api(`/v1/deployments/${d.id}`, {
                        method: "POST",
                        body: JSON.stringify({ disabled: !d.disabled }),
                      });
                      load();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (
                      !confirm(
                        `Delete deployment ${d.name}? Its key stops working immediately. This can't be undone.`,
                      )
                    )
                      return;
                    try {
                      await api(`/v1/deployments/${d.id}`, { method: "DELETE" });
                      load();
                    } catch {}
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    [api, load, agentNames, envNames],
  );

  return (
    <DataTable<Deployment>
      createLabel="+ New deployment"
      onCreate={() => setShowCreate(true)}
      data={deployments}
      loading={loading}
      getRowId={(d) => d.id}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle="No deployments yet"
      emptySubtitle="Publish an agent behind a publishable key so your frontend can talk to it directly."
      emptyAction={
        <Button onClick={() => setShowCreate(true)}>+ New deployment</Button>
      }
      columns={columns}
    >
      <CreateDeploymentDialog open={showCreate} onClose={() => setShowCreate(false)} />

      <DeploymentKeyModal
        open={!!rotatedKey}
        onClose={() => setRotatedKey("")}
        deploymentKey={rotatedKey}
        title="Key Rotated"
      />
    </DataTable>
  );
}
