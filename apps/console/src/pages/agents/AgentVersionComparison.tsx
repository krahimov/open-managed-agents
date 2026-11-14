import { useState } from "react";
import { Link } from "react-router";
import { FlaskConicalIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { useApi } from "../../lib/api";
import { formatCompact, formatCost, formatRelativeTime } from "../../lib/format";
import { useApiQuery } from "../../lib/useApiQuery";
import { PickSelect } from "../../components/agents/controls";
import { DiffLines, collapseContext, diffLines, valueToLines } from "../../components/agents/diff";
import { StatusBadge } from "../../components/Badge";
import { Callout } from "../../components/Callout";
import { Disclosure } from "../../components/Disclosure";
import { Field } from "../../components/Field";
import { SectionCard } from "../../components/SectionCard";
import { Skeleton } from "../../components/Skeleton";
import { Button } from "../../components/ui/button";
import type { AgentRecord } from "../../types/agent";
import { cn } from "@/lib/utils";
import { linkHitArea } from "@/lib/links";

type Metrics = {
  run_id: string; version: number; status: string; error?: string;
  total_trials: number; completed_trials: number; failed_trials: number;
  graded_trials: number; passed_trials: number; success_rate: number | null;
  mean_latency_ms: number | null; latency_samples: number;
  tool_calls: number | null; tool_failures: number | null;
  input_tokens: number | null; output_tokens: number | null;
  estimated_cost_usd: number | null; missing_trajectories: number;
};
type Comparison = {
  id: string; baseline_version: number; candidate_version: number;
  created_at: string; suite_name?: string;
  baseline: Metrics; candidate: Metrics;
  config_diff: Array<{ field: string; baseline: unknown; candidate: unknown }>;
};

const number = (value: number | null) => (value === null ? "Unavailable" : value.toLocaleString());
const tokens = (value: number | null) =>
  value === null ? "Unavailable" : value >= 10_000 ? formatCompact(value) : value.toLocaleString();

const FIELD_LABEL: Record<string, string> = {
  system: "Instructions",
  model: "Model",
  name: "Name",
  description: "Description",
  tools: "Tools",
  mcp_servers: "MCP servers",
  skills: "Skills",
  multiagent: "Delegation",
  callable_agents: "Delegation",
  harness: "Engine",
  reasoning_level: "Reasoning",
  memory: "Memory",
  metadata: "Metadata",
};

/**
 * Compare two versions of an agent on a saved test suite: both versions
 * run the same tests in fresh sessions, and the results sit side by side.
 * Lives in the agent profile's Versions tab.
 */
export function AgentVersionComparison({ agent, versions }: { agent: AgentRecord; versions: AgentRecord[] }) {
  const { api } = useApi();
  const allVersions = [...new Set([agent.version, ...versions.map((v) => v.version)])].sort((a, b) => b - a);
  const [baselineVersion, setBaselineVersion] = useState<number | null>(null);
  const [candidateVersion, setCandidateVersion] = useState<number | null>(null);
  const selectedBaseline = baselineVersion ?? allVersions[1] ?? agent.version;
  const selectedCandidate = candidateVersion ?? agent.version;
  const [suiteId, setSuiteId] = useState("");
  const [environmentId, setEnvironmentId] = useState(agent._oma?.default_environment_id ?? "");
  const [comparisonId, setComparisonId] = useState("");
  const [launching, setLaunching] = useState(false);
  const [launchError, setLaunchError] = useState("");
  const suites = useApiQuery<{ data: Array<{ id: string; name: string; task_count: number }> }>("/v1/evals/suites");
  const environments = useApiQuery<{ data: Array<{ id: string; name: string }> }>("/v1/environments");
  const comparisons = useApiQuery<{ data: Comparison[] }>("/v1/evals/comparisons", { agent_id: agent.id });
  const detail = useApiQuery<Comparison>(comparisonId ? `/v1/evals/comparisons/${comparisonId}` : null, undefined, {
    refetchInterval: (query) => {
      const comparison = query.state.data;
      return comparison && [comparison.baseline, comparison.candidate].every((run) => ["completed", "failed"].includes(run.status)) ? false : 2500;
    },
  });
  const usableSuites = suites.data?.data.filter((suite) => suite.task_count > 0) ?? [];
  const selectedSuite = suiteId || usableSuites[0]?.id || "";
  const selectedEnvironment = environmentId || environments.data?.data[0]?.id || "";
  const launch = async () => {
    setLaunching(true); setLaunchError("");
    try {
      const comparison = await api<{ id: string }>("/v1/evals/comparisons", {
        method: "POST", body: JSON.stringify({
          agent_id: agent.id, baseline_version: selectedBaseline, candidate_version: selectedCandidate,
          environment_id: selectedEnvironment, suite_id: selectedSuite,
        }),
      });
      setComparisonId(comparison.id);
      await comparisons.refetch();
    } catch (error) { setLaunchError(error instanceof Error ? error.message : "Could not start comparison"); }
    finally { setLaunching(false); }
  };
  const comparison = detail.data;
  const metrics: Array<{ label: string; value: (run: Metrics) => string }> = [
    { label: "Graded success", value: (run) => run.success_rate === null ? "Not graded" : `${(run.success_rate * 100).toFixed(0)}% (${run.passed_trials}/${run.graded_trials})` },
    { label: "Completed trials", value: (run) => `${run.completed_trials}/${run.total_trials}` },
    { label: "Failed trials", value: (run) => number(run.failed_trials) },
    { label: "Mean trial latency", value: (run) => run.mean_latency_ms === null ? "Unavailable" : `${(run.mean_latency_ms / 1000).toFixed(2)} s (${run.latency_samples} measured)` },
    { label: "Tool failures / calls", value: (run) => `${number(run.tool_failures)} / ${number(run.tool_calls)}` },
    { label: "Input tokens", value: (run) => tokens(run.input_tokens) },
    { label: "Output tokens", value: (run) => tokens(run.output_tokens) },
    { label: "Estimated model cost", value: (run) => run.estimated_cost_usd === null ? "Unavailable" : run.estimated_cost_usd >= 1 ? formatCost(run.estimated_cost_usd) : `$${run.estimated_cost_usd.toFixed(4)}` },
  ];

  const versionOptions = (markCurrent: boolean) =>
    allVersions.map((version) => ({
      value: String(version),
      label: `v${version}${markCurrent && version === agent.version ? " · current" : ""}`,
    }));
  const loadError = suites.error || comparisons.error || detail.error;
  const sameVersion = selectedBaseline === selectedCandidate;
  const blocker =
    allVersions.length < 2
      ? "Save a change to this agent to create a second version."
      : sameVersion
        ? "Pick two different versions."
        : !selectedSuite
          ? null
          : !selectedEnvironment
            ? "Choose an environment to run the tests in."
            : null;

  return (
    <SectionCard
      title={<span id="version-comparison-title">Compare two versions</span>}
      description="Run the same saved tests against two fixed versions. Each run starts fresh sessions and keeps its version's configuration, even if the agent changes later."
    >
      <section aria-labelledby="version-comparison-title" className="space-y-5">
        <div className="grid gap-x-3 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Baseline">
            <PickSelect
              aria-label="Baseline version"
              value={String(selectedBaseline)}
              onValueChange={(v) => setBaselineVersion(Number(v))}
              options={versionOptions(false)}
            />
          </Field>
          <Field label="Candidate">
            <PickSelect
              aria-label="Candidate version"
              value={String(selectedCandidate)}
              onValueChange={(v) => setCandidateVersion(Number(v))}
              options={versionOptions(true)}
            />
          </Field>
          <Field label="Test suite">
            <PickSelect
              aria-label="Saved test suite"
              value={selectedSuite}
              onValueChange={setSuiteId}
              placeholder={suites.isLoading ? "Loading suites" : "Choose a suite"}
              disabled={usableSuites.length === 0}
              options={usableSuites.map((suite) => ({
                value: suite.id,
                label: suite.name,
                hint: `${suite.task_count} ${suite.task_count === 1 ? "test" : "tests"}`,
              }))}
            />
          </Field>
          <Field label="Environment">
            {environments.data?.data.length ? (
              <PickSelect
                aria-label="Comparison environment"
                value={selectedEnvironment}
                onValueChange={setEnvironmentId}
                options={environments.data.data.map((environment) => ({ value: environment.id, label: environment.name }))}
              />
            ) : (
              <Input
                aria-label="Comparison environment"
                value={environmentId}
                onChange={(e) => setEnvironmentId(e.target.value)}
                placeholder="Environment id"
                className="font-mono placeholder:font-sans"
              />
            )}
          </Field>
        </div>

        {!selectedSuite && !suites.isLoading && (
          <Callout
            icon={FlaskConicalIcon}
            title="No saved test suite yet"
            action={
              <Button variant="outline" size="sm" asChild>
                <Link to="/evals">Create a saved test suite</Link>
              </Button>
            }
          >
            A suite is a set of tasks with pass criteria. Both versions are scored against it.
          </Callout>
        )}

        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="max-w-[62ch] text-xs text-fg-subtle">
            {blocker ??
              "Starting a comparison runs both versions and may incur model and tool charges. Estimated cost appears only when the trajectories record it."}
          </p>
          <Button
            variant="outline"
            onClick={launch}
            loading={launching}
            disabled={!selectedSuite || !selectedEnvironment || sameVersion}
          >
            Run comparison
          </Button>
        </div>

        {(launchError || loadError) && (
          <Callout tone="danger" title={launchError ? "The comparison could not be started" : "Comparison data could not be loaded"}>
            {launchError || loadError?.message}
          </Callout>
        )}

        {!!comparisons.data?.data.length && (
          <Field label="Earlier comparisons" className="max-w-xl">
            <PickSelect
              aria-label="Previous comparisons"
              value={comparisonId}
              onValueChange={setComparisonId}
              placeholder="Open an earlier comparison"
              options={comparisons.data.data.map((row) => ({
                value: row.id,
                label: `v${row.baseline_version} → v${row.candidate_version} · ${row.suite_name || "Custom tests"}`,
                hint: formatRelativeTime(row.created_at),
              }))}
            />
          </Field>
        )}

        {detail.isLoading && comparisonId && (
          <div className="space-y-2.5" role="status" aria-label="Loading comparison">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-9 w-full" rounded="md" />
            ))}
          </div>
        )}

        {comparison && (
          <div className="space-y-4">
            <div className="overflow-hidden rounded-lg border border-border">
              <Table className="text-small-size">
                <TableHeader>
                  <TableRow className="bg-bg-inset/60 hover:bg-bg-inset/60">
                    <TableHead className="pl-4">Measurement</TableHead>
                    {[comparison.baseline, comparison.candidate].map((run, index) => (
                      <TableHead key={run.run_id} className="px-4">
                        <span className="flex items-center gap-2">
                          <Link className={cn("font-mono text-fg underline decoration-border-strong underline-offset-4 hover:decoration-fg", linkHitArea)} to={`/evals/${run.run_id}`}>
                            v{run.version}
                          </Link>
                          <span className="font-normal">{index === 0 ? "Baseline" : "Candidate"}</span>
                          <StatusBadge status={run.status} />
                        </span>
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {metrics.map((metric) => (
                    <TableRow key={metric.label} className="hover:bg-transparent">
                      <TableHead scope="row" className="pl-4 font-normal text-fg-muted">
                        {metric.label}
                      </TableHead>
                      <MetricCell value={metric.value(comparison.baseline)} />
                      <MetricCell value={metric.value(comparison.candidate)} />
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {[comparison.baseline, comparison.candidate]
              .filter((run) => run.error || run.missing_trajectories > 0)
              .map((run) => (
                <Callout key={run.run_id} tone="danger" title={`v${run.version} did not finish cleanly`}>
                  {run.error || `${run.missing_trajectories} stored trajectories unavailable`}
                </Callout>
              ))}

            <Disclosure title="Configuration changes" meta={String(comparison.config_diff.length)}>
              {comparison.config_diff.length === 0 ? (
                <p className="text-small text-fg-subtle">The two versions have the same configuration.</p>
              ) : (
                <div className="space-y-3">
                  {comparison.config_diff.map((change) => (
                    <div key={change.field}>
                      <h4 className="mb-1.5 text-xs font-medium text-fg-subtle">{FIELD_LABEL[change.field] ?? change.field}</h4>
                      <div className="overflow-hidden rounded-md border border-border bg-bg-surface py-1.5 dark:bg-bg-inset">
                        <DiffLines rows={collapseContext(diffLines(valueToLines(change.baseline), valueToLines(change.candidate)))} />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Disclosure>
          </div>
        )}
      </section>
    </SectionCard>
  );
}

/** A measured value; "Unavailable" and "Not graded" are stated, in a quieter tone. */
function MetricCell({ value }: { value: string }) {
  const missing = value === "Unavailable" || value === "Not graded";
  return <TableCell className={`px-4 tabular-nums ${missing ? "text-fg-subtle" : "text-fg"}`}>{value}</TableCell>;
}
