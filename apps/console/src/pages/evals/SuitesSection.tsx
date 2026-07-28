// Eval suites strip on the Eval Runs page (evals-design §8 save-as-eval).
//
// Compact pill-row list of the tenant's saved suites (KV-backed CRUD in
// http-routes/evals) rendered above the runs table. Hidden entirely when
// there are no suites — runtimes without a KV binding 501 and the strip
// simply doesn't appear. Row expand lazily fetches the full suite to show
// its task ids; Run asks for an environment (the run route requires one)
// and navigates to the created run.

import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useApiQuery, useQueryClient } from "../../lib/useApiQuery";
import { useAsyncAction } from "../../hooks/useAsyncAction";
import { Modal } from "../../components/Modal";
import { Select, SelectOption } from "../../components/Select";
import { Button } from "@/components/ui/button";
import { shortenId } from "../../lib/format";

interface SuiteSummary {
  id: string;
  name: string;
  agent_id?: string;
  task_count: number;
  created_at: string;
  updated_at: string;
}

interface SuiteDetail extends Omit<SuiteSummary, "task_count"> {
  tasks: Array<{ id: string }>;
}

function timeAgo(iso?: string): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

export function SuitesSection() {
  const { api } = useApi();
  const { data, refetch, error } = useApiQuery<{ data: SuiteSummary[] }>("/v1/evals/suites");
  const suites = data?.data ?? [];

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** Lazy full-suite cache keyed by suite id — same sentinel pattern as
   *  EvalRunDetail's trajectory map. */
  const [details, setDetails] = useState<Map<string, SuiteDetail | "loading" | "error">>(
    new Map(),
  );
  const [runTarget, setRunTarget] = useState<SuiteSummary | null>(null);

  // No suites yet (or suites unsupported on this runtime) → no chrome.
  if (error || suites.length === 0) return null;

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (details.has(id)) return;
    setDetails((prev) => new Map(prev).set(id, "loading"));
    api<SuiteDetail>(`/v1/evals/suites/${id}`)
      .then((suite) => setDetails((prev) => new Map(prev).set(id, suite)))
      .catch(() => setDetails((prev) => new Map(prev).set(id, "error")));
  }

  async function deleteSuite(s: SuiteSummary) {
    if (!confirm(`Delete suite ${s.name}? This can't be undone.`)) return;
    try {
      await api(`/v1/evals/suites/${s.id}`, { method: "DELETE" });
      toast.success(`Suite ${s.name} deleted`);
      void refetch();
    } catch {
      // api() already toasted
    }
  }

  const actionCls =
    "text-xs text-fg-muted hover:text-fg disabled:opacity-40 disabled:hover:text-fg-muted";

  return (
    <div className="pl-4 pr-5 pt-3">
      <div className="text-xs font-medium text-fg-muted mb-1.5">Suites</div>
      <table className="w-full text-sm border-separate border-spacing-y-1.5">
        <tbody>
          {suites.map((s) => {
            const isOpen = expanded.has(s.id);
            const detail = details.get(s.id);
            return [
              <tr key={s.id} className="bg-bg-surface/60 hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
                <td
                  className="w-8 text-fg-subtle px-3 py-2 text-center rounded-l-lg cursor-pointer"
                  onClick={() => toggleExpand(s.id)}
                >
                  {isOpen ? "▾" : "▸"}
                </td>
                <td className="px-3 py-2 text-fg cursor-pointer" onClick={() => toggleExpand(s.id)}>
                  {s.name}
                </td>
                <td className="px-3 py-2 text-fg-muted text-xs whitespace-nowrap">
                  {s.task_count} task{s.task_count === 1 ? "" : "s"}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-fg-muted" title={s.agent_id}>
                  {s.agent_id ? shortenId(s.agent_id) : "—"}
                </td>
                <td className="px-3 py-2 text-xs text-fg-muted whitespace-nowrap" title={s.updated_at}>
                  {timeAgo(s.updated_at)}
                </td>
                <td className="px-3 py-2 rounded-r-lg text-right whitespace-nowrap space-x-3">
                  <button
                    className={actionCls}
                    disabled={!s.agent_id || s.task_count === 0}
                    title={
                      !s.agent_id
                        ? "Suite has no agent pinned — set agent_id via POST /v1/evals/suites/:id"
                        : s.task_count === 0
                        ? "Suite has no tasks"
                        : `Run ${s.name} against ${shortenId(s.agent_id)}`
                    }
                    onClick={() => setRunTarget(s)}
                  >
                    Run
                  </button>
                  <button
                    className="text-xs text-fg-muted hover:text-danger"
                    title="Delete suite"
                    onClick={() => void deleteSuite(s)}
                  >
                    Delete
                  </button>
                </td>
              </tr>,
              isOpen && (
                <tr key={`${s.id}-tasks`} className="bg-bg-surface/30">
                  <td className="rounded-l-lg" />
                  <td colSpan={5} className="px-3 py-2 rounded-r-lg">
                    {detail === "loading" || detail === undefined ? (
                      <span className="text-xs text-fg-subtle">Loading tasks…</span>
                    ) : detail === "error" ? (
                      <span className="text-xs text-danger">Failed to load suite.</span>
                    ) : detail.tasks.length === 0 ? (
                      <span className="text-xs text-fg-subtle">No tasks yet.</span>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {detail.tasks.map((t) => (
                          <span
                            key={t.id}
                            className="inline-flex items-center text-[11px] font-mono px-1.5 py-0.5 rounded bg-bg-surface text-fg-muted"
                          >
                            {t.id}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              ),
            ];
          })}
        </tbody>
      </table>

      {runTarget && (
        <RunSuiteDialog suite={runTarget} onClose={() => setRunTarget(null)} />
      )}
    </div>
  );
}

/** Environment picker for POST /suites/:id/run — the route requires an
 *  environment_id, which the suite record doesn't carry. */
function RunSuiteDialog({ suite, onClose }: { suite: SuiteSummary; onClose: () => void }) {
  const { api } = useApi();
  const nav = useNavigate();
  const queryClient = useQueryClient();
  const [environmentId, setEnvironmentId] = useState("");

  const { data: envsRes } = useApiQuery<{ data: Array<{ id: string; name: string }> }>(
    "/v1/environments",
    { limit: "200" },
  );
  const environments = envsRes?.data ?? [];

  const run = useAsyncAction(async () => {
    if (!environmentId) return;
    try {
      const res = await api<{ run_id: string }>(`/v1/evals/suites/${suite.id}/run`, {
        method: "POST",
        body: JSON.stringify({ environment_id: environmentId }),
      });
      void queryClient.invalidateQueries({ queryKey: ["/v1/evals/runs"] });
      toast.success(`Run started from ${suite.name}`);
      onClose();
      nav(`/evals/${res.run_id}`);
    } catch {
      // api() already toasted
    }
  });

  const inputCls =
    "w-full px-3 py-1.5 rounded-md bg-bg border border-border text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-brand";

  return (
    <Modal
      open
      onClose={onClose}
      title={`Run ${suite.name}`}
      subtitle={`${suite.task_count} task${suite.task_count === 1 ? "" : "s"} against agent ${shortenId(suite.agent_id)}.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={run.loading}>
            Cancel
          </Button>
          <Button
            onClick={run.run}
            disabled={!environmentId}
            loading={run.loading}
            loadingLabel="Starting…"
          >
            Start run
          </Button>
        </>
      }
    >
      <div>
        <label className="text-sm text-fg-muted block mb-1">Environment *</label>
        {environments.length > 0 ? (
          <Select
            value={environmentId}
            onValueChange={setEnvironmentId}
            placeholder="Select an environment…"
          >
            {environments.map((e) => (
              <SelectOption key={e.id} value={e.id}>
                {e.name}
              </SelectOption>
            ))}
          </Select>
        ) : (
          // Node runtimes have no environments store yet — the route
          // accepts any id there, so fall back to free text.
          <input
            value={environmentId}
            onChange={(e) => setEnvironmentId(e.target.value)}
            className={inputCls}
            placeholder="environment id"
          />
        )}
      </div>
    </Modal>
  );
}
