import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SessionRouter } from "@open-managed-agents/session-runtime";
import type {
  EnvironmentConfig,
  SessionEvent,
} from "@open-managed-agents/shared";

type Account = {
  tenant_id: string;
  user_id: string;
  agent_id: string | null;
  active_agent_id: string | null;
  chat_id: string | null;
  telegram_user_id: string | null;
  link_hash: string | null;
  link_expires_at: number | null;
};
type Update = {
  update_id: number;
  message: {
    message_id: number;
    text?: string;
    from: { id: number; is_bot?: boolean };
    chat: { id: number; type: string };
  };
};
export interface TelegramDeps {
  sql: SqlClient;
  agents: AgentService;
  sessions: SessionService;
  router: SessionRouter;
  token: string;
  username: string;
  webhookSecret: string;
  model: string;
  harness?: string;
  environmentId?: string;
  defaultEnvironment?: (tenantId: string) => Promise<string | undefined>;
  environment: (
    tenantId: string,
    id: string,
  ) => Promise<EnvironmentConfig | null>;
  hasMembership: (userId: string, tenantId: string) => Promise<boolean>;
  publicBaseUrl?: string;
  requestAccess?: (tenantId: string, sessionId: string, service: string, requestId: string) => Promise<unknown>;
  hasVault?: (tenantId: string, vaultId: string) => Promise<boolean>;
  fetch?: typeof fetch;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const HELP =
  "Send a message to work with your agent.\n/new [task] — set up another agent\n/run — start work with the saved setup\n/connect <app> — connect an app\n/agents — list your agents\n/use <agent ID> — switch agents\n/status — check progress\n/stop — interrupt the current agent\n/unlink — disconnect Telegram";

/** A durable inbox/outbox keeps Telegram delivery independent of browser connections. */
export class TelegramOnboarding {
  private busy = false;
  private provisioning = new Map<string, Promise<Account>>();
  constructor(private d: TelegramDeps) {}
  private async account(tenant: string, user: string) {
    return this.d.sql
      .prepare(
        "SELECT * FROM telegram_accounts WHERE tenant_id = ? AND user_id = ?",
      )
      .bind(tenant, user)
      .first<Account>();
  }
  async ensure(tenant: string, user: string): Promise<Account> {
    const key = `${tenant}:${user}`;
    const pending = this.provisioning.get(key);
    if (pending) return pending;
    const promise = this.provision(tenant, user).finally(() =>
      this.provisioning.delete(key),
    );
    this.provisioning.set(key, promise);
    return promise;
  }
  private async provision(tenant: string, user: string) {
    await this.d.sql
      .prepare(
        "INSERT INTO telegram_accounts (tenant_id,user_id) VALUES (?,?) ON CONFLICT (tenant_id,user_id) DO NOTHING",
      )
      .bind(tenant, user)
      .run();
    let a = (await this.account(tenant, user))!;
    if (!a.agent_id) {
      const agent = await this.createAgent(
        a,
        "Your assistant",
        "Help the user accomplish tasks. They communicate through Telegram. Keep replies concise. Use the available tools to do the work. Never claim actions you have not performed.",
        `onboarding:${user}`,
      );
      await this.d.sql
        .prepare(
          "UPDATE telegram_accounts SET agent_id = ?, active_agent_id = ? WHERE tenant_id = ? AND user_id = ? AND agent_id IS NULL",
        )
        .bind(agent.id, agent.id, tenant, user)
        .run();
      a = (await this.account(tenant, user))!;
    }
    return a;
  }
  private async createAgent(
    a: Account,
    name: string,
    task: string,
    key: string,
  ) {
    // Recovery after a crash between agent creation and saving the binding.
    const rows = await this.d.sql
      .prepare("SELECT config FROM agents WHERE tenant_id = ?")
      .bind(a.tenant_id)
      .all<{ config: string }>();
    for (const row of rows.results ?? []) {
      const c = JSON.parse(row.config);
      if (c.metadata?.telegram_creation_key === key) return c;
    }
    const environmentId =
      this.d.environmentId ?? (await this.d.defaultEnvironment?.(a.tenant_id));
    return this.d.agents.create({
      tenantId: a.tenant_id,
      input: {
        name,
        system: task,
        model: this.d.model,
        harness: this.d.harness,
        tools: [
          { type: "agent_toolset_20260401", default_config: { enabled: true } },
        ],
        metadata: {
          telegram_owner: a.user_id,
          telegram_creation_key: key,
          ...(environmentId ? { default_environment_id: environmentId } : {}),
        },
      },
    });
  }
  async status(tenant: string, user: string) {
    const a = await this.account(tenant, user);
    return {
      enabled: true,
      connected: !!a?.chat_id,
      agent_id: a?.agent_id ?? null,
    };
  }
  async link(tenant: string, user: string) {
    const a = await this.ensure(tenant, user);
    if (a.chat_id) {
      await this.welcome(a);
      return { connected: true, agent_id: a.agent_id };
    }
    const token = randomBytes(24).toString("base64url");
    await this.d.sql
      .prepare(
        "UPDATE telegram_accounts SET link_hash = ?, link_expires_at = ? WHERE tenant_id = ? AND user_id = ?",
      )
      .bind(hash(token), Date.now() + 600000, tenant, user)
      .run();
    return {
      connected: false,
      agent_id: a.agent_id,
      url: `https://t.me/${this.d.username}?start=${token}`,
      expires_in: 600,
    };
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
        .bind(String(u.update_id), raw)
        .run();
      return c.json({ ok: true });
    });
    return app;
  }
  routes() {
    const app = new Hono<{
      Variables: { tenant_id: string; user_id?: string };
    }>();
    app.get("/status", async (c) =>
      c.var.user_id
        ? c.json(await this.status(c.var.tenant_id, c.var.user_id))
        : c.json({ error: "User identity required" }, 403),
    );
    app.post("/connect", async (c) =>
      c.var.user_id
        ? c.json(await this.link(c.var.tenant_id, c.var.user_id))
        : c.json({ error: "User identity required" }, 403),
    );
    app.delete("/connection", async (c) => {
      if (!c.var.user_id)
        return c.json({ error: "User identity required" }, 403);
      await this.unlink(c.var.tenant_id, c.var.user_id);
      return c.json({ connected: false });
    });
    app.get("/conversations/:sid/access/:request", async c => {
      const binding = await this.ownedConversation(c.var.tenant_id, c.var.user_id, c.req.param("sid"));
      if (!binding) return c.json({ error: "Connection request not found" }, 404);
      const events = await this.d.router.getEvents(binding.session_id, { limit: 10000 });
      const event = events.data.find(e => e.type === "system.access_request" && (e as unknown as { request_id?: string }).request_id === c.req.param("request"));
      if (!event) return c.json({ error: "Connection request not found" }, 404);
      const agent = await this.d.agents.get({ tenantId: c.var.tenant_id, agentId: binding.agent_id });
      return c.json({ event, agent_id: binding.agent_id, vault_ids: agent?.metadata?.default_vault_ids ?? [] });
    });
    app.post("/conversations/:sid/vault", async c => {
      const binding = await this.ownedConversation(c.var.tenant_id, c.var.user_id, c.req.param("sid"));
      if (!binding) return c.json({ error: "Conversation not found" }, 404);
      const body = await c.req.json<{ vault_id?: string }>().catch(() => ({} as { vault_id?: string }));
      if (!body.vault_id || !await this.d.hasVault?.(c.var.tenant_id, body.vault_id)) return c.json({ error: "Vault not found" }, 404);
      const agent = await this.d.agents.get({ tenantId: c.var.tenant_id, agentId: binding.agent_id });
      if (!agent) return c.json({ error: "Agent not found" }, 404);
      const old = Array.isArray(agent.metadata?.default_vault_ids) ? agent.metadata.default_vault_ids as string[] : [];
      await this.d.agents.update({ tenantId: c.var.tenant_id, agentId: agent.id, input: { metadata: { default_vault_ids: [...new Set([...old, body.vault_id])] } } });
      return c.json({ attached: true });
    });
    return app;
  }
  private async ownedConversation(tenant: string, user: string | undefined, sid: string) {
    if (!user || !await this.d.hasMembership(user, tenant)) return null;
    return this.d.sql.prepare("SELECT c.session_id,c.agent_id FROM telegram_conversations c JOIN telegram_accounts a ON a.tenant_id=c.tenant_id AND a.user_id=c.user_id WHERE c.tenant_id=? AND c.user_id=? AND c.session_id=? AND a.chat_id IS NOT NULL").bind(tenant, user, sid).first<{ session_id: string; agent_id: string }>();
  }
  private async unlink(tenant: string, user: string) {
    await this.d.sql
      .prepare(
        "UPDATE telegram_accounts SET chat_id=NULL,telegram_user_id=NULL,link_hash=NULL,link_expires_at=NULL WHERE tenant_id=? AND user_id=?",
      )
      .bind(tenant, user)
      .run();
  }
  private async queue(a: Account, id: string, text: string, button?: { text: string; url: string }) {
    if (!a.chat_id) return;
    const parts = text.match(/[\s\S]{1,3800}/gu) ?? [""];
    await this.d.sql.batch(
      parts.map((text, i) =>
        this.d.sql
          .prepare(
            "INSERT INTO telegram_outbox (id,tenant_id,user_id,chat_id,text,reply_markup) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING",
          )
          .bind(`${id}:${i}`, a.tenant_id, a.user_id, a.chat_id, text, i === 0 && button ? JSON.stringify({ inline_keyboard: [[button]] }) : null),
      ),
    );
  }
  private async conversation(a: Account, mode: "setup" | "work" = "work", transitionId?: string) {
    const agentId = a.active_agent_id!;
    const existing = await this.d.sql
      .prepare(
        "SELECT session_id,transition_id FROM telegram_conversations WHERE tenant_id=? AND user_id=? AND agent_id=?",
      )
      .bind(a.tenant_id, a.user_id, agentId)
      .first<{ session_id: string; transition_id: string | null }>();
    if (existing && (!transitionId || existing.transition_id === transitionId)) return existing.session_id;
    const agent = await this.d.agents.get({ tenantId: a.tenant_id, agentId });
    if (!agent) throw new Error("Agent unavailable");
    const envId = String(agent.metadata?.default_environment_id ?? "");
    const env = envId ? await this.d.environment(a.tenant_id, envId) : null;
    if (envId && !env) throw new Error("Agent environment unavailable");
    const { session } = await this.d.sessions.create({
      tenantId: a.tenant_id,
      agentId,
      environmentId: envId,
      title: `Telegram · ${agent.name}`,
      agentSnapshot: agent,
      ...(env ? { environmentSnapshot: env } : {}),
      vaultIds: Array.isArray(agent.metadata?.default_vault_ids) ? agent.metadata.default_vault_ids as string[] : [],
      metadata: { telegram_user: a.user_id, ...(mode === "setup" ? { oma_setup: true } : {}) },
    });
    await this.d.sql
      .prepare(
        "INSERT INTO telegram_conversations (session_id,tenant_id,user_id,agent_id,mode,transition_id) VALUES (?,?,?,?,?,?) ON CONFLICT (tenant_id,user_id,agent_id) DO UPDATE SET session_id=excluded.session_id,mode=excluded.mode,transition_id=excluded.transition_id,last_seq=-1",
      )
      .bind(session.id, a.tenant_id, a.user_id, agentId, mode, transitionId ?? null)
      .run();
    return session.id;
  }
  private async process(u: Update) {
    const text = (u.message.text?.trim() ?? "").replace(new RegExp(`^(/\\w+)@${this.d.username}(?=\\s|$)`, "i"), "$1");
    const chat = String(u.message.chat.id),
      user = String(u.message.from.id);
    let a = await this.d.sql
      .prepare(
        "SELECT * FROM telegram_accounts WHERE chat_id=? AND telegram_user_id=?",
      )
      .bind(chat, user)
      .first<Account>();
    const start = text.match(/^\/start(?:@\w+)? ([A-Za-z0-9_-]{32})$/);
    if (start && !a) {
      a = await this.d.sql
        .prepare(
          "SELECT * FROM telegram_accounts WHERE link_hash=? AND link_expires_at>? AND chat_id IS NULL",
        )
        .bind(hash(start[1]), Date.now())
        .first<Account>();
      if (a && (await this.d.hasMembership(a.user_id, a.tenant_id))) {
        const result = await this.d.sql
          .prepare(
            "UPDATE telegram_accounts SET chat_id=?,telegram_user_id=?,link_hash=NULL,link_expires_at=NULL WHERE tenant_id=? AND user_id=? AND link_hash=? AND chat_id IS NULL",
          )
          .bind(chat, user, a.tenant_id, a.user_id, hash(start[1]))
          .run();
        if (!result.meta.changes) return;
        a = { ...a, chat_id: chat, telegram_user_id: user };
      } else return;
    }
    if (!a || !(await this.d.hasMembership(a.user_id, a.tenant_id))) return;
    const id = `update:${String(u.update_id).padStart(16, "0")}`;
    if (text.startsWith("/start")) {
      await this.queue(
        a,
        id,
        "Your agent is ready. Starting your conversation.\n\n" + HELP,
      );
      return this.welcome(a);
    }
    if (text === "/help") return this.queue(a, id, HELP);
    if (text === "/unlink") {
      await this.unlink(a.tenant_id, a.user_id);
      return;
    }
    if (text === "/agents") {
      const rows = await this.d.sql
        .prepare(
          "SELECT config FROM agents WHERE tenant_id=? AND archived_at IS NULL",
        )
        .bind(a.tenant_id)
        .all<{ config: string }>();
      const agents = (rows.results ?? [])
        .map((r) => JSON.parse(r.config))
        .filter((c) => c.metadata?.telegram_owner === a!.user_id);
      return this.queue(
        a,
        id,
        agents
          .map(
            (c) =>
              `${c.name}: ${c.id}${c.id === a!.active_agent_id ? " (active)" : ""}`,
          )
          .join("\n"),
      );
    }
    if (/^\/new(?:\s|$)/.test(text)) {
      const task = text.slice(4).trim();
      const agent = await this.createAgent(
        a,
        task.slice(0, 70) || "New agent",
        task || "Help the user define this agent’s purpose during setup.",
        `${a.user_id}:${u.update_id}`,
      );
      await this.d.sql
        .prepare(
          "UPDATE telegram_accounts SET active_agent_id=? WHERE tenant_id=? AND user_id=?",
        )
        .bind(agent.id, a.tenant_id, a.user_id)
        .run();
      a = { ...a, active_agent_id: agent.id };
      await this.conversation(a, "setup");
      await this.queue(a, id, `Created ${agent.name}. Let's set it up. Describe what it should do; use /run when the configuration is ready.`);
      return this.message(a, id, `We are setting up this agent through Telegram. ${task ? `My initial task is: ${task}.` : "Ask me what I want this agent to do."} Use the same setup tools as Orrery to refine your saved configuration. Ask one focused question at a time. Use request_access for integrations; the platform sends a connection button. Never ask for credentials in chat. Explain /run when ready; do not begin the actual work during setup.`);
    }
    if (text === "/run") {
      const current = await this.conversation(a);
      const transition = await this.d.sql.prepare("SELECT transition_id FROM telegram_conversations WHERE session_id=?").bind(current).first<{ transition_id: string | null }>();
      const startText = "Begin the task in your saved instructions. If essential information or authorization is missing, ask before proceeding.";
      if (transition?.transition_id === id) return this.message(a, id, startText);
      const row = await this.d.sessions.get({ tenantId: a.tenant_id, sessionId: current });
      if (row?.status === "running" || row?.status === "rescheduling") return this.queue(a, id, "The agent is still replying. Wait for it to finish, then send /run.");
      await this.conversation(a, "work", id);
      await this.queue(a, id, "Starting work with your saved configuration and selected vaults.");
      return this.message(a, id, startText);
    }
    if (/^\/connect(?:\s|$)/.test(text)) {
      const service = text.slice(8).trim().toLowerCase();
      if (!/^[a-z0-9_-]{1,80}$/.test(service)) return this.queue(a, id, "Use /connect followed by an app, for example /connect linear or /connect gmail.");
      if (!this.d.requestAccess) return this.queue(a, id, "App connections are not configured on this deployment.");
      const sid = await this.conversation(a);
      const prior = await this.d.router.getEvents(sid, { limit: 10000 });
      const requestId = `acreq-telegram-${u.update_id}`;
      if (!prior.data.some(e => (e as unknown as { request_id?: string }).request_id === requestId)) {
        await this.d.requestAccess(a.tenant_id, sid, service, requestId);
      }
      return;
    }
    if (text.startsWith("/use ")) {
      const agent = await this.d.agents
        .get({ tenantId: a.tenant_id, agentId: text.slice(5).trim() })
        .catch(() => null);
      if (
        !agent ||
        agent.metadata?.telegram_owner !== a.user_id ||
        agent.archived_at
      )
        return this.queue(
          a,
          id,
          "That agent is not available in your Telegram account.",
        );
      await this.d.sql
        .prepare(
          "UPDATE telegram_accounts SET active_agent_id=? WHERE tenant_id=? AND user_id=?",
        )
        .bind(agent.id, a.tenant_id, a.user_id)
        .run();
      return this.queue(a, id, `Now talking to ${agent.name}.`);
    }
    if (text === "/stop") {
      const sid = await this.conversation(a);
      await this.d.router.appendEvent(sid, {
        type: "user.interrupt",
      } as SessionEvent);
      return this.queue(a, id, "Stop requested for the current agent.");
    }
    if (text === "/status") {
      const sid = await this.conversation(a);
      const state = await this.d.sessions.get({
        tenantId: a.tenant_id,
        sessionId: sid,
      });
      return this.queue(
        a,
        id,
        `Agent ${a.active_agent_id}: ${state?.status ?? "unknown"}`,
      );
    }
    if (text.startsWith("/")) return this.queue(a, id, HELP);
    if (!text)
      return this.queue(
        a,
        id,
        "Please send a text message. Attachments are not supported yet.",
      );
    return this.message(a, id, text);
  }
  private async welcome(a: Account) {
    // Stable event ID makes reconnection/retries safe and lets an existing
    // connection resume onboarding after deployment without creating a second turn.
    await this.message(
      { ...a, active_agent_id: a.agent_id },
      `telegram-welcome:${a.user_id}`,
      "The user just connected their Telegram account. Briefly introduce yourself as their cloud agent and ask what they want to accomplish. Mention that /new starts a guided agent setup and /run starts work after setup. Do not perform unrelated work or ask them to use the web UI.",
    );
  }
  private async message(a: Account, id: string, text: string) {
    const sid = await this.conversation(a);
    const events = await this.d.router.getEvents(sid, { limit: 10000 });
    if (events.data.some((e) => (e as unknown as { id?: string }).id === id))
      return;
    await this.d.router.appendEvent(sid, {
      type: "user.message",
      id,
      content: [{ type: "text", text }],
    } as SessionEvent);
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const inbox = await this.d.sql
        .prepare(
          "SELECT update_id,payload FROM telegram_inbox WHERE done=0 AND next_at<=? ORDER BY CAST(update_id AS BIGINT) LIMIT 20",
        )
        .bind(Date.now())
        .all<{ update_id: string; payload: string }>();
      for (const row of inbox.results ?? []) {
        try {
          await this.process(JSON.parse(row.payload));
          await this.d.sql
            .prepare(
              "UPDATE telegram_inbox SET done=1,payload='{}' WHERE update_id=?",
            )
            .bind(row.update_id)
            .run();
        } catch {
          await this.d.sql
            .prepare(
              "UPDATE telegram_inbox SET attempts=attempts+1,next_at=? WHERE update_id=?",
            )
            .bind(Date.now() + 30000, row.update_id)
            .run();
        }
      }
      const conversations = await this.d.sql
        .prepare(
          "SELECT c.*, a.chat_id,a.telegram_user_id FROM telegram_conversations c JOIN telegram_accounts a ON a.tenant_id=c.tenant_id AND a.user_id=c.user_id WHERE a.chat_id IS NOT NULL",
        )
        .all<Account & { session_id: string; last_seq: number }>();
      for (const c of conversations.results ?? []) {
        if (!(await this.d.hasMembership(c.user_id, c.tenant_id))) continue;
        const page = await this.d.router.getEvents(c.session_id, {
          afterSeq: Number(c.last_seq),
          limit: 100,
        });
        for (const e of page.data) {
          const event = e as unknown as {
            type: string;
            seq: number;
            content?: Array<{ type: string; text?: string }>;
            error?: string;
            message?: string;
          };
          if (event.type === "system.access_request" && this.d.publicBaseUrl) {
            const request = e as unknown as { request_id: string; service: string; reason?: string };
            const url = new URL(`/telegram/connect/${encodeURIComponent(c.session_id)}/${encodeURIComponent(request.request_id)}`, this.d.publicBaseUrl).toString();
            await this.queue(c, `event:${c.session_id}:${String(event.seq).padStart(16, "0")}`, `Connect ${request.service}${request.reason ? `: ${request.reason}` : ""}. Choose your vault and authorize in the secure page. Then return here.`, { text: `Connect ${request.service}`, url });
          } else if (event.type === "agent.message") {
            const text = Array.isArray(event.content)
              ? event.content
                  .filter((b) => b.type === "text")
                  .map((b) => b.text)
                  .join("\n")
              : "";
            if (text)
              await this.queue(
                c,
                `event:${c.session_id}:${String(event.seq).padStart(16, "0")}`,
                text,
              );
          } else if (event.type === "session.error")
            await this.queue(
              c,
              `event:${c.session_id}:${String(event.seq).padStart(16, "0")}`,
              /total disk limit exceeded/i.test(event.message ?? event.error ?? "")
                ? "Cloud storage is full, so the computer could not start. Your agent configuration is saved. Free or archive an unused computer, or increase the Daytona storage limit, then retry /run."
                : "The agent encountered an error. Check /status or retry your request.",
            );
          await this.d.sql
            .prepare(
              "UPDATE telegram_conversations SET last_seq=? WHERE session_id=?",
            )
            .bind(event.seq, c.session_id)
            .run();
        }
      }
      const outbox = await this.d.sql
        .prepare(
          "SELECT * FROM telegram_outbox WHERE sent=0 AND next_at<=? ORDER BY id LIMIT 20",
        )
        .bind(Date.now())
        .all<{
          id: string;
          tenant_id: string;
          user_id: string;
          chat_id: string;
          text: string;
          reply_markup: string | null;
        }>();
      for (const row of outbox.results ?? []) {
        const a = await this.account(row.tenant_id, row.user_id);
        if (
          a?.chat_id !== row.chat_id ||
          !(await this.d.hasMembership(row.user_id, row.tenant_id))
        ) {
          await this.d.sql
            .prepare("UPDATE telegram_outbox SET sent=1,text='',reply_markup=NULL WHERE id=?")
            .bind(row.id)
            .run();
          continue;
        }
        try {
          const r = await (this.d.fetch ?? fetch)(
            `https://api.telegram.org/bot${this.d.token}/sendMessage`,
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ chat_id: row.chat_id, text: row.text, ...(row.reply_markup ? { reply_markup: JSON.parse(row.reply_markup) } : {}) }),
              signal: AbortSignal.timeout(15000),
            },
          );
          const result = (await r.json()) as {
            ok: boolean;
            error_code?: number;
            parameters?: { retry_after?: number };
          };
          if (!r.ok || !result.ok) {
            if (result.error_code === 403)
              await this.unlink(row.tenant_id, row.user_id);
            throw new Error("Telegram delivery failed");
          }
          await this.d.sql
            .prepare("UPDATE telegram_outbox SET sent=1,text='',reply_markup=NULL WHERE id=?")
            .bind(row.id)
            .run();
        } catch {
          await this.d.sql
            .prepare(
              "UPDATE telegram_outbox SET attempts=attempts+1,next_at=? WHERE id=?",
            )
            .bind(Date.now() + 30000, row.id)
            .run();
        }
      }
    } finally {
      this.busy = false;
    }
  }
}
