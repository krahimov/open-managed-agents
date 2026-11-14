// Wire shapes for /v1/missions (main-node apps/main-node/src/lib/missions.ts).

export interface MissionVerifier {
  kind: "command";
  command: string;
  timeout_ms?: number;
}

export interface MissionVerdictResult {
  command: string;
  pass: boolean;
  output_snippet: string;
}

export interface MissionVerdict {
  iteration: number;
  results: MissionVerdictResult[];
  all_pass: boolean;
  judge: "skipped";
  at: string;
}

export type MissionStatus =
  | "running"
  | "succeeded"
  | "stopped"
  | "budget_exhausted"
  | "stuck";

export interface Mission {
  id: string;
  agent_id: string;
  goal: string;
  verifiers: MissionVerifier[];
  budget: { max_iterations: number; wall_clock_minutes: number };
  status: MissionStatus;
  iteration: number;
  active_session_id: string | null;
  workspace: string;
  last_verdict: MissionVerdict | null;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
}

/** GET /v1/missions/:id extends the row with its iteration sessions. */
export interface MissionIterationSession {
  session_id: string;
  status: string;
  title: string;
  iteration: number | null;
  created_at: number;
  updated_at: number | null;
}

export interface MissionDetailRecord extends Mission {
  iterations: MissionIterationSession[];
}

export function missionStatusCls(status: MissionStatus | string): string {
  switch (status) {
    case "running": return "bg-info-subtle text-info";
    case "succeeded": return "bg-success-subtle text-success";
    case "budget_exhausted": return "bg-warning-subtle text-warning";
    case "stuck": return "bg-danger-subtle text-danger";
    default: return "bg-bg-surface text-fg-muted";
  }
}
