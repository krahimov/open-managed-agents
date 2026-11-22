CREATE TABLE imessage_accounts (
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT,
 active_agent_id TEXT,
 chat_id TEXT UNIQUE,
 sender_id TEXT,
 link_hash TEXT UNIQUE,
 link_expires_at BIGINT,
 PRIMARY KEY (tenant_id, user_id)
);
--> statement-breakpoint
CREATE TABLE imessage_conversations (
 session_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 last_seq BIGINT NOT NULL DEFAULT -1,
 UNIQUE (tenant_id, user_id, agent_id)
);
--> statement-breakpoint
CREATE TABLE imessage_inbox (
 update_id TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at BIGINT NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE imessage_outbox (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 text TEXT NOT NULL,
 sent INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at BIGINT NOT NULL DEFAULT 0
);

--> statement-breakpoint
ALTER TABLE imessage_outbox ADD COLUMN reply_markup TEXT;
--> statement-breakpoint
ALTER TABLE imessage_conversations ADD COLUMN mode TEXT NOT NULL DEFAULT 'work';
--> statement-breakpoint
ALTER TABLE imessage_conversations ADD COLUMN transition_id TEXT;

--> statement-breakpoint
ALTER TABLE imessage_inbox ADD COLUMN received_at BIGINT NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE imessage_notices (sender_hash TEXT PRIMARY KEY, last_at BIGINT NOT NULL);
