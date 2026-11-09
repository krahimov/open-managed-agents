# Reasoning levels

One user-facing knob — `reasoning_level` — mapped per provider by the harness.
Source of truth: `packages/api-types/src/reasoning.ts` (used by the agent
harness, main-node SDK harnesses, the HTTP routes and the console).

Levels: `low`, `medium` (default when unset), `high`, `xhigh` (Extra High),
`max`. The legacy `instant` value is still accepted on the wire so stored
agents keep loading; the console no longer offers it.

## Where it is set

| Scope | How | Notes |
|---|---|---|
| Agent | `_oma.reasoning_level` on `POST /v1/agents[/:id]` | New agent version. Console: agent form, or the quick switcher on the agent page. The default (`medium`) is stored as unset. |
| Session | `metadata.reasoning_level` and/or `metadata.model` on `POST /v1/sessions/:id` (or at create) | THIS session only, re-read every turn, agent untouched. `metadata.model` is a model-card `model_id` and is only honored when the tenant has that card. `null` clears a key. Console: the composer chip. Node runtime only. |

## Provider mapping

| Level | OpenAI reasoning model (Responses API) | Claude 4.7 / 4.8 / 5.x | Claude 4.6 | Claude ≤ 4.5 |
|---|---|---|---|---|
| low | effort `low` | adaptive, effort `low` | adaptive, effort `low` | budget 4k |
| medium | `medium` | `medium` | `medium` | 16k |
| high | `high` | `high` | `high` | 32k |
| xhigh | `xhigh` (→ `high` where unsupported) | `xhigh` | `high` | 48k |
| max | highest accepted: `xhigh` (gpt-5.2+, gpt-6+, codex-max), else `high` | `max` | `max` | 64k, clamped under the output cap |
| instant (legacy) | `low` | 5.x: effort `low` (thinking can't be off); 4.7/4.8: thinking off | thinking off | off |

- **OpenAI reasoning model** = o-series or any `gpt-N` with N ≥ 5
  (`isOpenAiReasoningModel`; `gpt-5-chat*` excluded). Official cards (`oai`)
  always ride `/v1/responses` with `store:false` + encrypted reasoning, since
  chat/completions 400s on any effort above `none` once tools are attached.
  The ZDR fallback (chat + `none` on "Item with id 'fc_…' not found") stays.
- **Gateways** (`oai-compatible`, `ant-compatible`) and non-reasoning models
  ignore the level; OpenAI-compatible reasoning models keep the
  `reasoning_effort:"none"` floor with tools.
- `@ai-sdk/anthropic`'s `effort` enum lacks `xhigh`; the provider sends `high`
  and `resolveModel`'s fetch upgrades the wire value for xhigh turns.

## Harness coverage

| Harness | Level | Session model override |
|---|---|---|
| default (AI SDK) | full mapping above | yes |
| pi | via pi ThinkingLevel (clamped to pi's catalog) | yes |
| codex-sdk | `modelReasoningEffort` (OpenAI mapping) | yes, when the model is a bare OpenAI id |
| claude-agent-sdk | `thinking` + `effort` options | yes, when the model is a bare `claude-*` id |
| acp-proxy (local runtime) | not applied (the local agent owns its model) | no |
| CF SessionDO | agent level only | no (session override is Node-only) |
