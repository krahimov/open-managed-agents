CREATE TABLE `memory_facts` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`store_id` text NOT NULL,
	`agent_id` text,
	`kind` text NOT NULL,
	`subject` text NOT NULL,
	`statement` text NOT NULL,
	`applies_when` text,
	`confidence` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`supersedes_id` text,
	`source_path` text,
	`source_session_id` text,
	`source_event_id` text,
	`observed_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_memory_facts_store_status` ON `memory_facts` (`store_id`,`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_subject` ON `memory_facts` (`store_id`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_memory_facts_source_session` ON `memory_facts` (`source_session_id`);--> statement-breakpoint
CREATE VIRTUAL TABLE `memory_facts_fts` USING fts5(`subject`, `statement`, `applies_when`, content='memory_facts', content_rowid='rowid', tokenize='porter unicode61');--> statement-breakpoint
CREATE TRIGGER `memory_facts_ai` AFTER INSERT ON `memory_facts` BEGIN
	INSERT INTO `memory_facts_fts`(rowid, subject, statement, applies_when) VALUES (new.rowid, new.subject, new.statement, new.applies_when);
END;--> statement-breakpoint
CREATE TRIGGER `memory_facts_ad` AFTER DELETE ON `memory_facts` BEGIN
	INSERT INTO `memory_facts_fts`(memory_facts_fts, rowid, subject, statement, applies_when) VALUES ('delete', old.rowid, old.subject, old.statement, old.applies_when);
END;--> statement-breakpoint
CREATE TRIGGER `memory_facts_au` AFTER UPDATE ON `memory_facts` BEGIN
	INSERT INTO `memory_facts_fts`(memory_facts_fts, rowid, subject, statement, applies_when) VALUES ('delete', old.rowid, old.subject, old.statement, old.applies_when);
	INSERT INTO `memory_facts_fts`(rowid, subject, statement, applies_when) VALUES (new.rowid, new.subject, new.statement, new.applies_when);
END;
