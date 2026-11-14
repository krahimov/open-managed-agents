/**
 * Console-side Session list/detail row. Differs from
 * `@open-managed-agents/api-types`' `SessionMeta` (wire-format) — the
 * list endpoint returns `agent: {id, version}` rather than `agent_id`
 * + `agent_version`, and `title` may be null.
 *
 * Lifted out of SessionsList.tsx so SessionDetail and other consumers
 * can share the shape instead of redefining their own.
 */
export interface SessionRecord {
  id: string;
  title?: string | null;
  /** The list and detail endpoints embed a snapshot of the agent as it was
   *  when the session started, so the agent's name is available without a
   *  second request. */
  agent: {
    id: string;
    version: number;
    name?: string;
    description?: string;
    model?: string | { id: string; speed?: string };
  };
  environment_id: string;
  status?: string;
  created_at: string;
  updated_at?: string | null;
  archived_at?: string | null;
  terminated_at?: string | null;
  vault_ids?: string[];
  metadata?: Record<string, unknown>;
  stats?: { duration_seconds?: number };
}
