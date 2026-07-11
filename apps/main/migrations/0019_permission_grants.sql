-- Permission grants: versioned, append-only access-policy documents per
-- agent (Phase 1 baseline layer; per-principal overlays arrive in Phase 3).
CREATE TABLE `permission_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text,
	`rules` text NOT NULL,
	`version` integer NOT NULL,
	`enabled` integer NOT NULL,
	`proposed_by` text,
	`approved_by` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_permission_grants_key` ON `permission_grants` (`tenant_id`,`agent_id`,`principal_type`,`principal_id`,`version`);
