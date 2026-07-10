import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useApi } from "../lib/api";
import { useApiQuery, useQueryClient } from "../lib/useApiQuery";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { Combobox } from "../components/Combobox";
import { DataTable, type ColumnDef } from "../components/DataTable";
import type { Mission } from "../types/mission";
import { missionStatusCls } from "../types/mission";

interface AgentLite {
  id: string;
  name: string;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

export function MissionsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [agentId, setAgentId] = useState("");
  const [goal, setGoal] = useState("");
  const [verifiersText, setVerifiersText] = useState("");
  const [maxIterations, setMaxIterations] = useState(10);
  const [wallClock, setWallClock] = useState(120);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Missions are few and mutate server-side (the supervisor pump advances
  // them) — poll the list while any mission is running so status pills and
  // iteration counters stay live without a manual refresh.
  const { data, isLoading } = useApiQuery<{ data: Mission[] }>(
    "/v1/missions",
    undefined,
    {
      refetchInterval: (query) => {
        const rows = (query.state.data as { data: Mission[] } | undefined)?.data;
        return rows?.some((m) => m.status === "running") ? 5_000 : false;
      },
    },
  );
  const missions = data?.data ?? [];

  const closeModal = () => {
    setShowCreate(false);
    setAgentId("");
    setGoal("");
    setVerifiersText("");
    setMaxIterations(10);
    setWallClock(120);
    setFormError(null);
  };

  const verifierLines = verifiersText
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const canSubmit = !!agentId && !!goal.trim() && verifierLines.length > 0 && !submitting;

  const onSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const mission = await api<Mission>("/v1/missions", {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          goal: goal.trim(),
          verifiers: verifierLines.map((command) => ({ kind: "command", command })),
          budget: { max_iterations: maxIterations, wall_clock_minutes: wallClock },
        }),
      });
      void queryClient.invalidateQueries({ queryKey: ["/v1/missions"] });
      closeModal();
      nav(`/missions/${mission.id}`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  };

  const columns = useMemo<ColumnDef<Mission>[]>(
    () => [
      {
        id: "goal",
        accessorKey: "goal",
        header: "Goal",
        cell: ({ row }) => (
          <span className="font-medium text-fg block max-w-[28rem] truncate" title={row.original.goal}>
            {row.original.goal}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "agent",
        accessorKey: "agent_id",
        header: "Agent",
        cell: ({ row }) => (
          <span className="text-fg-muted font-mono text-xs">{row.original.agent_id}</span>
        ),
      },
      {
        id: "status",
        accessorKey: "status",
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${missionStatusCls(row.original.status)}`}
          >
            {row.original.status.replace("_", " ")}
          </span>
        ),
      },
      {
        id: "iterations",
        header: "Iterations",
        cell: ({ row }) => (
          <span className="text-fg-muted font-mono text-xs">
            {row.original.iteration}/{row.original.budget.max_iterations}
          </span>
        ),
      },
      {
        id: "updated",
        accessorKey: "updated_at",
        header: "Updated",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.updated_at).toLocaleString(undefined, {
              month: "numeric",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <DataTable<Mission>
      createLabel="+ New mission"
      onCreate={() => setShowCreate(true)}
      data={missions}
      loading={isLoading}
      getRowId={(m) => m.id}
      onRowClick={(m) => nav(`/missions/${m.id}`)}
      emptyTitle="No missions yet"
      emptyKind="session"
      emptySubtitle="A mission runs an agent in a supervised loop — fresh sessions toward a goal until its verifier commands pass or the budget runs out."
      emptyAction={<Button onClick={() => setShowCreate(true)}>+ New mission</Button>}
      columns={columns}
    >
      <Modal
        open={showCreate}
        onClose={closeModal}
        title="New Mission"
        subtitle="Repeated effort under supervision — iterate until the checks pass."
        maxWidth="max-w-2xl"
        footer={
          <>
            <Button variant="ghost" onClick={closeModal}>Cancel</Button>
            <Button onClick={onSubmit} disabled={!canSubmit} loading={submitting}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <label className="text-sm text-fg-muted block mb-1">Agent</label>
            <Combobox<AgentLite>
              value={agentId}
              onValueChange={(v) => setAgentId(v)}
              endpoint="/v1/agents"
              getValue={(a) => a.id}
              getLabel={(a) => (
                <span>
                  {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
                </span>
              )}
              getTextLabel={(a) => `${a.name} (${a.id})`}
              placeholder="Select agent..."
            />
          </div>
          <div>
            <label htmlFor="mission-goal" className="text-sm text-fg-muted block mb-1">Goal</label>
            <textarea
              id="mission-goal"
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              className={`${inputCls} min-h-20 resize-y`}
              placeholder="Make every test in the repo pass without skipping any."
            />
          </div>
          <div>
            <label htmlFor="mission-verifiers" className="text-sm text-fg-muted block mb-1">
              Verifier commands <span className="text-fg-subtle">(one per line, exit 0 = pass)</span>
            </label>
            <textarea
              id="mission-verifiers"
              value={verifiersText}
              onChange={(e) => setVerifiersText(e.target.value)}
              className={`${inputCls} min-h-20 resize-y font-mono text-xs`}
              placeholder={"npm test\nnpm run lint"}
            />
            <p className="text-xs text-fg-subtle mt-1">
              Run in the mission workspace after each iteration finishes its turn.
            </p>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label htmlFor="mission-max-iterations" className="text-sm text-fg-muted block mb-1">Max iterations</label>
              <input
                id="mission-max-iterations"
                type="number"
                min={1}
                max={200}
                value={maxIterations}
                onChange={(e) => setMaxIterations(Number(e.target.value))}
                className={inputCls}
              />
            </div>
            <div>
              <label htmlFor="mission-wall-clock" className="text-sm text-fg-muted block mb-1">Wall clock (minutes)</label>
              <input
                id="mission-wall-clock"
                type="number"
                min={1}
                max={1440}
                value={wallClock}
                onChange={(e) => setWallClock(Number(e.target.value))}
                className={inputCls}
              />
            </div>
          </div>
          {formError && <p className="text-xs text-danger">{formError}</p>}
        </div>
      </Modal>
    </DataTable>
  );
}
