import { createHmac, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ChannelOnboarding, type ChannelDeps, type Account } from "./channel-onboarding.js";
export interface TelegramDeps extends ChannelDeps { token: string; username: string; webhookSecret: string }
type Update = {
  update_id: number;
  message: {
    message_id: number;
    text?: string;
    from: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
  };
};
/** Only signed Mini App launch data authenticates the linked Telegram user. */
export function verifyTelegramInitData(raw: string, token: string, now = Date.now()): string | null {
  if (!raw || raw.length > 16384) return null;
  const data = new URLSearchParams(raw);
  const keys = [...data.keys()];
  if (new Set(keys).size !== keys.length) return null;
  const signature = data.get("hash") ?? "";
  if (!/^[a-f0-9]{64}$/.test(signature)) return null;
  data.delete("hash");
  const check = [...data.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expected = createHmac("sha256", secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, "hex"))) return null;
  const date = Number(data.get("auth_date"));
  if (!data.has("auth_date") || !Number.isSafeInteger(date) || date <= 0 || date * 1000 > now + 30000 || now - date * 1000 > 900000) return null;
  try {
    const user = JSON.parse(data.get("user") ?? "null");
    return user && Number.isSafeInteger(user.id) && user.id > 0 && !user.is_bot ? String(user.id) : null;
  } catch { return null; }
}
/** The only fields processing needs. Captions, quoted replies, entities, media and
 *  everything else in the update are never persisted. Older inbox rows that hold the
 *  full update still decode, since these are the same paths. */
export function minimalUpdate(u: Update): Update {
  const m = u?.message;
  if (!m?.from || !m.chat) return u;
  return {
    update_id: u.update_id,
    message: {
      message_id: m.message_id,
      ...(typeof m.text === "string" ? { text: m.text } : {}),
      from: { id: m.from.id, ...(typeof m.from.is_bot === "boolean" ? { is_bot: m.from.is_bot } : {}) },
      chat: { id: m.chat.id, type: m.chat.type },
    },
  };
}
export class TelegramOnboarding extends ChannelOnboarding<TelegramDeps> {
  constructor(d: TelegramDeps) {
    super(d, {
      channel: "telegram", label: "Telegram", identityColumn: "telegram_user_id",
      inboxOrder: "CAST(update_id AS BIGINT)", maxLength: 3800,
      decode: payload => {
        const u = payload as Update;
        return { id: u.update_id, sender: String(u.message.from.id), text: (u.message.text ?? "").trim().replace(new RegExp(`^(/\\w+)@${d.username}(?=\\s|$)`, "i"), "$1") };
      },
      link: token => ({ url: `https://t.me/${d.username}?start=${token}` }),
      access: (base, sid, request) => ({ url: new URL(`/telegram/connect/${encodeURIComponent(sid)}/${encodeURIComponent(request)}`, base).toString(), miniApp: true }),
      urlButtons: true,
      minimize: payload => minimalUpdate(payload as Update),
      send: async row => {
        const r = await (d.fetch ?? fetch)(`https://api.telegram.org/bot${d.token}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: row.chat_id, text: row.text, ...(row.reply_markup ? { reply_markup: JSON.parse(row.reply_markup) } : {}) }),
          signal: AbortSignal.timeout(15000),
        });
        const result = await r.json() as { ok: boolean; error_code?: number };
        return { delivered: r.ok && result.ok, permanent: result.error_code === 403 };
      },
    });
  }
  private validSecret(s: string) {
    const expected = Buffer.from(this.d.webhookSecret),
      received = Buffer.from(s);
    return (
      expected.length === received.length && timingSafeEqual(expected, received)
    );
  }
  webhookRoutes() {
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 65536 }));
    app.post("/", async (c) => {
      if (
        !this.validSecret(c.req.header("x-telegram-bot-api-secret-token") ?? "")
      )
        return c.json({ error: "Unauthorized" }, 401);
      const raw = await c.req.text();
      if (raw.length > 65536) return c.json({ error: "Too large" }, 413);
      let u: Update;
      try {
        u = JSON.parse(raw);
      } catch {
        return c.json({ error: "Invalid JSON" }, 400);
      }
      if (!Number.isSafeInteger(u.update_id))
        return c.json({ error: "Invalid update" }, 400);
      // Only the account owner in a private chat; ignore groups, channels, bots and edited messages.
      if (
        u.message?.chat?.type !== "private" ||
        !Number.isSafeInteger(u.message.from?.id) ||
        u.message.from.is_bot ||
        u.message.chat.id !== u.message.from.id
      )
        return c.json({ ok: true });
      await this.d.sql
        .prepare(
          "INSERT INTO telegram_inbox (update_id,payload) VALUES (?,?) ON CONFLICT (update_id) DO NOTHING",
        )
        .bind(String(u.update_id), await this.inboxPayload(minimalUpdate(u)))
        .run();
      return c.json({ ok: true });
    });
    return app;
  }
  async miniAppConnection(initData: string, sid: string, requestId: string) {
    const telegramId = verifyTelegramInitData(initData, this.d.token);
    if (!telegramId) return null;
    const account = await this.d.sql.prepare("SELECT a.* FROM telegram_accounts a JOIN (SELECT session_id,tenant_id,user_id FROM channel_conversations UNION ALL SELECT session_id,tenant_id,user_id FROM channel_conversation_drains) c ON c.tenant_id=a.tenant_id AND c.user_id=a.user_id WHERE c.session_id=? AND a.telegram_user_id=? AND a.chat_id=?").bind(sid, telegramId, telegramId).first<Account>();
    if (!account || !await this.ownedConversation(account.tenant_id, account.user_id, sid)) return null;
    const events = await this.d.router.getEvents(sid, { limit: 10000 });
    const event = events.data.find(e => e.type === "system.access_request" && (e as unknown as { request_id?: string }).request_id === requestId);
    if (!event) return null;
    const binding = await this.ownedConversation(account.tenant_id, account.user_id, sid);
    const agent = binding && await this.d.agents.get({ tenantId: account.tenant_id, agentId: binding.agent_id });
    if (!agent || agent.archived_at) return null;
    return { tenantId: account.tenant_id, userId: account.user_id, agent, event };
  }
}
