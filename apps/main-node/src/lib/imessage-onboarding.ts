import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ChannelOnboarding, type ChannelDeps, type Delivery } from "./channel-onboarding.js";

export interface IMessageDeps extends ChannelDeps {
  apiKeyId: string;
  apiSecretKey: string;
  webhookSecret: string;
  number: string;
  webhookSecretHeader?: string;
}
export function sendblueEnabled(env: Record<string, string | undefined>) {
  return !!(env.SENDBLUE_API_KEY_ID && env.SENDBLUE_API_SECRET_KEY && env.SENDBLUE_WEBHOOK_SECRET &&
    /^\+[1-9]\d{6,14}$/.test(env.SENDBLUE_NUMBER ?? ""));
}
export function plainText(text: string) {
  return text.replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/^#{1,6}\s+/gm, "").replace(/^>\s?/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|[.,!?]|$)/g, "$1$2");
}
interface Inbound {
  message_handle: string;
  from_number: string;
  to_number: string;
  content?: string;
  is_outbound: boolean;
  status: string;
  group_id?: string | null;
  participants?: string[];
  message_type?: string;
  is_reaction?: boolean;
  media_url?: string;
}
const identity = (s: unknown): s is string => typeof s === "string" &&
  (/^\+[1-9]\d{6,14}$/.test(s) || (s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)));

/** Static webhook secret, not an HMAC. Never include provider error bodies in logs. */
export class IMessageOnboarding extends ChannelOnboarding<IMessageDeps> {
  constructor(d: IMessageDeps) {
    super(d, {
      channel: "imessage", label: "iMessage", identityColumn: "sender_id",
      inboxOrder: "received_at,update_id", maxLength: 18996,
      decode: payload => {
        const u = payload as Inbound;
        const text = (u.content ?? "").trim();
        // Normalised to `/start <code>` by the channel core, after credential screening
        // and only when the sender is unlinked or used the explicit prefix.
        const code = text.match(/^(ORRERY )?([A-Za-z0-9_-]{32})$/);
        return { id: u.message_handle, sender: u.from_number, text, ...(code ? { code: code[2], explicitCode: !!code[1] } : {}) };
      },
      link: token => ({ number: d.number, code: `ORRERY ${token}`, url: `sms:${d.number}?&body=${encodeURIComponent(`ORRERY ${token}`)}` }),
      access: (base, sid) => ({ url: new URL(`/sessions/${encodeURIComponent(sid)}#needs-you`, base).toString(), miniApp: false }),
      format: plainText,
      send: row => this.send(row.chat_id, row.text),
      unlinked: sender => this.explainLink(sender),
    });
  }
  private async send(number: string, content: string): Promise<Delivery> {
    const response = await (this.d.fetch ?? fetch)("https://api.sendblue.com/api/send-message", {
      method: "POST",
      headers: { "content-type": "application/json", "sb-api-key-id": this.d.apiKeyId, "sb-api-secret-key": this.d.apiSecretKey },
      body: JSON.stringify({ number, from_number: this.d.number, content }),
      signal: AbortSignal.timeout(15000),
    });
    const result = await response.json() as { status?: string; message_handle?: string; error_code?: number; error_key?: string; error_message?: string; message?: string; opted_out?: boolean };
    // Only contact-specific permanent errors unlink. Auth, line configuration and quota failures do not.
    const permanent = result.opted_out === true || ["OPTED_OUT", "CONTACT_BLOCKED", "CONTACT_NOT_VERIFIED", "RECIPIENT_NOT_VERIFIED", "INVALID_RECIPIENT"].includes(result.error_key ?? "") ||
      (/^(400|403|422)$/.test(String(response.status)) && /(?:contact|recipient).*(?:not verified|blocked|opted out)|cannot message this contact/i.test(result.error_message ?? result.message ?? ""));
    const delivered = response.ok && !!result.message_handle && ["REGISTERED", "PENDING", "QUEUED", "ACCEPTED", "SENT", "DELIVERED"].includes(result.status ?? "");
    const retry = response.headers.get("retry-after");
    const delay = retry ? (/^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 0;
    return { delivered, permanent, ...(Number.isFinite(delay) && delay > 0 ? { retryAfterMs: Math.min(86400000, Math.max(30000, delay)) } : {}) };
  }
  private async explainLink(sender: string) {
    // Persist BEFORE attempting delivery: at most one notice per sender/day and ten/day globally,
    // including crashes and restarts. Hash strangers' identities; do not persist their message text.
    const now = Date.now(), key = createHash("sha256").update(sender).digest("hex");
    await this.d.sql.prepare("DELETE FROM imessage_notices WHERE last_at<?").bind(now - 86400000).run();
    const count = await this.d.sql.prepare("SELECT COUNT(*) AS n FROM imessage_notices").first<{ n: number }>();
    if (Number(count?.n) >= 10) return;
    const inserted = await this.d.sql.prepare("INSERT INTO imessage_notices (sender_hash,last_at) VALUES (?,?) ON CONFLICT (sender_hash) DO NOTHING").bind(key, now).run();
    if (!inserted.meta.changes) return;
    // Notices are deliberately best effort and never retried, to protect the shared-line quota.
    await this.send(sender, "To link your agent, sign in to Orrery and choose Continue in iMessage, then send the code shown there.").catch(() => {});
  }
  webhookRoutes() {
    const app = new Hono();
    app.use("*", bodyLimit({ maxSize: 65536 }));
    app.post("/", async c => {
      const received = createHash("sha256").update(c.req.header(this.d.webhookSecretHeader ?? "sb-signing-secret") ?? "").digest();
      const expected = createHash("sha256").update(this.d.webhookSecret).digest();
      if (!timingSafeEqual(received, expected)) return c.json({ error: "Unauthorized" }, 401);
      // Read outside the JSON catch so Hono can translate streamed BodyLimitError to 413.
      const raw = await c.req.text();
      if (Buffer.byteLength(raw, "utf8") > 65536) return c.json({ error: "Too large" }, 413);
      let u: Inbound;
      try { u = JSON.parse(raw); } catch { return c.json({ error: "Invalid JSON" }, 400); }
      if (!u || typeof u !== "object") return c.json({ error: "Invalid message" }, 400);
      if (u.is_outbound !== false || u.status !== "RECEIVED" || u.to_number !== this.d.number ||
          u.group_id || (Array.isArray(u.participants) && u.participants.length > 2) ||
          u.is_reaction || (u.message_type && u.message_type !== "message")) return c.json({ ok: true });
      if (!identity(u.from_number) || typeof u.message_handle !== "string" || !/^[A-Za-z0-9_.:-]{1,256}$/.test(u.message_handle) ||
          (u.content != null && typeof u.content !== "string")) return c.json({ error: "Invalid message" }, 400);
      // Keep only the fields the inbox needs; never fetch attachment URLs.
      await this.d.sql.prepare("INSERT INTO imessage_inbox (update_id,payload,received_at) VALUES (?,?,?) ON CONFLICT (update_id) DO NOTHING")
        .bind(u.message_handle, await this.inboxPayload({ message_handle: u.message_handle, from_number: u.from_number, content: u.content ?? "" }), Date.now()).run();
      return c.json({ ok: true });
    });
    return app;
  }
}
