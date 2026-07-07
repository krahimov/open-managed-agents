-- The A1 publish flow inserts a publication shell row with an "" sentinel
-- installation_id before OAuth completes (bindInstallation later sets the
-- real id). SQLite/D1 never enforced the FK, but Postgres did — making
-- Slack/Linear/GitHub publishing 500 on every PG deployment. The reference
-- is app-managed; drop the constraints.
ALTER TABLE "slack_publications" DROP CONSTRAINT IF EXISTS "slack_publications_installation_id_slack_installations_id_fk";--> statement-breakpoint
ALTER TABLE "linear_publications" DROP CONSTRAINT IF EXISTS "linear_publications_installation_id_linear_installations_id_fk";--> statement-breakpoint
ALTER TABLE "github_publications" DROP CONSTRAINT IF EXISTS "github_publications_installation_id_github_installations_id_fk";
