// Slack reply bridge — guaranteed delivery for Slack-originated turns.
//
// The signal-protocol prompt instructs agents to post replies through the
// Slack MCP tools, and strong models usually comply — but "usually" is not
// a delivery guarantee (observed live: gpt-5.5 created the requested
// ambient rule, then wrote its confirmation as a plain agent.message that
// no human ever saw). This bridge closes the loop: after a harness turn
// whose triggering user.message carries Slack metadata, if the agent did
// NOT post to Slack itself, the platform mirrors the agent's final
// message into the originating channel/thread using the installation's
// bot token.
//
// Best-effort by design: every failure is logged and swallowed — a Slack
// outage or revoked token must never fail the turn itself.

import type { SqlClient } from "@open-managed-agents/sql-client";
import type { UserMessageEvent } from "@open-managed-agents/shared";
import { getLogger } from "@open-managed-agents/observability";

const log = getLogger("slack-reply-bridge");

/** Slack caps chat.postMessage text ~4k chars; leave headroom. */
const MAX_SLACK_TEXT = 3900;

interface SlackTriggerMeta {
  channelId?: string;
  threadTs?: string;
}

export interface SlackReplyBridgeDeps {
  sql: SqlClient;
  /** WebCryptoAesGcm(platformRootSecret, "integrations.tokens").decrypt */
  decryptToken(cipher: string): Promise<string>;
  fetchImpl?: typeof fetch;
}

export class NodeSlackReplyBridge {
  constructor(private readonly deps: SlackReplyBridgeDeps) {}

  /**
   * Mirror the turn's final agent.message to Slack when the agent didn't
   * post there natively. Call after runHarnessTurn completes for the
   * triggering event. No-op (single property read) for non-Slack turns.
   */
  async mirrorTurnReply(input: {
    tenantId: string;
    sessionId: string;
    triggerEvent: UserMessageEvent;
  }): Promise<void> {
    const slack = (input.triggerEvent.metadata as { slack?: SlackTriggerMeta } | undefined)
      ?.slack;
    if (!slack?.channelId) return;

    try {
      // Events of THIS turn = everything after the last user.message (the
      // work queue serializes turns per session, so the last user.message
      // is the trigger that just ran).
      const trigger = await this.deps.sql
        .prepare(
          `SELECT seq FROM session_events
           WHERE session_id = ? AND type = 'user.message'
           ORDER BY seq DESC LIMIT 1`,
        )
        .bind(input.sessionId)
        .first<{ seq: number }>();
      if (!trigger) return;

      const r = await this.deps.sql
        .prepare(
          `SELECT type, data FROM session_events
           WHERE session_id = ? AND seq > ?
           ORDER BY seq ASC`,
        )
        .bind(input.sessionId, trigger.seq)
        .all<{ type: string; data: string | Record<string, unknown> }>();
      const events = (r.results ?? []).map((e) => ({
        type: e.type,
        payload: (typeof e.data === "string" ? safeParse(e.data) : e.data) ?? {},
      }));

      // Agent already posted through a Slack MCP tool? Then don't double-post.
      const postedNatively = events.some((e) => {
        if (e.type !== "agent.mcp_tool_use") return false;
        const name = String((e.payload as { name?: string }).name ?? "");
        return /slack/i.test(name) && /(post|chat|message|reply)/i.test(name);
      });
      if (postedNatively) return;

      const lastMessage = [...events]
        .reverse()
        .find((e) => e.type === "agent.message");
      if (!lastMessage) return;
      const content = (lastMessage.payload as { content?: Array<{ text?: string }> }).content;
      const text = Array.isArray(content)
        ? content.map((c) => c?.text ?? "").join("").trim()
        : "";
      if (!text) return;

      // Bot token via the session's thread binding → publication → installation.
      const tokenRow = await this.deps.sql
        .prepare(
          `SELECT si.access_token_cipher AS cipher
             FROM slack_thread_sessions ts
             JOIN slack_publications sp ON sp.id = ts.publication_id
             JOIN slack_installations si ON si.id = sp.installation_id
            WHERE ts.session_id = ? AND ts.tenant_id = ?
            LIMIT 1`,
        )
        .bind(input.sessionId, input.tenantId)
        .first<{ cipher: string | null }>();
      if (!tokenRow?.cipher) {
        log.warn(
          { op: "slack_reply_bridge.no_token", session_id: input.sessionId },
          "slack-bound session has no installation bot token",
        );
        return;
      }
      const token = await this.deps.decryptToken(tokenRow.cipher);

      const doFetch = this.deps.fetchImpl ?? fetch;
      const res = await doFetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({
          channel: slack.channelId,
          ...(slack.threadTs ? { thread_ts: slack.threadTs } : {}),
          text: text.length > MAX_SLACK_TEXT ? `${text.slice(0, MAX_SLACK_TEXT)}…` : text,
          unfurl_links: false,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (body.ok) {
        log.info(
          { op: "slack_reply_bridge.mirrored", session_id: input.sessionId, channel: slack.channelId },
          "mirrored agent reply to slack",
        );
      } else {
        log.warn(
          { op: "slack_reply_bridge.post_failed", session_id: input.sessionId, error: body.error ?? res.status },
          "slack mirror post failed",
        );
      }
    } catch (err) {
      log.warn(
        { err, op: "slack_reply_bridge.failed", session_id: input.sessionId },
        "slack reply bridge failed",
      );
    }
  }
}

function safeParse(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}
