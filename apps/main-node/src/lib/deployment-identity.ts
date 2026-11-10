// Deployment identity — the value stamped on every sandbox this install
// creates (`oma-deployment-id` label) so cleanup can tell its own boxes from
// those of another OMA install sharing the same provider account (prod and a
// laptop running against the same Daytona key, for example).
//
// Resolution:
//   1. OMA_DEPLOYMENT_ID when set — pin it for deployments that must keep
//      their identity across a database rebuild.
//   2. Otherwise a random id generated once and stored in the database. The
//      database is what "this deployment" means for cleanup (it is where
//      agents and sessions are looked up), so a fresh database gets a fresh
//      id and can never claim boxes created against a previous one.
//
// Pattern B (see agent-machine-store.ts): the table is created here with
// CREATE … IF NOT EXISTS, no drizzle migration.

import { randomBytes } from "node:crypto";
import type { SqlClient } from "@open-managed-agents/sql-client";

export interface DeploymentIdentity {
  id: string;
  source: "env" | "database";
}

const DEPLOYMENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;

export async function resolveDeploymentIdentity(deps: {
  sql: SqlClient;
  dialect: "sqlite" | "postgres";
  env?: Readonly<Record<string, string | undefined>>;
}): Promise<DeploymentIdentity> {
  const pinned = (deps.env ?? process.env).OMA_DEPLOYMENT_ID?.trim();
  if (pinned) {
    if (!DEPLOYMENT_ID_RE.test(pinned)) {
      throw new Error(
        "OMA_DEPLOYMENT_ID must be 1-63 characters of letters, digits, '.', '_' or '-' and start with a letter or digit",
      );
    }
    return { id: pinned, source: "env" };
  }

  const int = deps.dialect === "postgres" ? "BIGINT" : "INTEGER";
  await deps.sql.exec(`
    CREATE TABLE IF NOT EXISTS deployment_identity (
      singleton INTEGER PRIMARY KEY,
      deployment_id TEXT NOT NULL,
      created_at ${int} NOT NULL
    )
  `);
  // Two replicas booting together both insert; the loser's row is ignored
  // and both read the winner's id.
  const candidate = `dep_${randomBytes(8).toString("hex")}`;
  const insert =
    deps.dialect === "postgres"
      ? `INSERT INTO deployment_identity (singleton, deployment_id, created_at) VALUES (1, ?, ?)
         ON CONFLICT (singleton) DO NOTHING`
      : `INSERT OR IGNORE INTO deployment_identity (singleton, deployment_id, created_at) VALUES (1, ?, ?)`;
  await deps.sql.prepare(insert).bind(candidate, Date.now()).run();
  const row = await deps.sql
    .prepare(`SELECT deployment_id FROM deployment_identity WHERE singleton = 1`)
    .first<{ deployment_id: string }>();
  if (!row?.deployment_id) throw new Error("deployment identity could not be stored");
  return { id: row.deployment_id, source: "database" };
}
