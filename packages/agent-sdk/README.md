# @openma/agent-sdk

Connect your app to an agent you built on openma / Harness Studio.

This is the **frontend** SDK: it talks to the public deployments gateway
(`/public/v1`) with a **publishable key** (`oma_pk_...`) — a key that can only
start and drive sessions of the one agent its deployment pins. It cannot read
your other agents, sessions, vaults, or config, so it is safe to ship in a
browser bundle, the same way Stripe publishable keys are.

> Building a backend integration instead? The openma API is wire-compatible
> with Anthropic's Managed Agents API — use `@anthropic-ai/sdk` with
> `baseURL` pointed at your deployment and a tenant API key.

## 1. Deploy your agent

In the Console: **Agents → your agent → Deploy**. The publishable key
(`oma_pk_...`) is shown exactly once; rotate it any time from the same
deployment in the Console.

Creating a deployment and rotating its key mint a new key, so they need a
signed-in Console session: `POST /v1/deployments` and
`POST /v1/deployments/:id/rotate_key` refuse tenant API keys (`x-api-key`)
with `403 permission_error`, the same way API keys can't mint API keys.
Listing, reading, updating and deleting deployments still work with an API
key.

## 2. Connect from your app

```bash
npm install @openma/agent-sdk
```

```ts
import { AgentClient } from "@openma/agent-sdk";

const client = new AgentClient({
  baseUrl: "https://your-openma-host",
  deploymentKey: "oma_pk_...",
});

// Start a session of the deployed agent
const session = await client.createSession({ title: "Support chat" });

// One-shot turn: send + stream the reply
for await (const ev of session.chat("How do I reset my password?")) {
  switch (ev.type) {
    case "agent.message_chunk":
      appendToUi(ev.delta);
      break;
    case "agent.tool_use":
      showToolSpinner(ev);
      break;
  }
}
```

Lower-level control:

```ts
await session.send("Hello!");                 // fire-and-forget user message

for await (const ev of session.stream()) {    // replays history, then live;
  // auto-reconnects with resume on network drops
  if (ev.type === "session.status_idle") break;
}

await session.interrupt();                     // stop the agent mid-task
await session.confirmTool(toolUseId, "allow"); // approve a gated tool call
await session.sendToolResult(id, "42");        // answer a custom tool call

// Survive page reloads — keep session.id in localStorage:
const restored = await client.resumeSession(savedId);
```

React-style subscription:

```ts
useEffect(() => session.subscribe({ onEvent: setEvent }), [session.id]);
```

## What the publishable key can and cannot do

| Allowed | Not possible |
|---|---|
| Create sessions of the deployed agent | Touch any other agent or tenant data |
| Send `user.message` / `interrupt` / `tool_confirmation` / `custom_tool_result` | Send `user.define_outcome` or arbitrary events |
| Read/stream events of sessions **it created** | Read sessions created by other deployments or the private API |
| — | See the agent's system prompt, tools, or vault config (responses are sanitized) |

Restrict browser origins per deployment with `allowed_origins`; rotate or
disable the key from the Console at any time.

Zero dependencies. Works in browsers, Node ≥ 20, Bun, Deno, and edge runtimes.
