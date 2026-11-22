import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core";

export const channel_key_links = sqliteTable("channel_key_links", {
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  session_id: text("session_id").notNull(),
  request_id: text("request_id").notNull(),
  channel: text("channel").notNull(),
  account_hash: text("account_hash").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  expires_at: integer("expires_at").notNull(),
  consumed: integer("consumed").notNull().default(0),
  vault_id: text("vault_id"),
  /** The credential this request's link created; a retry may update only this one. */
  credential_id: text("credential_id"),
  completed: integer("completed").notNull().default(0),
}, (t) => [primaryKey({ columns: [t.tenant_id, t.session_id, t.request_id] })]);
export const channel_key_attempts = sqliteTable("channel_key_attempts", {
  bucket: text("bucket").primaryKey(),
  expires_at: integer("expires_at").notNull(),
  attempts: integer("attempts").notNull().default(0),
});
