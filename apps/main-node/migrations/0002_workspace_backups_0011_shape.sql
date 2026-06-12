-- Reconcile workspace_backups with CF migration 0011: the shared
-- node-workspace-backup code INSERTs (tenant_id, environment_id,
-- backup_handle, created_at, expires_at, source_session_id) with an
-- autoincrement id and SELECTs backup_handle. The consolidated PG baseline
-- shipped the pre-0011 shape (text id, session_id, blob_key, size_bytes),
-- so every backup query 42703'd — which failed session starts on prod.
--
-- DROP + recreate is safe: with the old shape no INSERT could ever have
-- succeeded on Postgres (incompatible NOT NULL columns), so the table is
-- provably empty on any PG deployment.
DROP TABLE IF EXISTS "workspace_backups";
--> statement-breakpoint
CREATE TABLE "workspace_backups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"environment_id" text NOT NULL,
	"backup_handle" text NOT NULL,
	"created_at" bigint NOT NULL,
	"expires_at" bigint NOT NULL,
	"source_session_id" text
);
--> statement-breakpoint
CREATE INDEX "idx_workspace_backups_scope_recent" ON "workspace_backups" ("tenant_id","environment_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_workspace_backups_expires" ON "workspace_backups" ("expires_at");
--> statement-breakpoint
-- Same reconciliation for session_resources: the shared sql-session-repo
-- reads/writes a single JSON `config` blob; the baseline shipped exploded
-- typed columns (mount_path, url, checkout_*, ...) with no `config`, so
-- every resource INSERT 42703'd on Postgres — table is provably empty.
DROP TABLE IF EXISTS "session_resources";
--> statement-breakpoint
CREATE TABLE "session_resources" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"type" text NOT NULL,
	"config" text NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_session_resources_session" ON "session_resources" ("session_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_session_resources_session_type" ON "session_resources" ("session_id","type");
