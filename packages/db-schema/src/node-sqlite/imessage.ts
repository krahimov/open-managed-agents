import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  unique,
} from "drizzle-orm/sqlite-core";

export const imessage_accounts = sqliteTable(
  "imessage_accounts",
  {
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id"),
    active_agent_id: text("active_agent_id"),
    chat_id: text("chat_id").unique(),
    sender_id: text("sender_id"),
    link_hash: text("link_hash").unique(),
    link_expires_at: integer("link_expires_at"),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.user_id] })],
);
export const imessage_conversations = sqliteTable(
  "imessage_conversations",
  {
    session_id: text("session_id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    mode: text("mode").notNull().default("work"),
    transition_id: text("transition_id"),
    last_seq: integer("last_seq").notNull().default(-1),
  },
  (t) => [unique().on(t.tenant_id, t.user_id, t.agent_id)],
);
export const imessage_inbox = sqliteTable("imessage_inbox", {
  update_id: text("update_id").primaryKey(),
  payload: text("payload").notNull(),
  received_at: integer("received_at").notNull().default(0),
  done: integer("done").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: integer("next_at").notNull().default(0),
});
export const imessage_outbox = sqliteTable("imessage_outbox", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  chat_id: text("chat_id").notNull(),
  text: text("text").notNull(),
  reply_markup: text("reply_markup"),
  sent: integer("sent").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: integer("next_at").notNull().default(0),
});

export const imessage_notices = sqliteTable("imessage_notices", {
  sender_hash: text("sender_hash").primaryKey(),
  last_at: integer("last_at").notNull(),
});
