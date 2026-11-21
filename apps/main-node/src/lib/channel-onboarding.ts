import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import type { SqlClient } from "@open-managed-agents/sql-client";
import type { AgentService } from "@open-managed-agents/agents-store";
import type { SessionService } from "@open-managed-agents/sessions-store";
import type { SessionRouter } from "@open-managed-agents/session-runtime";
import type {
  EnvironmentConfig,
  SessionEvent,
} from "@open-managed-agents/shared";
import type { KeyLinkIssuer } from "./channel-key-links.js";
import { credentialRejectedText, knownCredentialFormat, looksLikeCredential } from "./chat-credential-detector.js";

export type Account = {
  tenant_id: string;
  user_id: string;
  agent_id: string | null;
  active_agent_id: string | null;
  chat_id: string | null;
  sender_id?: string | null;
  telegram_user_id?: string | null;
  link_hash: string | null;
  link_expires_at: number | null;
};
export interface ChannelDeps {
  sql: SqlClient;
  agents: AgentService;
  sessions: SessionService;
  router: SessionRouter;
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
  /** Attach the agent's own memory store to a new working conversation. Must not throw. */
  attachAgentMemory?: (input: import("./agent-memory-mode.js").AttachAgentMemoryInput) => Promise<void>;
  /** Before the snapshot is pinned: the sessions route's vault steps
   *  (Composio router repair, vault-contributed MCP servers). */
  prepareAgentSnapshot?: <A extends Record<string, unknown>>(tenantId: string, vaultIds: string[], agent: A) => Promise<A>;
  /** One-time API-key pages for `mcp_api_key` access requests (channel-key-links.ts). */
  keyLinks?: KeyLinkIssuer;
  fetch?: typeof fetch;
}

export interface ChannelMessage {
  id: string | number;
  sender: string;
  text: string;
  /** Text was withheld: it looked like a credential. */
  credential?: boolean;
  /** The adapter saw a possible link code (iMessage `ORRERY <code>` or a bare code). */
  code?: string;
  /** The code carried its explicit `ORRERY` prefix. */
  explicitCode?: boolean;
  /** Withheld: a link-code-shaped message from an unlinked sender that matches no live code. */
  failedLink?: boolean;
  /** Withheld: a link-code-shaped message from an already linked sender. */
  codeShaped?: boolean;
}
export interface Delivery { delivered: boolean; permanent?: boolean; retryAfterMs?: number }
export interface ChannelTransport {
  channel: "telegram" | "imessage";
  label: string;
  identityColumn: "telegram_user_id" | "sender_id";
  inboxOrder: "CAST(update_id AS BIGINT)" | "received_at,update_id";
  maxLength: number;
  decode(payload: unknown): ChannelMessage;
  link(token: string): { url: string; number?: string; code?: string };
  send(row: { chat_id: string; text: string; reply_markup: string | null }): Promise<Delivery>;
  format?(text: string): string;
  access(base: string, session: string, request: string): { url: string; miniApp: boolean };
  /** Send secure links as URL buttons (Telegram) instead of inline text (iMessage). */
  urlButtons?: boolean;
  unlinked?(sender: string): Promise<void>;
  /** The minimal stored shape of an inbox payload; applied to older full-payload rows. */
  minimize?(payload: unknown): unknown;
}
// One process owns channel work. Serialize across adapters (and replacement instances),
// including provisioning/session transitions and sends. Durable SQL handles restart recovery.
let channelWork: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
  const next = channelWork.then(work, work);
  channelWork = next.catch(() => {});
  return next;
}
type Conversation = { tenant_id: string; user_id: string; agent_id: string; session_id: string; last_seq: number; reply_channel: string };
type AgentChoice = { id: string; name: string };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
/** Durable inbox marker that replaces a payload whose text looked like a credential. */
const WITHHELD = "oma_withheld_credential";
/** Synthetic channel_deliveries event: guidance after withheld credential text. */
const CREDENTIAL_NOTICE = "channel.credential_withheld";
/** Reply to a linked sender's link-code-shaped message: it cannot be told apart from a key. */
const ALREADY_LINKED = "This account is already linked, so that message was not sent to your agent. If it was a key rather than a linking code, rotate (revoke and replace) that key.";
const help = (label: string) =>
  `Send a message to work with your agent.\n/new [task] — set up another agent\n/run — start work with the saved setup\n/connect <app> — connect an app\n/agents — list your agents\n/use <ID, number or name> — switch agents\n/status — check progress\n/stop — interrupt the current agent\n/unlink — disconnect ${label}`;

/** A durable inbox/outbox keeps channel delivery independent of browser connections. */
export class ChannelOnboarding<D extends ChannelDeps = ChannelDeps> {
  private busy = false;
  private provisioning = new Map<string, Promise<Account>>();
  constructor(protected d: D, protected t: ChannelTransport) {}
  private async account(tenant: string, user: string) {
    return this.d.sql
      .prepare(
        `SELECT * FROM ${this.t.channel}_accounts WHERE tenant_id = ? AND user_id = ?`,
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
        `INSERT INTO ${this.t.channel}_accounts (tenant_id,user_id) VALUES (?,?) ON CONFLICT (tenant_id,user_id) DO NOTHING`,
      )
      .bind(tenant, user)
      .run();
    let a = (await this.account(tenant, user))!;
    if (!a.agent_id) {
      const agent = await this.createAgent(
        a,
        "Your assistant",
        `Help the user accomplish tasks. They communicate through ${this.t.label}. Keep replies concise. Use the available tools to do the work. Never claim actions you have not performed.`,
        `onboarding:${user}`,
      );
      await this.d.sql
        .prepare(
          `UPDATE ${this.t.channel}_accounts SET agent_id = ?, active_agent_id = ? WHERE tenant_id = ? AND user_id = ? AND agent_id IS NULL`,
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
      if (c.metadata?.[`${this.t.channel}_creation_key`] === key) return c;
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
          [`${this.t.channel}_owner`]: a.user_id,
          [`${this.t.channel}_creation_key`]: key,
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
      await serialized(() => this.welcome(a));
      return { connected: true, agent_id: a.agent_id };
    }
    const token = randomBytes(24).toString("base64url");
    await this.d.sql
      .prepare(
        `UPDATE ${this.t.channel}_accounts SET link_hash = ?, link_expires_at = ? WHERE tenant_id = ? AND user_id = ?`,
      )
      .bind(hash(token), Date.now() + 600000, tenant, user)
      .run();
    return {
      connected: false,
      agent_id: a.agent_id,
      ...this.t.link(token),
      expires_in: 600,
    };
  }
  /** Credential screening and link-code handling. Known credential syntaxes are withheld
   *  first. A link-code-shaped message (iMessage bare or `ORRERY <code>`, `/start <code>`)
   *  is exempt only when its hash matches a live code; otherwise it is withheld, since it
   *  cannot be told apart from a key. Unlinked senders' other text is not kept at all: only
   *  the routing fields the "how to link" notice needs. Linked senders' text is screened. */
  protected async screen(m: ChannelMessage): Promise<ChannelMessage> {
    if (m.credential) return m;
    const withheld: ChannelMessage = { id: m.id, sender: m.sender, text: "", credential: true };
    if (knownCredentialFormat(m.text)) return withheld;
    const code = m.code ?? m.text.match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{32})$/)?.[1];
    const linked = !!await this.d.sql.prepare(`SELECT 1 AS one FROM ${this.t.channel}_accounts WHERE chat_id=? AND ${this.t.identityColumn}=?`)
      .bind(m.sender, m.sender).first();
    if (code) {
      const live = !linked && !!await this.d.sql.prepare(`SELECT 1 AS one FROM ${this.t.channel}_accounts WHERE link_hash=? AND link_expires_at>? AND chat_id IS NULL`)
        .bind(hash(code), Date.now()).first();
      if (live) return { id: m.id, sender: m.sender, text: `/start ${code}` };
      return { ...withheld, ...(linked ? { codeShaped: true } : { failedLink: true }) };
    }
    if (!linked) return withheld;
    return looksLikeCredential(m.text) ? withheld : m;
  }
  private static marker(m: ChannelMessage) {
    return JSON.stringify({ [WITHHELD]: true, id: m.id, sender: m.sender, ...(m.codeShaped ? { kind: "code" } : m.failedLink ? { kind: "link_attempt" } : {}) });
  }
  /** What a webhook persists in the inbox: the given (already minimal) payload, or only
   *  routing fields when its text is withheld (tick() re-screens older rows). */
  protected async inboxPayload(payload: unknown): Promise<string> {
    const m = await this.screen(this.t.decode(payload));
    return m.credential ? ChannelOnboarding.marker(m) : JSON.stringify(payload);
  }
  routes() {
    const app = new Hono<{
      Variables: { tenant_id: string; user_id?: string };
    }>();
    app.use("*", async (c, next) => {
      c.header("Cache-Control", "no-store");
      if (this.t.channel === "imessage" && (!c.var.user_id || !await this.d.hasMembership(c.var.user_id, c.var.tenant_id))) return c.json({ error: "User membership required" }, 403);
      await next();
    });
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
      await serialized(() => this.unlink(c.var.tenant_id, c.var.user_id!));
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
  protected async ownedConversation(tenant: string, user: string | undefined, sid: string) {
    if (!user || !await this.d.hasMembership(user, tenant)) return null;
    return this.d.sql.prepare(`SELECT c.session_id,c.agent_id FROM (SELECT session_id,tenant_id,user_id,agent_id FROM channel_conversations UNION ALL SELECT session_id,tenant_id,user_id,agent_id FROM channel_conversation_drains) c JOIN ${this.t.channel}_accounts a ON a.tenant_id=c.tenant_id AND a.user_id=c.user_id WHERE c.tenant_id=? AND c.user_id=? AND c.session_id=? AND a.chat_id IS NOT NULL`).bind(tenant, user, sid).first<{ session_id: string; agent_id: string }>();
  }
  private async unlink(tenant: string, user: string) {
    await this.d.sql
      .prepare(
        `UPDATE ${this.t.channel}_accounts SET chat_id=NULL,${this.t.identityColumn}=NULL,link_hash=NULL,link_expires_at=NULL WHERE tenant_id=? AND user_id=?`,
      )
      .bind(tenant, user)
      .run();
  }
  private async queue(a: Account, id: string, text: string, button?: { text: string; web_app: { url: string } }) {
    if (!a.chat_id) return;
    text = this.t.format?.(text) ?? text;
    const parts = text.match(new RegExp(`[\\s\\S]{1,${this.t.maxLength}}`, "gu")) ?? [""];
    await this.d.sql.batch(
      parts.map((text, i) =>
        this.d.sql
          .prepare(
            `INSERT INTO ${this.t.channel}_outbox (id,tenant_id,user_id,chat_id,text,reply_markup) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`,
          )
          .bind(`${id}:${this.t.channel === "imessage" ? String(i).padStart(6, "0") : i}`, a.tenant_id, a.user_id, a.chat_id, text, i === 0 && button ? JSON.stringify({ inline_keyboard: [[button]] }) : null),
      ),
    );
  }
  private async conversation(a: Account, mode: "setup" | "work" = "work", transitionId?: string) {
    const agentId = a.active_agent_id!;
    const existing = await this.d.sql
      .prepare(
        `SELECT session_id,transition_id FROM channel_conversations WHERE tenant_id=? AND user_id=? AND agent_id=?`,
      )
      .bind(a.tenant_id, a.user_id, agentId)
      .first<{ session_id: string; transition_id: string | null }>();
    if (existing && (!transitionId || existing.transition_id === transitionId)) {
      await this.touch(a);
      return existing.session_id;
    }
    const agent = await this.d.agents.get({ tenantId: a.tenant_id, agentId });
    if (!agent || agent.archived_at) throw new Error("Agent unavailable");
    const envId = String(agent.metadata?.default_environment_id ?? "");
    const env = envId ? await this.d.environment(a.tenant_id, envId) : null;
    if (envId && !env) throw new Error("Agent environment unavailable");
    const vaultIds = Array.isArray(agent.metadata?.default_vault_ids) ? agent.metadata.default_vault_ids as string[] : [];
    const agentSnapshot = this.d.prepareAgentSnapshot && vaultIds.length > 0
      ? await this.d.prepareAgentSnapshot(a.tenant_id, vaultIds, agent as unknown as Record<string, unknown>).catch(() => agent)
      : agent;
    const { session } = await this.d.sessions.create({
      tenantId: a.tenant_id,
      agentId,
      environmentId: envId,
      title: `Chat · ${agent.name}`,
      agentSnapshot: agentSnapshot as typeof agent,
      ...(env ? { environmentSnapshot: env } : {}),
      vaultIds,
      metadata: { channel_user: a.user_id, ...(mode === "setup" ? { oma_setup: true } : {}) },
    });
    if (mode === "work") {
      await this.d.attachAgentMemory?.({ tenantId: a.tenant_id, sessionId: session.id, agentId, agentSnapshot: agent, principalId: a.user_id });
    }
    await this.d.sql.batch([
      this.d.sql.prepare(`INSERT INTO channel_conversation_drains (session_id,tenant_id,user_id,agent_id,last_seq)
        SELECT session_id,tenant_id,user_id,agent_id,last_seq FROM channel_conversations
        WHERE tenant_id=? AND user_id=? AND agent_id=? ON CONFLICT (session_id) DO NOTHING`)
        .bind(a.tenant_id, a.user_id, agentId),
      this.d.sql.prepare(`INSERT INTO channel_conversations (session_id,tenant_id,user_id,agent_id,mode,transition_id,reply_channel) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT (tenant_id,user_id,agent_id) DO UPDATE SET session_id=excluded.session_id,mode=excluded.mode,transition_id=excluded.transition_id,last_seq=-1,reply_channel=excluded.reply_channel`)
        .bind(session.id, a.tenant_id, a.user_id, agentId, mode, transitionId ?? null, this.t.channel),
    ]);
    return session.id;
  }
  private async process(u: ChannelMessage) {
    const text = u.text.trim();
    const chat = u.sender, user = u.sender;
    let a = await this.d.sql
      .prepare(
        `SELECT * FROM ${this.t.channel}_accounts WHERE chat_id=? AND ${this.t.identityColumn}=?`,
      )
      .bind(chat, user)
      .first<Account>();
    const start = text.match(/^\/start(?:@\w+)? ([A-Za-z0-9_-]{32})$/);
    if (start && !a) {
      a = await this.d.sql
        .prepare(
          `SELECT * FROM ${this.t.channel}_accounts WHERE link_hash=? AND link_expires_at>? AND chat_id IS NULL`,
        )
        .bind(hash(start[1]), Date.now())
        .first<Account>();
      if (a && (await this.d.hasMembership(a.user_id, a.tenant_id))) {
        const result = await this.d.sql
          .prepare(
            `UPDATE ${this.t.channel}_accounts SET chat_id=?,${this.t.identityColumn}=?,link_hash=NULL,link_expires_at=NULL WHERE tenant_id=? AND user_id=? AND link_hash=? AND chat_id IS NULL`,
          )
          .bind(chat, user, a.tenant_id, a.user_id, hash(start[1]))
          .run();
        if (!result.meta.changes) return;
        a = { ...a, chat_id: chat, sender_id: user };
      } else return;
    }
    if (!a) { if (!u.failedLink) await this.t.unlinked?.(chat); return; }
    if (!(await this.d.hasMembership(a.user_id, a.tenant_id))) return;
    const id = `update:${this.t.channel}:${String(u.id).padStart(16, "0")}`;
    await this.touch(a);
    if (u.codeShaped) return this.queue(a, id, ALREADY_LINKED);
    if (u.credential) return this.withheld(a, id);
    if (text.startsWith("/start")) {
      await this.queue(
        a,
        id,
        "Your agent is ready. Starting your conversation.\n\n" + help(this.t.label),
      );
      return this.welcome(a);
    }
    if (text === "/help") return this.queue(a, id, help(this.t.label));
    if (text === "/unlink") {
      await this.unlink(a.tenant_id, a.user_id);
      return;
    }
    if (text === "/agents") {
      const agents = await this.availableAgents(a);
      await this.d.sql.prepare(`INSERT INTO channel_agent_lists (tenant_id,user_id,channel,agent_ids) VALUES (?,?,?,?)
        ON CONFLICT (tenant_id,user_id,channel) DO UPDATE SET agent_ids=excluded.agent_ids`)
        .bind(a.tenant_id, a.user_id, this.t.channel, JSON.stringify(agents.map(c => c.id))).run();
      return this.queue(a, id, this.agentList(agents, a));
    }
    if (/^\/new(?:\s|$)/.test(text)) {
      const task = text.slice(4).trim();
      const agent = await this.createAgent(
        a,
        task.slice(0, 70) || "New agent",
        task || "Help the user define this agent’s purpose during setup.",
        `${a.user_id}:${u.id}`,
      );
      await this.d.sql
        .prepare(
          `UPDATE ${this.t.channel}_accounts SET active_agent_id=? WHERE tenant_id=? AND user_id=?`,
        )
        .bind(agent.id, a.tenant_id, a.user_id)
        .run();
      a = { ...a, active_agent_id: agent.id };
      await this.conversation(a, "setup");
      await this.queue(a, id, `Created ${agent.name}. Let's set it up. Describe what it should do; use /run when the configuration is ready.`);
      return this.message(a, id, `We are setting up this agent through ${this.t.label}. ${task ? `My initial task is: ${task}.` : "Ask me what I want this agent to do."} Use the same setup tools as Orrery to refine your saved configuration. Ask one focused question at a time. Use request_access for integrations; the platform sends a connection button. Never ask for credentials in chat. Explain /run when ready; do not begin the actual work during setup.`);
    }
    if (text === "/run") {
      const current = await this.conversation(a);
      const transition = await this.d.sql.prepare(`SELECT transition_id FROM channel_conversations WHERE session_id=?`).bind(current).first<{ transition_id: string | null }>();
      const startText = "Begin the task in your saved instructions. If essential information or authorization is missing, ask before proceeding.";
      if (transition?.transition_id === id) return this.message(a, id, startText);
      const row = await this.d.sessions.get({ tenantId: a.tenant_id, sessionId: current });
      if (transition?.transition_id === id.replace(`update:${this.t.channel}:`, "update:") && row?.metadata?.[`${this.t.channel}_user`] === a.user_id)
        return this.message(a, id, startText);
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
      const requestId = `acreq-${this.t.channel}-${u.id}`;
      if (!prior.data.some(e => (e as unknown as { request_id?: string }).request_id === requestId)) {
        await this.d.requestAccess(a.tenant_id, sid, service, requestId);
      }
      return;
    }
    if (/^\/use(?:\s|$)/.test(text)) {
      const input = text.slice(4).trim();
      const agents = await this.availableAgents(a);
      let matches = agents.filter(c => c.id === input);
      if (!matches.length && /^\d+$/.test(input)) {
        const list = await this.d.sql.prepare(`SELECT agent_ids FROM channel_agent_lists WHERE tenant_id=? AND user_id=? AND channel=?`)
          .bind(a.tenant_id, a.user_id, this.t.channel).first<{ agent_ids: string }>();
        const selected = list ? JSON.parse(list.agent_ids)[Number(input) - 1] : undefined;
        matches = agents.filter(c => c.id === selected);
      } else if (!matches.length && input) {
        matches = agents.filter(c => c.name.toLowerCase() === input.toLowerCase());
        if (!matches.length) matches = agents.filter(c => c.name.toLowerCase().startsWith(input.toLowerCase()));
      }
      if (matches.length !== 1) return this.queue(a, id,
        `${matches.length ? "Several agents match. Use an ID:" : "That agent is not available. Use /agents for list numbers, or choose a name or ID:"}\n${this.agentList(matches.length ? matches : agents, a, false)}`);
      const agent = matches[0];
      await this.d.sql.prepare(`UPDATE ${this.t.channel}_accounts SET active_agent_id=? WHERE tenant_id=? AND user_id=?`)
        .bind(agent.id, a.tenant_id, a.user_id).run();
      await this.touch({ ...a, active_agent_id: agent.id });
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
    if (text.startsWith("/")) return this.queue(a, id, help(this.t.label));
    if (!text)
      return this.queue(
        a,
        id,
        "Please send a text message. Attachments are not supported yet.",
      );
    return this.message(a, id, text);
  }
  /** Reply once to withheld credential text. A pending API-key request gets a fresh secure
   *  link, minted only when the reply is sent so the token is never stored in plain form. */
  private async withheld(a: Account, id: string) {
    const binding = this.d.keyLinks && await this.d.sql.prepare(`SELECT session_id FROM channel_conversations WHERE tenant_id=? AND user_id=? AND agent_id=?`)
      .bind(a.tenant_id, a.user_id, a.active_agent_id).first<{ session_id: string }>();
    if (!binding) return this.queue(a, id, credentialRejectedText(null));
    await this.d.sql.prepare(`INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,event) VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`)
      .bind(`notice:${id}`, a.tenant_id, a.user_id, a.active_agent_id, binding.session_id, JSON.stringify({ type: CREDENTIAL_NOTICE })).run();
  }
  /** iMessage puts a secure link in the text; Telegram uses a URL button when it can (https). */
  private secureLink(url: string, label: string) {
    const button = !!this.t.urlButtons && url.startsWith("https:");
    return { inline: button ? "" : url, markup: button ? JSON.stringify({ inline_keyboard: [[{ text: label, url }]] }) : null };
  }
  private async touch(a: Account) {
    await this.d.sql.prepare(`UPDATE channel_conversations SET reply_channel=? WHERE tenant_id=? AND user_id=? AND agent_id=?`)
      .bind(this.t.channel, a.tenant_id, a.user_id, a.active_agent_id).run();
  }
  private async availableAgents(a: Account): Promise<AgentChoice[]> {
    const rows = await this.d.sql.prepare("SELECT id,config FROM agents WHERE tenant_id=? AND archived_at IS NULL ORDER BY id")
      .bind(a.tenant_id).all<{ id: string; config: string }>();
    return (rows.results ?? []).map(r => ({ id: r.id, name: String(JSON.parse(r.config).name ?? r.id) }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || a.id.localeCompare(b.id));
  }
  private agentList(agents: AgentChoice[], a: Account, numbered = true) {
    const shown = agents.slice(0, 20);
    return shown.map((c, i) => `${numbered ? `${i + 1}. ` : ""}${c.name.replace(/\s+/g, " ").slice(0, 70)}${c.id === a.active_agent_id ? " (active)" : ""} — ${c.id}`).join("\n")
      + (agents.length > shown.length ? `\n${agents.length - shown.length} more omitted. Use /use with a name or ID.` : agents.length ? "" : "No available agents.");
  }
  private async welcome(a: Account) {
    // Stable event ID makes reconnection/retries safe and lets an existing
    // connection resume onboarding after deployment without creating a second turn.
    await this.message(
      { ...a, active_agent_id: a.agent_id },
      `${this.t.channel}-welcome:${a.user_id}`,
      `The user just connected their ${this.t.label} account. Briefly introduce yourself as their cloud agent and ask what they want to accomplish. Mention that /new starts a guided agent setup and /run starts work after setup. Do not perform unrelated work or ask them to use the web UI.`,
    );
  }
  private async message(a: Account, id: string, text: string) {
    const sid = await this.conversation(a);
    const events = await this.d.router.getEvents(sid, { limit: 10000 });
    if (events.data.some((e) => (e as unknown as { id?: string }).id === id))
      return;
    // Pre-upgrade turns used unqualified IDs. Honor them only for that session's
    // original channel, so matching IDs from the other transport remain distinct.
    const legacyId = id.replace(`update:${this.t.channel}:`, "update:");
    if (legacyId !== id && events.data.some(e => (e as unknown as { id?: string }).id === legacyId)) {
      const session = await this.d.sessions.get({ tenantId: a.tenant_id, sessionId: sid });
      if (session?.metadata?.[`${this.t.channel}_user`] === a.user_id) return;
    }
    const appended = await this.d.router.appendEvent(sid, {
      type: "user.message",
      id,
      content: [{ type: "text", text }],
    } as SessionEvent);
    if (appended.status >= 400) throw new Error("Channel input could not be appended");
  }
  /** Resolve at delivery time, so queued replies follow the last inbound channel. */
  private async destination(c: { tenant_id: string; user_id: string; agent_id: string }) {
    const binding = await this.d.sql.prepare(`SELECT reply_channel FROM channel_conversations WHERE tenant_id=? AND user_id=? AND agent_id=?`)
      .bind(c.tenant_id, c.user_id, c.agent_id).first<{ reply_channel: string }>();
    if (!binding) return null;
    const channels = binding.reply_channel === "imessage" ? ["imessage", "telegram"] : ["telegram", "imessage"];
    for (const channel of channels) {
      const account = await this.d.sql.prepare(`SELECT * FROM ${channel}_accounts WHERE tenant_id=? AND user_id=? AND chat_id IS NOT NULL`)
        .bind(c.tenant_id, c.user_id).first<Account>();
      if (account) return { channel, account };
    }
    return null;
  }
  private async collectOutput() {
    // A single cursor is paired atomically with durable, channel-independent output.
    // A restart between collection and send cannot lose or re-enqueue an event.
    for (const table of ["channel_conversations", "channel_conversation_drains"]) {
      const rows = await this.d.sql.prepare(`SELECT * FROM ${table}`).all<Conversation>();
      for (const c of rows.results ?? []) {
        if (!await this.d.hasMembership(c.user_id, c.tenant_id) || !await this.destination(c)) continue;
        const page = await this.d.router.getEvents(c.session_id, { afterSeq: Number(c.last_seq), limit: 100 });
        for (const e of page.data) {
          const event = e as unknown as { type: string; seq: number };
          const statements = [];
          if (["agent.message", "session.error", "system.access_request"].includes(event.type)) {
            statements.push(this.d.sql.prepare(`INSERT INTO channel_deliveries (id,tenant_id,user_id,agent_id,session_id,event)
              VALUES (?,?,?,?,?,?) ON CONFLICT (id) DO NOTHING`)
              .bind(`event:${c.session_id}:${String(event.seq).padStart(16, "0")}`, c.tenant_id, c.user_id, c.agent_id, c.session_id, JSON.stringify(e)));
          }
          statements.push(this.d.sql.prepare(`UPDATE ${table} SET last_seq=? WHERE session_id=? AND last_seq<?`)
            .bind(event.seq, c.session_id, event.seq));
          await this.d.sql.batch(statements);
        }
      }
    }
  }
  private async deliverOutput() {
    const rows = await this.d.sql.prepare(`SELECT * FROM channel_deliveries WHERE sent=0 AND next_at<=? ORDER BY id`)
      .bind(Date.now()).all<Conversation & { id: string; event: string | null; text: string | null; reply_markup: string | null; delivered_chars: number; attempts: number }>();
    for (const row of rows.results ?? []) {
      if (!await this.d.hasMembership(row.user_id, row.tenant_id)) continue;
      const target = await this.destination(row);
      if (!target || target.channel !== this.t.channel) continue;
      const event = row.event ? JSON.parse(row.event) : null;
      let text = row.text;
      let markup: string | null = null;
      const scope = { tenantId: row.tenant_id, userId: row.user_id, sessionId: row.session_id, channel: this.t.channel, account: target.account };
      // A secure key link is minted for every send attempt (replacing the previous one) and
      // is never written to the delivery row. Without a usable link, keep today's behaviour.
      const keyUrl = event?.type === "system.access_request" && event.auth_kind === "mcp_api_key" && this.d.keyLinks && typeof event.request_id === "string"
        ? await this.d.keyLinks.mint({ ...scope, requestId: event.request_id }).catch(() => null) : null;
      if (keyUrl) {
        const service = String(event.service).slice(0, 100);
        const link = this.secureLink(keyUrl, `Add ${service} API key`);
        text = `Your agent needs an API key for ${service}${event.reason ? `: ${String(event.reason).slice(0, 1000)}` : ""}. Do not paste keys in this chat. Open the secure one-time page to add it; the link expires in 15 minutes.${link.inline ? ` ${link.inline}` : ""}`;
        markup = link.markup;
      } else if (event?.type === "system.access_request") {
        if (!this.d.publicBaseUrl) continue; // Keep the request until a usable URL exists.
        const { url, miniApp } = this.t.access(this.d.publicBaseUrl, row.session_id, event.request_id);
        text = `Connect ${String(event.service).slice(0, 100)}${event.reason ? `: ${String(event.reason).slice(0, 1000)}` : ""}. Choose your vault and authorize in the secure page. Then return here.${miniApp ? "" : ` Sign in to Orrery: ${url}`}`;
        if (miniApp) markup = JSON.stringify({ inline_keyboard: [[{ text: `Connect ${event.service}`, web_app: { url } }]] });
      } else if (event?.type === CREDENTIAL_NOTICE) {
        const url = this.d.keyLinks ? await this.d.keyLinks.pending(scope).catch(() => null) : null;
        const link = url ? this.secureLink(url, "Open secure key page") : null;
        text = credentialRejectedText(url, !link?.markup);
        markup = link?.markup ?? null;
      } else if (text === null) {
        if (event?.type === "agent.message") {
          text = Array.isArray(event.content) ? event.content.filter((b: { type: string }) => b.type === "text").map((b: { text?: string }) => b.text ?? "").join("\n") : "";
        } else if (event?.type === "session.error") {
          text = /total disk limit exceeded/i.test(event.message ?? event.error ?? "")
            ? "Cloud storage is full, so the computer could not start. Your agent configuration is saved. Free or archive an unused computer, or increase the Daytona storage limit, then retry /run."
            : "The agent encountered an error. Check /status or retry your request.";
        } else text = "";
        text = this.t.format?.(text ?? "") ?? text;
        // Freeze formatting once, so partial delivery can resume on another channel.
        await this.d.sql.prepare("UPDATE channel_deliveries SET text=? WHERE id=?").bind(text, row.id).run();
      }
      if (row.reply_markup) {
        // Pre-migration pending Telegram buttons retain their authenticated Mini App URL.
        if (this.t.channel === "telegram") markup = row.reply_markup;
        else {
          const url = this.d.publicBaseUrl ? this.t.access(this.d.publicBaseUrl, row.session_id, "").url : JSON.parse(row.reply_markup).inline_keyboard?.[0]?.[0]?.web_app?.url;
          if (url) text += ` Sign in to Orrery: ${url}`;
        }
      }
      const chars = Array.from(text ?? "");
      let offset = Number(row.delivered_chars);
      while (offset < chars.length) {
        const part = chars.slice(offset, offset + this.t.maxLength).join("");
        let result: Delivery;
        try {
          result = await this.t.send({ chat_id: target.account.chat_id!, text: part, reply_markup: offset === 0 ? markup : null });
        } catch { result = { delivered: false }; }
        if (!result.delivered) {
          if (result.permanent) await this.unlink(row.tenant_id, row.user_id);
          await this.d.sql.prepare("UPDATE channel_deliveries SET attempts=attempts+1,next_at=? WHERE id=?")
            .bind(result.permanent ? 0 : Date.now() + (result.retryAfterMs ?? this.retryDelay(row.attempts)), row.id).run();
          break;
        }
        offset += Array.from(part).length;
        if (offset >= chars.length) {
          await this.d.sql.prepare("UPDATE channel_deliveries SET delivered_chars=?,sent=1,event=NULL,text=NULL,reply_markup=NULL WHERE id=?").bind(offset, row.id).run();
        } else {
          await this.d.sql.prepare("UPDATE channel_deliveries SET delivered_chars=? WHERE id=?").bind(offset, row.id).run();
        }
      }
      if (offset >= chars.length) await this.d.sql.prepare("UPDATE channel_deliveries SET sent=1,event=NULL,text=NULL,reply_markup=NULL WHERE id=?").bind(row.id).run();
    }
  }
  private retryDelay(attempts: number) {
    return this.t.channel === "telegram" ? 30000 : Math.min(3600000, 30000 * 2 ** Math.min(attempts, 7));
  }
  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      await serialized(async () => {
        const inbox = await this.d.sql
          .prepare(
            `SELECT update_id,payload FROM ${this.t.channel}_inbox WHERE done=0 AND next_at<=? ORDER BY ${this.t.inboxOrder} LIMIT 20`,
          )
          .bind(Date.now())
          .all<{ update_id: string; payload: string }>();
        for (const row of inbox.results ?? []) {
          try {
            let payload = JSON.parse(row.payload);
            let message: ChannelMessage;
            if (payload?.[WITHHELD]) message = { id: payload.id, sender: payload.sender, text: "", credential: true, ...(payload.kind === "code" ? { codeShaped: true } : payload.kind === "link_attempt" ? { failedLink: true } : {}) };
            else {
              if (this.t.minimize) {
                // Older rows may hold a full provider payload: reduce it before anything can fail.
                const minimal = JSON.stringify(this.t.minimize(payload));
                if (minimal !== row.payload) {
                  await this.d.sql.prepare(`UPDATE ${this.t.channel}_inbox SET payload=? WHERE update_id=?`).bind(minimal, row.update_id).run();
                  payload = JSON.parse(minimal);
                }
              }
              message = await this.screen(this.t.decode(payload));
              if (message.credential) {
                // Scrub before anything else, so the text cannot survive a failed attempt or retry.
                await this.d.sql.prepare(`UPDATE ${this.t.channel}_inbox SET payload=? WHERE update_id=?`)
                  .bind(ChannelOnboarding.marker(message), row.update_id).run();
              }
            }
            await this.process(message);
            await this.d.sql
              .prepare(
                `UPDATE ${this.t.channel}_inbox SET done=1,payload='{}' WHERE update_id=?`,
              )
              .bind(row.update_id)
              .run();
          } catch {
            await this.d.sql
              .prepare(
                `UPDATE ${this.t.channel}_inbox SET attempts=attempts+1,next_at=? WHERE update_id=?`,
              )
              .bind(Date.now() + 30000, row.update_id)
              .run();
          }
        }
        await this.collectOutput();
        await this.deliverOutput();
        // Finish secure key links whose grant landed but whose completion did not.
        await this.d.keyLinks?.reconcile?.().catch(() => {});
        const outbox = await this.d.sql
          .prepare(
            `SELECT * FROM ${this.t.channel}_outbox WHERE sent=0 AND next_at<=? ORDER BY id LIMIT 20`,
          )
          .bind(Date.now())
          .all<{
            id: string;
            tenant_id: string;
            user_id: string;
            chat_id: string;
            text: string;
            reply_markup: string | null;
            attempts: number;
          }>();
        for (const row of outbox.results ?? []) {
          const a = await this.account(row.tenant_id, row.user_id);
          if (
            a?.chat_id !== row.chat_id ||
            !(await this.d.hasMembership(row.user_id, row.tenant_id))
          ) {
            await this.d.sql
              .prepare(`UPDATE ${this.t.channel}_outbox SET sent=1,text='',reply_markup=NULL WHERE id=?`)
              .bind(row.id)
              .run();
            continue;
          }
          try {
            const result = await this.t.send(row);
            if (!result.delivered) {
              if (result.permanent) {
                await this.unlink(row.tenant_id, row.user_id);
                await this.d.sql.prepare(`UPDATE ${this.t.channel}_outbox SET sent=1,text='',reply_markup=NULL WHERE id=?`).bind(row.id).run();
              } else {
                await this.d.sql.prepare(`UPDATE ${this.t.channel}_outbox SET attempts=attempts+1,next_at=? WHERE id=?`)
                  .bind(Date.now() + (result.retryAfterMs ?? this.retryDelay(row.attempts)), row.id).run();
              }
              continue;
            }
            await this.d.sql
              .prepare(`UPDATE ${this.t.channel}_outbox SET sent=1,text='',reply_markup=NULL WHERE id=?`)
              .bind(row.id)
              .run();
          } catch {
            await this.d.sql
              .prepare(
                `UPDATE ${this.t.channel}_outbox SET attempts=attempts+1,next_at=? WHERE id=?`,
              )
              .bind(Date.now() + this.retryDelay(row.attempts), row.id)
              .run();
          }
        }
      });
    } finally {
      this.busy = false;
    }
  }
}
