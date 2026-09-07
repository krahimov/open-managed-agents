import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  unique,
} from "drizzle-orm/sqlite-core";

export const telegram_accounts = sqliteTable(
  "telegram_accounts",
  {
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id"),
    active_agent_id: text("active_agent_id"),
    chat_id: text("chat_id").unique(),
    telegram_user_id: text("telegram_user_id"),
    link_hash: text("link_hash").unique(),
    link_expires_at: integer("link_expires_at"),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.user_id] })],
);
export const telegram_conversations = sqliteTable(
  "telegram_conversations",
  {
    session_id: text("session_id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    last_seq: integer("last_seq").notNull().default(-1),
  },
  (t) => [unique().on(t.tenant_id, t.user_id, t.agent_id)],
);
export const telegram_inbox = sqliteTable("telegram_inbox", {
  update_id: text("update_id").primaryKey(),
  payload: text("payload").notNull(),
  done: integer("done").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: integer("next_at").notNull().default(0),
});
export const telegram_outbox = sqliteTable("telegram_outbox", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  chat_id: text("chat_id").notNull(),
  text: text("text").notNull(),
  sent: integer("sent").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: integer("next_at").notNull().default(0),
});
