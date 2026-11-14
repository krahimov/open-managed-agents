import { useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { Link, useNavigate } from "react-router";
import { CheckIcon, ChevronDownIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { inlineLink } from "@/lib/links";

import { useAsyncAction } from "../hooks/useAsyncAction";
import { useApi } from "../lib/api";
import { plural } from "../lib/format";
import { useApiQuery } from "../lib/useApiQuery";
import type { AgentRecord } from "../types/agent";
import { Callout } from "./Callout";
import { ModelBadge } from "./ModelBadge";
import { QueryProblem } from "./QueryProblem";
import { Button } from "./ui/button";
import { failureSentence } from "@/lib/failure-text";

export const SAMPLE_TASK = "Reply with a short checklist explaining what you can help with. Do not use tools, access external services, modify files, or send messages.";

const link = inlineLink;

/**
 * The setup guide on Home: three steps from nothing to a first result, and
 * a harmless sample task to prove the last one. Steps that can be checked
 * from data already on the page show as done.
 */
export function FirstRunGuide() {
  const { api } = useApi();
  const nav = useNavigate();
  const agents = useApiQuery<{ data: AgentRecord[] }>("/v1/agents", { limit: "50", status: "active" });
  const [chosenAgent, setChosenAgent] = useState("");
  const [sampleSession, setSampleSession] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<string | null>(null);
  const [environmentId, setEnvironmentId] = useState("");
  const agentList = agents.data?.data ?? [];
  const selected = agentList.find((agent) => agent.id === chosenAgent);
  const needsEnvironment = !!selected && !selected._oma?.default_environment_id && !selected._oma?.runtime_binding;
  const environments = useApiQuery<{ data: Array<{ id: string; name: string; status: string }> }>("/v1/environments", undefined, { enabled: needsEnvironment });
  const sample = useAsyncAction(async () => {
    if (!selected || (needsEnvironment && !environmentId)) return;
    setSampleError(null);
    try {
      let sessionId = sampleSession;
      if (!sessionId) {
        const created = await api<{ id: string }>("/v1/sessions", { method: "POST", body: JSON.stringify({
          agent: selected.id, title: "First sample task",
          ...(selected._oma?.default_environment_id || environmentId ? { environment_id: selected._oma?.default_environment_id || environmentId } : {}),
        }) });
        sessionId = created.id; setSampleSession(sessionId);
      }
      await api(`/v1/sessions/${sessionId}/events`, { method: "POST", body: JSON.stringify({ events: [{ type: "user.message", content: [{ type: "text", text: SAMPLE_TASK }] }] }) });
      nav(`/sessions/${sessionId}`);
    } catch (err) { setSampleError(failureSentence(err)); }
  });

  const steps: Array<{ title: string; body: string; links: ReactNode; done?: boolean; note?: string }> = [
    {
      title: "Create an agent",
      body: "Pick a template and choose its model. Setup chat helps refine the instructions.",
      links: <Link className={link} to="/agents?create=1">Choose a template</Link>,
      done: agentList.length > 0,
      note: agentList.length > 0 ? `${plural(agentList.length, "agent")} ready` : undefined,
    },
    {
      title: "Check execution access",
      body: "Configure a model provider and environment, or connect a local runtime. Connect the apps your task needs.",
      links: (
        <>
          <Link className={link} to="/model-cards">Models</Link>
          <Link className={link} to="/environments">Environments</Link>
          <Link className={link} to="/runtimes">Runtimes</Link>
          <Link className={link} to="/integrations/apps">Apps</Link>
        </>
      ),
    },
    {
      title: "Try a small task",
      body: "Send the sample below, then inspect its response, events, and usage.",
      links: <Link className={link} to="/operations">Review approvals and failures</Link>,
      done: !!sampleSession,
    },
  ];

  return (
    <section className="surface animate-rise-in overflow-hidden rounded-xl" aria-label="First run setup">
      <div className="px-6 pt-5">
        <h2 className="text-h2 text-fg">From template to first result</h2>
        <p className="mt-0.5 text-small text-fg-muted">Three steps to an agent that has done something for you.</p>
      </div>
      <ol className="grid gap-6 px-6 pt-5 pb-6 md:grid-cols-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-full text-micro-size font-semibold",
                step.done ? "bg-success-subtle text-success" : "bg-bg-soft text-fg",
              )}
            >
              {step.done ? <CheckIcon className="size-3.5 stroke-[2.5]" aria-label="Done" /> : i + 1}
            </span>
            <div className="min-w-0 space-y-1.5">
              <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-fg">
                {step.title}
                {step.note && <span className="text-xs font-normal text-fg-subtle">{step.note}</span>}
              </p>
              <p className="text-small text-fg-muted">{step.body}</p>
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-small">{step.links}</div>
            </div>
          </li>
        ))}
      </ol>
      <div className="space-y-3 border-t border-border bg-bg-inset/60 px-6 py-5">
        <div>
          <h3 className="text-h3 text-fg">Sample task</h3>
          <p className="mt-0.5 text-small text-fg-muted">A safe first message: the agent only describes what it can do.</p>
        </div>
        <p className="rounded-lg border border-border bg-bg-surface px-3.5 py-3 text-small text-fg dark:bg-bg-soft">{SAMPLE_TASK}</p>
        {agents.error && <QueryProblem title="Agents could not be loaded" error={agents.error} retry={agents.refetch} compact />}
        <div className="flex flex-col gap-2 sm:flex-row">
          <NativeSelect
            aria-label="Agent for sample task"
            value={chosenAgent}
            onChange={(e) => { setChosenAgent(e.target.value); setSampleError(null); setEnvironmentId(""); }}
            disabled={sample.loading || !!sampleSession}
            wrapperClassName="flex-1"
          >
            <option value="">Choose an agent</option>
            {agentList.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </NativeSelect>
          <Button onClick={sample.run} disabled={!selected || (needsEnvironment && !environmentId)} loading={sample.loading}>
            {sampleSession ? "Send sample task" : "Run sample task"}
          </Button>
        </div>
        {needsEnvironment && (
          <label className="block text-small-size font-medium text-fg">
            Environment
            <NativeSelect
              value={environmentId}
              disabled={sample.loading || !!sampleSession}
              onChange={(e) => setEnvironmentId(e.target.value)}
              wrapperClassName="mt-1.5 font-normal"
            >
              <option value="">Choose a ready environment</option>
              {environments.data?.data.filter((row) => row.status === "ready").map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </NativeSelect>
          </label>
        )}
        {environments.error && <QueryProblem title="Environments could not be loaded" error={environments.error} retry={environments.refetch} compact />}
        {selected && (
          <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-muted">
            <span>Runs on</span>
            <ModelBadge model={selected.model} variant="plain" />
            <span>and counts toward usage.</span>
            <Link className={link} to={`/agents/${selected.id}/setup`}>Open agent setup</Link>
          </p>
        )}
        {sampleError && (
          <Callout tone="danger" title="The sample task was not sent">
            {sampleError}
          </Callout>
        )}
        {sampleSession && (
          <p className="text-small text-fg-muted">
            Session created.{" "}
            <Link className={link} to={`/sessions/${sampleSession}`}>Open it to inspect the result or continue manually.</Link>
          </p>
        )}
      </div>
    </section>
  );
}

/**
 * A native <select> dressed as the kit's Select trigger. The guide keeps
 * the native element: it is a plain list of names, and it works with
 * the browser's own keyboard and assistive behaviour unchanged.
 */
function NativeSelect({
  wrapperClassName,
  className,
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }) {
  return (
    <span className={cn("relative block min-w-0", wrapperClassName)}>
      <select
        className={cn(
          "h-9 w-full min-w-0 appearance-none rounded-md border border-border-strong bg-bg-surface pr-9 pl-3 text-sm text-fg shadow-[var(--shadow-xs)] transition-quick hover:border-fg-faint focus-visible:border-plum focus-visible:shadow-[var(--shadow-focus)] focus-visible:outline-none disabled:pointer-events-none disabled:bg-bg-inset disabled:opacity-60 dark:bg-bg-soft",
          className,
        )}
        {...props}
      >
        {children}
      </select>
      <ChevronDownIcon aria-hidden="true" className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-fg-subtle" />
    </span>
  );
}
