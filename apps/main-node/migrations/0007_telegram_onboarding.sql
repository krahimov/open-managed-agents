CREATE TABLE telegram_accounts (
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT,
 active_agent_id TEXT,
 chat_id TEXT UNIQUE,
 telegram_user_id TEXT,
 link_hash TEXT UNIQUE,
 link_expires_at BIGINT,
 PRIMARY KEY (tenant_id, user_id)
);
--> statement-breakpoint
CREATE TABLE telegram_conversations (
 session_id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 last_seq BIGINT NOT NULL DEFAULT -1,
 UNIQUE (tenant_id, user_id, agent_id)
);
--> statement-breakpoint
CREATE TABLE telegram_inbox (
 update_id TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 done INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at BIGINT NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE telegram_outbox (
 id TEXT PRIMARY KEY,
 tenant_id TEXT NOT NULL,
 user_id TEXT NOT NULL,
 chat_id TEXT NOT NULL,
 text TEXT NOT NULL,
 sent INTEGER NOT NULL DEFAULT 0,
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at BIGINT NOT NULL DEFAULT 0
);
