# Regression → ambient webhook → agent

A webhook ambient rule accepts authenticated events at:

`POST /v1/agents/{agent_id}/ambient-rules/{rule_id}/events`

This receiver is available on Node and Cloudflare. It uses normal session creation,
so the agent's environment, permissions, vaults and memory follow the same path as
an interactive session. The Ambient tab shows the endpoint and latest session.

## Configure the rule

Create a rule through the Ambient tab or API. Use your existing tenant API key
(`x-api-key`); local auth-disabled servers do not require one.

```json
{
  "name": "Production regression",
  "enabled": true,
  "trigger": {
    "source": "webhook",
    "config": {
      "prompt": "Inspect the monitoring window identified in the event data. Diagnose the issue and follow your normal validation and deployment policy."
    }
  },
  "wake_mode": "act",
  "budget": {"max_runs_per_day": 24, "max_concurrent_sessions": 1}
}
```

POST that JSON to `/v1/agents/{agent_id}/ambient-rules`. The returned `id` is the
rule ID. Send an event to its endpoint:

```json
{"event_id":"incident-123","data":{"window_id":"w05","status":"degraded"}}
```

A new accepted event returns 202 with `session_id`. Repeating the same event ID and
JSON data returns 200 and the same session; reusing an ID with different data
returns 409. Deduplication persists across server restarts. The caller cannot
select a different agent or override the session's permissions in event data.

`observe` records an event without starting a session. `decide` and `act` start a
session; `escalate` adds an instruction to report the issue without corrective
action (the agent's actual permission grant remains authoritative). Approval
policies and execution profiles are not implemented for this receiver and return
422 instead of silently executing. `only_when: new_or_updated_signal` uses event
ID deduplication; the sender must reuse the ID for the same signal.

Limits default to 24 admitted events per UTC day and one unfinished session per
rule. A queued idle session still occupies its slot. Budget rejection returns 429
and can be retried with the same event ID. Payloads are limited to 64 KiB.

If dispatch fails after admission, 502 (or a later 409 retry) includes the session
ID when available. Inspect that session before submitting another event ID: a
request may already have executed. Interrupted/failed receipts remain reserved
for reconciliation and do not silently launch duplicate work. An operator can
inspect `ambient_webhook_receipts` in the control-plane SQL database; release an
`active` reservation only after confirming no session is running. Pending receipts
with no session ID also require operator reconciliation after a process crash.
Receipts are retained indefinitely; retain them for the sender's retry horizon if
adding an administrative retention policy.

## Run the demo monitor

The included standard-library Python monitor polls the MLOps demo's `/state`.
It records the current windows on its first poll, then emits an event when a window
becomes degraded or broken. Existing regressions on first startup are baselined.
A model promotion refreshes the baseline because the dashboard re-scores all
historical windows. Run one monitor per state file.

```sh
python3 examples/ambient-webhook/monitor.py \
  --webhook-url "http://localhost:8787/v1/agents/$AGENT_ID/ambient-rules/$RULE_ID/events" \
  --state-file /tmp/mlops-monitor-state.json
```

For authenticated instances export `OMA_API_KEY`. Leave the monitor running, then
inject drift or breakage in the demo. No chat message is needed. The monitor
persists pending alerts and retries transport failures/rate limits with the same
ID. Delivery failures requiring inspection appear in the state file's `failed`
list and in its log.

```sh
python3 -m unittest discover -s examples/ambient-webhook -p 'test_*.py'
pnpm --filter @open-managed-agents/main-node test test/ambient-webhook.test.ts
```
