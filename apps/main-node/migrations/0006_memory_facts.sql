CREATE TABLE "memory_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"store_id" text NOT NULL,
	"agent_id" text,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"statement" text NOT NULL,
	"applies_when" text,
	"confidence" double precision DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"supersedes_id" text,
	"source_path" text,
	"source_session_id" text,
	"source_event_id" text,
	"observed_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	"tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce("subject",'') || ' ' || coalesce("statement",'') || ' ' || coalesce("applies_when",''))) STORED
);
--> statement-breakpoint
CREATE INDEX "idx_memory_facts_store_status" ON "memory_facts" ("store_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_subject" ON "memory_facts" ("store_id","subject");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_source_session" ON "memory_facts" ("source_session_id");--> statement-breakpoint
CREATE INDEX "idx_memory_facts_tsv" ON "memory_facts" USING gin ("tsv");
