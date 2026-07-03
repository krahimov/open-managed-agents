CREATE TABLE "ambient_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"config" text NOT NULL,
	"enabled" integer NOT NULL,
	"trigger_source" text NOT NULL,
	"wake_mode" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint,
	"next_wake_at" bigint,
	"last_wake_at" bigint,
	"deleted_at" bigint
);
--> statement-breakpoint
CREATE INDEX "idx_ambient_rules_tenant_agent" ON "ambient_rules" ("tenant_id","agent_id","deleted_at");--> statement-breakpoint
CREATE INDEX "idx_ambient_rules_due" ON "ambient_rules" ("tenant_id","enabled","next_wake_at");--> statement-breakpoint
CREATE INDEX "idx_ambient_rules_source" ON "ambient_rules" ("tenant_id","trigger_source","enabled");
