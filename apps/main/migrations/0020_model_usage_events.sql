-- Per-model-call token usage + estimated cost (docs/budgets.md). One row
-- per span.model_request_end, idempotent on (session_id,
-- model_request_start_id) so crash/resume never double counts.
CREATE TABLE `model_usage_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`thread_id` text NOT NULL,
	`turn_id` text,
	`model_request_start_id` text NOT NULL,
	`model` text NOT NULL,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cache_read_input_tokens` integer NOT NULL,
	`cache_creation_input_tokens` integer NOT NULL,
	`cost_usd` real,
	`created_at` integer NOT NULL,
	`billed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_model_usage_events_call` ON `model_usage_events` (`session_id`,`model_request_start_id`);
--> statement-breakpoint
CREATE INDEX `idx_model_usage_events_tenant` ON `model_usage_events` (`tenant_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_model_usage_events_agent` ON `model_usage_events` (`tenant_id`,`agent_id`,`created_at`);
