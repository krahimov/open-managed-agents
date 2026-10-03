-- Per-model-call token usage + estimated cost (docs/budgets.md). One row
-- per span.model_request_end, idempotent on (session_id,
-- model_request_start_id) so crash/resume never double counts.
CREATE TABLE "model_usage_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"session_id" text NOT NULL,
	"agent_id" text,
	"thread_id" text NOT NULL,
	"turn_id" text,
	"model_request_start_id" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" bigint NOT NULL,
	"output_tokens" bigint NOT NULL,
	"cache_read_input_tokens" bigint NOT NULL,
	"cache_creation_input_tokens" bigint NOT NULL,
	"cost_usd" double precision,
	"created_at" bigint NOT NULL,
	"billed_at" bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_model_usage_events_call" ON "model_usage_events" ("session_id","model_request_start_id");
--> statement-breakpoint
CREATE INDEX "idx_model_usage_events_tenant" ON "model_usage_events" ("tenant_id","created_at");
--> statement-breakpoint
CREATE INDEX "idx_model_usage_events_agent" ON "model_usage_events" ("tenant_id","agent_id","created_at");
