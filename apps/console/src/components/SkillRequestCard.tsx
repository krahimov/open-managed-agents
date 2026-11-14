import { useState } from "react";
import { useParams, Link } from "react-router";
import { toast } from "sonner";
import { PuzzleIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

import { useApi } from "../lib/api";
import type { Event } from "../lib/events";
import { Chip } from "./Badge";
import { EventCard } from "./EventCard";
import { humanSkillName, skillSummary } from "./resources/skills";
import { AnsweredRequest, NEEDS_YOU_CARD, PassedRequest } from "./sessions/RequestParts";
import { withReason } from "@/lib/failure-text";

/**
 * Agent-initiated skill acquisition, shown for system.skill_request events
 * (the agent's request_skill tool). One click ratifies it: the backend
 * installs the skill if needed (quarantine-enforced: blocked content is
 * refused there), attaches it to the agent, and hands the playbook to the
 * running session so the agent continues immediately.
 *
 * It is a request waiting on a person, so it wears the same amber card as
 * a tool approval; once attached it relaxes into one quiet line. Which of
 * the two it is comes from the session's log (`state`, see
 * sessions/requests.ts), so it survives a reload; a request the person
 * replied past without attaching is a neutral row that can still be used.
 */
export function SkillRequestCard({
  event,
  sessionId: sessionIdProp,
  state = "open",
  agentName: agentNameProp,
}: {
  event: Event;
  /** The asking agent's name; "The agent" when unknown. */
  agentName?: string;
  /** What the log says became of this request. */
  state?: "open" | "answered" | "passed";
  /** SessionChat must pass this: its route param is the AGENT id. */
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
  const slug = ev.skill_name ?? "skill";
  // The same reading the catalog and the Skills page give a skill: a name
  // people say ("Word documents") and one whole sentence about what it does,
  // not the instructions its author wrote for the model.
  const name = humanSkillName(slug);
  const summary = skillSummary(ev.description, 140);
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
      toast.success(`${name} attached`);
    } catch (err) {
      setStatus("error");
      setError(withReason("The skill could not be attached", err));
    }
  };

  const unknown = ev.resolution === "unknown";
  const agentName = agentNameProp?.trim() || "The agent";
  if (status === "attached" || state === "answered") {
    return (
      <AnsweredRequest>
        <span className="font-medium text-fg">{name}</span> attached.{" "}
        {status === "attached" ? `${agentName} has the playbook and is picking the task back up.` : `${agentName} was given the playbook and carried on.`}
      </AnsweredRequest>
    );
  }

  if (state === "passed" && status === "pending") {
    return (
      <PassedRequest
        icon={PuzzleIcon}
        title={`${agentName} asked for the ${name} skill`}
        note={ev.reason}
        action={
          unknown ? (
            <Button asChild variant="outline" size="sm">
              <Link to="/skills/catalog">Browse the catalog</Link>
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={attach}>
              {ev.resolution === "catalog" ? "Scan and attach it" : "Attach it"}
            </Button>
          )
        }
      />
    );
  }

  return (
    <div data-needs-you={state === "open" ? "skill" : undefined} className="scroll-my-24">
    <EventCard
      kind="approval"
      className={NEEDS_YOU_CARD}
      icon={PuzzleIcon}
      title={`${agentName} asks for the ${name} skill`}
      subtitle={ev.reason || "It says this skill would help with the task."}
      meta={
        ev.resolution === "installed" ? (
          <Chip>Installed in this workspace</Chip>
        ) : ev.resolution === "catalog" ? (
          <Chip title={ev.catalog_source ? `${slug} · ${ev.catalog_source}` : slug}>From the curated catalog</Chip>
        ) : (
          <Chip tone="outline">Not found</Chip>
        )
      }
      actions={
        unknown ? (
          <Button asChild variant="outline" size="sm">
            <Link to="/skills/catalog">Browse the catalog</Link>
          </Button>
        ) : (
          <Button size="sm" onClick={attach} loading={status === "working"} loadingLabel="Attaching…">
            {ev.resolution === "catalog" ? "Scan and attach it" : "Attach it"}
          </Button>
        )
      }
    >
      {summary && <p className="text-small text-fg">{summary}</p>}
      {error && (
        <p role="alert" className="text-small text-danger">
          {error}
        </p>
      )}
      <p className="text-xs leading-relaxed text-fg-muted">
        {unknown
          ? "No skill with this name is installed or in the curated catalog. Install one, then ask the agent to try again."
          : "Attaching scans the content, pins its hash and hands the playbook to the running session, so the agent continues right away."}
      </p>
    </EventCard>
    </div>
  );
}
