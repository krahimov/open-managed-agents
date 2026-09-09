import {
  pgTable,
  text,
  integer,
  bigint,
  primaryKey,
  unique,
} from "drizzle-orm/pg-core";

export const telegram_accounts = pgTable(
  "telegram_accounts",
  {
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id"),
    active_agent_id: text("active_agent_id"),
    chat_id: text("chat_id").unique(),
    telegram_user_id: text("telegram_user_id"),
    link_hash: text("link_hash").unique(),
    link_expires_at: bigint("link_expires_at", { mode: "number" }),
  },
  (t) => [primaryKey({ columns: [t.tenant_id, t.user_id] })],
);
export const telegram_conversations = pgTable(
  "telegram_conversations",
  {
    session_id: text("session_id").primaryKey(),
    tenant_id: text("tenant_id").notNull(),
    user_id: text("user_id").notNull(),
    agent_id: text("agent_id").notNull(),
    mode: text("mode").notNull().default("work"),
    transition_id: text("transition_id"),
    last_seq: bigint("last_seq", { mode: "number" }).notNull().default(-1),
  },
  (t) => [unique().on(t.tenant_id, t.user_id, t.agent_id)],
);
export const telegram_inbox = pgTable("telegram_inbox", {
  update_id: text("update_id").primaryKey(),
  payload: text("payload").notNull(),
  done: integer("done").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: bigint("next_at", { mode: "number" }).notNull().default(0),
});
export const telegram_outbox = pgTable("telegram_outbox", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  chat_id: text("chat_id").notNull(),
  text: text("text").notNull(),
  reply_markup: text("reply_markup"),
  sent: integer("sent").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: bigint("next_at", { mode: "number" }).notNull().default(0),
});
