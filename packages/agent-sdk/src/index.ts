/**
 * @openma/agent-sdk — connect a frontend to a *deployed* openma agent.
 *
 * Talks to the public deployments gateway (`/public/v1`) using a
 * publishable key (`oma_pk_...`) minted by `POST /v1/deployments`. A
 * publishable key can only start and drive sessions of the one agent its
 * deployment pins — it cannot read or mutate anything else — so it is
 * designed to ship inside browser bundles, the same way Stripe
 * publishable keys are.
 *
 * ```ts
 * import { AgentClient } from "@openma/agent-sdk";
 *
 * const client = new AgentClient({
 *   baseUrl: "https://your-openma-host",
 *   deploymentKey: "oma_pk_...",
 * });
 *
 * const session = await client.createSession({ title: "Support chat" });
 *
 * // One-shot helper: send a message, stream this turn's events.
 * for await (const ev of session.chat("How do I reset my password?")) {
 *   if (ev.type === "agent.message_chunk") render(ev.delta);
 * }
 *
 * // Or drive the pieces yourself:
 * await session.send("Hello!");
 * for await (const ev of session.stream()) {
 *   if (ev.type === "session.status_idle") break;
 * }
 * ```
 *
 * Zero dependencies. Runs anywhere `fetch` + `ReadableStream` exist:
 * browsers, Node ≥ 20, Bun, Deno, edge runtimes.
 */

// ─── Events ───────────────────────────────────────────────────────────────

/** Loose event shape — every event has `type`; well-known ones below. */
export interface AgentEventBase {
  type: string;
  id?: string;
  processed_at?: string | null;
  [key: string]: unknown;
}

export interface AgentMessageChunkEvent extends AgentEventBase {
  type: "agent.message_chunk";
  delta: string;
}

export interface AgentMessageEvent extends AgentEventBase {
  type: "agent.message";
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
}

export interface SessionStatusEvent extends AgentEventBase {
  type:
    | "session.status_running"
    | "session.status_idle"
    | "session.status_rescheduled"
    | "session.status_terminated";
  stop_reason?: { type: string; event_ids?: string[] };
}

export interface SessionErrorEvent extends AgentEventBase {
  type: "session.error";
  error?: string;
  message?: string;
}

export type AgentEvent =
  | AgentMessageChunkEvent
  | AgentMessageEvent
  | SessionStatusEvent
  | SessionErrorEvent
  | AgentEventBase;

export interface ContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface PublicSession {
  type: "session";
  id: string;
  status: "idle" | "running" | "rescheduling" | "terminated" | string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Errors ───────────────────────────────────────────────────────────────

export class AgentClientError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    readonly url: string,
  ) {
    super(`openma agent gateway ${status} on ${url}: ${body.slice(0, 300)}`);
    this.name = "AgentClientError";
  }
}

// ─── Client ───────────────────────────────────────────────────────────────

export interface AgentClientOptions {
  /** Origin of the openma deployment, e.g. `https://openma.example.com`. */
  baseUrl: string;
  /** Publishable key from `POST /v1/deployments` (`oma_pk_...`). */
  deploymentKey: string;
  /** Custom fetch — tests, proxies, missing global fetch. */
  fetch?: typeof fetch;
}

export interface StreamOptions {
  signal?: AbortSignal;
  /** Replay persisted history before tailing live events (default true —
   *  reconnect-safe: pair with `afterSeq` to resume without duplicates). */
  replay?: boolean;
  /** Resume after a specific seq; rides as `Last-Event-ID`. */
  afterSeq?: number;
  /** Auto-reconnect when the connection drops (default true). Resumes
   *  from the last seen seq, so no events are lost or duplicated. */
  reconnect?: boolean;
}

export class AgentClient {
  private readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly headers: Record<string, string>;

  constructor(opts: AgentClientOptions) {
    if (!opts.deploymentKey?.startsWith("oma_pk_")) {
      throw new TypeError(
        "AgentClient: `deploymentKey` must be a publishable key (oma_pk_...). " +
          "Mint one with POST /v1/deployments. Never ship a tenant API key (oma_...) to a frontend.",
      );
    }
    if (!opts.baseUrl) throw new TypeError("AgentClient: `baseUrl` is required");
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetcher = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = { authorization: `Bearer ${opts.deploymentKey}` };
  }

  /** Start a session of the deployed agent. */
  async createSession(input: { title?: string } = {}): Promise<AgentSession> {
    const session = await this.json<PublicSession>("POST", "/sessions", input);
    return new AgentSession(this, session);
  }

  /** Re-attach to a session this deployment created earlier (e.g. its id
   *  was kept in localStorage across a page reload). */
  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = await this.json<PublicSession>(
      "GET",
      `/sessions/${encodeURIComponent(sessionId)}`,
    );
    return new AgentSession(this, session);
  }

  // ── internal HTTP helpers (used by AgentSession) ──

  /** @internal */
  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.raw(method, path, {
      body: body !== undefined ? JSON.stringify(body) : undefined,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    });
    // Some endpoints ack with an empty body (e.g. events POST → 202).
    const text = await res.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentClientError(res.status, text, res.url);
    }
  }

  /** @internal */
  async raw(
    method: string,
    path: string,
    init?: {
      body?: BodyInit;
      headers?: Record<string, string>;
      query?: Record<string, string | number | undefined>;
      signal?: AbortSignal;
    },
  ): Promise<Response> {
    const url = new URL(`${this.baseUrl}/public/v1${path}`);
    for (const [k, v] of Object.entries(init?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const res = await this.fetcher(url.toString(), {
      method,
      headers: { ...this.headers, ...init?.headers },
      body: init?.body,
      signal: init?.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AgentClientError(res.status, text, url.toString());
    }
    return res;
  }
}

// ─── Session handle ───────────────────────────────────────────────────────

export class AgentSession {
  constructor(
    private readonly client: AgentClient,
    /** Sanitized session record as returned by the gateway. */
    readonly session: PublicSession,
  ) {}

  get id(): string {
    return this.session.id;
  }

  /** Refresh and return the sanitized session status. */
  async status(): Promise<PublicSession> {
    return this.client.json<PublicSession>(
      "GET",
      `/sessions/${encodeURIComponent(this.id)}`,
    );
  }

  /** Send a user message (text or content blocks). Fire-and-forget: the
   *  reply arrives on `stream()` / `chat()`. */
  async send(content: string | ContentBlock[]): Promise<void> {
    const blocks: ContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    await this.client.json("POST", `/sessions/${encodeURIComponent(this.id)}/events`, {
      events: [{ type: "user.message", content: blocks }],
    });
  }

  /** Ask the agent to stop what it's doing. */
  async interrupt(): Promise<void> {
    await this.client.json("POST", `/sessions/${encodeURIComponent(this.id)}/events`, {
      events: [{ type: "user.interrupt" }],
    });
  }

  /** Approve or deny a tool call the agent paused on
   *  (`agent.tool_use` with a confirmation request). */
  async confirmTool(toolUseId: string, result: "allow" | "deny", denyMessage?: string): Promise<void> {
    await this.client.json("POST", `/sessions/${encodeURIComponent(this.id)}/events`, {
      events: [
        {
          type: "user.tool_confirmation",
          tool_use_id: toolUseId,
          result,
          ...(denyMessage ? { deny_message: denyMessage } : {}),
        },
      ],
    });
  }

  /** Answer an `agent.custom_tool_use` event — your frontend ran the tool. */
  async sendToolResult(
    customToolUseId: string,
    content: string | ContentBlock[],
    isError = false,
  ): Promise<void> {
    const blocks: ContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    await this.client.json("POST", `/sessions/${encodeURIComponent(this.id)}/events`, {
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: customToolUseId,
          content: blocks,
          is_error: isError,
        },
      ],
    });
  }

  /** Page through the persisted event log (JSON, no stream). */
  async events(opts: { limit?: number; afterSeq?: number } = {}): Promise<AgentEvent[]> {
    const res = await this.client.raw(
      "GET",
      `/sessions/${encodeURIComponent(this.id)}/events`,
      { query: { limit: opts.limit ?? 100, after_seq: opts.afterSeq } },
    );
    const body = (await res.json()) as { data?: AgentEvent[] };
    return body.data ?? [];
  }

  /**
   * Live event stream (SSE), with optional history replay and automatic
   * reconnect-with-resume. Never ends on its own unless the session
   * terminates — `break` out or abort the signal to stop.
   */
  async *stream(opts: StreamOptions = {}): AsyncIterable<AgentEvent> {
    const reconnect = opts.reconnect ?? true;
    let afterSeq = opts.afterSeq;
    let replay = opts.replay ?? true;
    let attempt = 0;

    for (;;) {
      let res: Response;
      try {
        res = await this.client.raw(
          "GET",
          `/sessions/${encodeURIComponent(this.id)}/events/stream`,
          {
            headers: {
              accept: "text/event-stream",
              ...(afterSeq !== undefined ? { "last-event-id": String(afterSeq) } : {}),
            },
            query: replay && afterSeq === undefined ? { replay: 1 } : undefined,
            signal: opts.signal,
          },
        );
        attempt = 0;
      } catch (err) {
        if (opts.signal?.aborted || !reconnect || attempt >= 5) throw err;
        attempt += 1;
        await sleep(Math.min(500 * 2 ** attempt, 8000), opts.signal);
        continue;
      }

      for await (const ev of parseSSE(res, opts.signal)) {
        const seq = (ev as { seq?: number }).seq;
        if (typeof seq === "number") afterSeq = seq;
        yield ev as AgentEvent;
        if ((ev as AgentEvent).type === "session.status_terminated") return;
      }

      if (opts.signal?.aborted || !reconnect) return;
      // Connection dropped — resume from the last seen seq (replay of
      // already-yielded events is suppressed via Last-Event-ID).
      replay = false;
      await sleep(500, opts.signal);
    }
  }

  /**
   * One-shot turn: send a message and yield this turn's events until the
   * session goes idle. The common chat-UI loop in one call.
   */
  async *chat(
    content: string | ContentBlock[],
    opts: { signal?: AbortSignal } = {},
  ): AsyncIterable<AgentEvent> {
    await this.send(content);
    for await (const ev of this.stream({ ...opts, replay: false })) {
      yield ev;
      if (
        ev.type === "session.status_idle" &&
        (ev as SessionStatusEvent).stop_reason?.type !== "requires_action"
      ) {
        return;
      }
      if (ev.type === "session.status_terminated") return;
    }
  }

  /**
   * Callback-style subscription for frameworks where an async iterator is
   * awkward (e.g. React effects). Returns an unsubscribe function.
   */
  subscribe(handlers: {
    onEvent: (ev: AgentEvent) => void;
    onError?: (err: unknown) => void;
    replay?: boolean;
  }): () => void {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const ev of this.stream({
          signal: controller.signal,
          replay: handlers.replay ?? true,
        })) {
          handlers.onEvent(ev);
        }
      } catch (err) {
        if (!controller.signal.aborted) handlers.onError?.(err);
      }
    })();
    return () => controller.abort();
  }
}

// ─── SSE parsing ──────────────────────────────────────────────────────────

async function* parseSSE(
  res: Response,
  signal?: AbortSignal,
): AsyncIterable<unknown> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      if (signal?.aborted) {
        await reader.cancel().catch(() => {});
        return;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch {
        return; // network drop — caller decides whether to reconnect
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = block.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          /* malformed event — skip */
        }
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}
