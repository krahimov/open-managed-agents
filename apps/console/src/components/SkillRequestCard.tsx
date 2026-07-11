import { useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { Button } from "@/components/ui/button";
import type { Event } from "../lib/events";

/**
 * Agent-initiated skill acquisition — rendered for system.skill_request
 * events (the agent's request_skill tool). One click ratifies: the backend
 * installs if needed (quarantine-enforced — blocked content 422s there),
 * attaches the skill to the agent, and injects the playbook into the
 * running session so the agent continues immediately. Same card family as
 * access-request / harness-diff / ambient-rule.
 */
export function SkillRequestCard({
  event,
  sessionId: sessionIdProp,
}: {
  event: Event;
  /** SessionChat must pass this — its route param is the AGENT id. */
  sessionId?: string;
}) {
  const { api } = useApi();
  const { id: routeId } = useParams();
  const sessionId = sessionIdProp ?? routeId;
  const ev = event as unknown as {
    request_id?: string;
    agent_id?: string;
    skill_name?: string;
    reason?: string;
    skill_id?: string;
    catalog_source?: string;
    resolution?: "installed" | "catalog" | "unknown";
    description?: string;
  };
  const name = ev.skill_name ?? "skill";
  const [status, setStatus] = useState<"pending" | "working" | "attached" | "error">("pending");
  const [error, setError] = useState<string | null>(null);

  const attach = async () => {
    setError(null);
    setStatus("working");
    try {
      await api("/v1/skills/acquire", {
        method: "POST",
        body: JSON.stringify({
          agent_id: ev.agent_id,
          session_id: sessionId,
          skill_id: ev.skill_id,
          source: ev.catalog_source,
        }),
      });
      setStatus("attached");
      toast.success(`Skill ${name} attached.`);
    } catch (err) {
      setStatus("error");
      setError(err instanceof Error ? err.message : "Attach failed");
    }
  };

  const provenance =
    ev.resolution === "installed"
      ? "already installed in this workspace"
      : ev.resolution === "catalog"
        ? `curated catalog · ${ev.catalog_source}`
        : "not found in store or catalog";

  return (
    <div className="max-w-2xl border border-border rounded-lg bg-bg-surface px-4 py-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            Agent requests the <span className="font-mono">{name}</span> skill
          </div>
          {ev.reason && <div className="text-xs text-fg-subtle mt-0.5">{ev.reason}</div>}
          <div className="text-[11px] text-fg-subtle mt-1 font-mono">{provenance}</div>
        </div>
        {status === "attached" ? (
          <span className="text-xs font-medium text-success whitespace-nowrap">Attached ✓</span>
        ) : ev.resolution === "unknown" ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/skills/catalog">Browse catalog</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={attach} disabled={status === "working"}>
            {status === "working"
              ? "Attaching…"
              : ev.resolution === "catalog"
                ? `Scan & attach ${name}`
                : `Attach ${name}`}
          </Button>
        )}
      </div>
      {ev.description && status !== "attached" && (
        <p className="mt-2 text-[11px] text-fg-subtle line-clamp-2">{ev.description}</p>
      )}
      {error && <div className="mt-2 text-xs text-danger">{error}</div>}
      <div className="mt-2 text-[11px] text-fg-subtle">
        Attaching scans the content, pins its hash, and hands the playbook to the running
        session — the agent picks the task back up immediately.
      </div>
    </div>
  );
}
