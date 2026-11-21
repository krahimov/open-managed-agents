import { pgTable, text, integer, bigint, primaryKey } from "drizzle-orm/pg-core";

export const channel_conversations = pgTable("channel_conversations", {
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  agent_id: text("agent_id").notNull(),
  session_id: text("session_id").notNull().unique(),
  mode: text("mode").notNull().default("work"),
  transition_id: text("transition_id"),
  last_seq: bigint("last_seq", { mode: "number" }).notNull().default(-1),
  reply_channel: text("reply_channel").notNull(),
}, (t) => [primaryKey({ columns: [t.tenant_id, t.user_id, t.agent_id] })]);

export const channel_conversation_drains = pgTable("channel_conversation_drains", {
  session_id: text("session_id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  agent_id: text("agent_id").notNull(),
  last_seq: bigint("last_seq", { mode: "number" }).notNull().default(-1),
});

export const channel_deliveries = pgTable("channel_deliveries", {
  id: text("id").primaryKey(),
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  agent_id: text("agent_id").notNull(),
  session_id: text("session_id").notNull(),
  event: text("event"),
  text: text("text"),
  reply_markup: text("reply_markup"),
  delivered_chars: bigint("delivered_chars", { mode: "number" }).notNull().default(0),
  sent: integer("sent").notNull().default(0),
  attempts: integer("attempts").notNull().default(0),
  next_at: bigint("next_at", { mode: "number" }).notNull().default(0),
});

export const channel_agent_lists = pgTable("channel_agent_lists", {
  tenant_id: text("tenant_id").notNull(),
  user_id: text("user_id").notNull(),
  channel: text("channel").notNull(),
  agent_ids: text("agent_ids").notNull(),
}, (t) => [primaryKey({ columns: [t.tenant_id, t.user_id, t.channel] })]);

