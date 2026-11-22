CREATE TABLE channel_key_links (
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  account_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  vault_id TEXT,
  credential_id TEXT,
  completed INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, session_id, request_id)
);
--> statement-breakpoint
CREATE TABLE channel_key_attempts (
  bucket TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
