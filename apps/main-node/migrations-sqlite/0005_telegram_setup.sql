ALTER TABLE telegram_outbox ADD COLUMN reply_markup TEXT;
--> statement-breakpoint
ALTER TABLE telegram_conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'work';
--> statement-breakpoint
ALTER TABLE telegram_conversations ADD COLUMN transition_id TEXT;
