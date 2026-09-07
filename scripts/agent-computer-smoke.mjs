#!/usr/bin/env node
/**
 * Live HTTP smoke test for an agent's persistent Daytona computer.
 *
 * OMA_BASE_URL=https://your-test-deployment.example \
 * OMA_API_KEY=... node scripts/agent-computer-smoke.mjs /tmp/computer-evidence.json
 *
 * Optional: OMA_SMOKE_MODEL (claude-sonnet-4-6), OMA_SMOKE_MODEL_CARD_ID,
 * OMA_SMOKE_IDLE_MINUTES (10), OMA_SMOKE_TIMEOUT_MS (900000),
 * OMA_SMOKE_IMAGE (node:22-bookworm), OMA_SMOKE_SNAPSHOT.
 *
 * Creates one uniquely named agent/environment and three sessions. Uses a
 * real model + cloud computer, so normal provider charges apply. Disconnects
 * SSE during a sleep, checks the shared browser/filesystem and downloadable
 * artifacts, then verifies a second session and a stop/start cycle retain
 * the same computer. Stops the test computer when idle; records remain for
 * review. Never modifies or deletes pre-existing agents/environments.
 */
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const delay = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const iso = () => new Date().toISOString();
const API_TOOL_TYPES = new Set(['agent.tool_use', 'agent.custom_tool_use']);

export function normalizeEvent(envelope) {
  const payload = typeof envelope.data === 'string' ? JSON.parse(envelope.data)
    : envelope.data && typeof envelope.data === 'object' ? envelope.data : envelope;
  return { ...payload, seq: envelope.seq ?? payload.seq, created_at: envelope.created_at ?? payload.created_at };
}

export function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(block => block.type === 'text' ? block.text ?? '' : '').join('\n');
  return content && typeof content === 'object' ? JSON.stringify(content) : '';
}

export function toolPairs(events) {
  return events.filter(event => API_TOOL_TYPES.has(event.type)).map(use => ({
    use,
    result: events.find(event => event.type === 'agent.tool_result' && event.tool_use_id === use.id),
  }));
}

function evidenceEvent(event) {
  // Browser screenshots can contain megabytes of base64. Keep useful text
  // and image metadata; the screenshot endpoint is separately hash-checked.
  const copy = { ...event };
  if (Array.isArray(copy.content)) copy.content = copy.content.map(block => block.type === 'image'
    ? { type: 'image', media_type: block.source?.media_type, base64_length: block.source?.data?.length ?? 0 }
    : block);
  return copy;
}

export async function runSmoke(options) {
  const { apiKey, fetchImpl = fetch, wait = delay } = options;
  assert(apiKey, 'OMA_API_KEY is required');
  const base = new URL(options.baseUrl);
  assert(['https:', 'http:'].includes(base.protocol), 'OMA_BASE_URL must use HTTP or HTTPS');
  assert(!base.username && !base.password && !base.search && !base.hash, 'OMA_BASE_URL must not contain credentials, a query, or a fragment');
  const baseUrl = base.href.replace(/\/+$/, '');
  const outputPath = resolve(options.outputPath);
  const timeoutMs = options.timeoutMs ?? 900_000;
  const idleMinutes = options.idleMinutes ?? 10;
  assert(Number.isFinite(timeoutMs) && timeoutMs >= 30_000, 'Timeout must be at least 30000 ms');
  assert(Number.isFinite(idleMinutes) && idleMinutes >= 1, 'Idle stop minutes must be positive');
  const runId = `computer-smoke-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const marker = `OMA_COMPUTER_${randomUUID().replaceAll('-', '')}`;
  const markerPath = `/workspace/${runId}.txt`;
  const htmlPath = `/workspace/${runId}.html`;
  const filename = 'computer-smoke-result.txt';
  const record = {
    runId, startedAt: iso(), baseUrl, outputPath, status: 'running',
    resources: { agentId: null, environmentId: null, sessions: [] },
    settings: { model: options.model ?? 'claude-sonnet-4-6', idleMinutes, timeoutMs },
    marker, markerPath, htmlPath, steps: [], requests: [], turns: [], checks: {},
    machineIdentity: { comparedFields: ['id', 'generation'], providerRef: 'Not exposed by the public API' },
    cleanup: { stopped: false, retainedRecords: true },
  };
  const redact = text => text.replaceAll(apiKey, '[REDACTED]');
  async function save() {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, redact(JSON.stringify(record, null, 2)) + '\n', { mode: 0o600 });
  }
  async function step(name, detail = {}) {
    const entry = { at: iso(), name, ...detail };
    record.steps.push(entry);
    console.log(`[${entry.at}] ${name}${Object.keys(detail).length ? ` ${redact(JSON.stringify(detail))}` : ''}`);
    await save();
  }
  async function request(path, { method = 'GET', body, signal, accept = 'application/json', allowed = [] } = {}) {
    const entry = { method, path, startedAt: iso() };
    record.requests.push(entry);
    const started = Date.now();
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers: { 'x-api-key': apiKey, Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ?? AbortSignal.timeout(Math.min(timeoutMs, 240_000)),
      });
      entry.status = response.status;
      if (!response.ok && !allowed.includes(response.status)) {
        throw new Error(`${method} ${path} returned ${response.status}: ${redact((await response.text()).slice(0, 2000))}`);
      }
      return response;
    } finally { entry.durationMs = Date.now() - started; entry.finishedAt = iso(); }
  }
  async function json(path, init) {
    const response = await request(path, init);
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  const post = (path, body = {}) => json(path, { method: 'POST', body });
  const agentPath = () => `/v1/agents/${encodeURIComponent(record.resources.agentId)}`;
  const sessionPath = id => `/v1/sessions/${encodeURIComponent(id)}`;
  const machine = async () => (await json(`${agentPath()}/machine`)).machine;

  async function createSession(label) {
    const session = await post('/v1/sessions', {
      agent: record.resources.agentId, environment_id: record.resources.environmentId,
      title: `${runId}: ${label}`, metadata: { smoke_run_id: runId, smoke_stage: label },
    });
    assert(session?.id, 'Session creation returned no id');
    record.resources.sessions.push(session.id);
    await step('session_created', { label, sessionId: session.id });
    return session.id;
  }

  async function pollTurn(sessionId, turn) {
    const deadline = Date.now() + timeoutMs;
    let afterSeq = 0;
    let seenRunning = false;
    while (Date.now() < deadline) {
      const page = await json(`${sessionPath(sessionId)}/events?order=asc&limit=1000&after_seq=${afterSeq}`);
      const incoming = (page?.data ?? []).map(normalizeEvent);
      for (const event of incoming) {
        if (Number.isFinite(event.seq)) afterSeq = Math.max(afterSeq, event.seq);
        if (event.type === 'session.status_running') seenRunning = true;
        turn.events.push(evidenceEvent(event));
        if (event.type === 'session.error' || event.type === 'session.status_terminated') {
          throw new Error(`Session ${sessionId} failed: ${contentText(event.error ?? event.reason ?? event).slice(0, 2000)}`);
        }
        if (seenRunning && event.type === 'session.status_idle') {
          assert(!event.stop_reason || event.stop_reason.type === 'end_turn', `Turn stopped before completion: ${JSON.stringify(event.stop_reason)}`);
          turn.completedAt = iso();
          turn.idleSeq = event.seq;
          await step('turn_completed', { sessionId, eventCount: turn.events.length });
          return turn.events;
        }
      }
      assert(incoming.length === 0 || Number.isFinite(incoming.at(-1).seq), 'Event API omitted sequence numbers; safe pagination is unavailable');
      await save();
      if (incoming.length < 1000) await wait(2_000);
    }
    throw new Error(`Session ${sessionId} did not complete within ${timeoutMs} ms`);
  }

  async function disconnectDuringSleep(sessionId, turn) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Timed out waiting for the sleep command')), Math.min(timeoutMs, 720_000));
    let reader;
    try {
      const response = await request(`${sessionPath(sessionId)}/events/stream?include=chunks&replay=1`, { signal: controller.signal, accept: 'text/event-stream' });
      assert(response.headers.get('content-type')?.includes('text/event-stream'), 'Expected an SSE response');
      assert(response.body, 'SSE response had no body');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffered = '';
      let seenRunning = false;
      for (;;) {
        const chunk = await reader.read();
        assert(!chunk.done, 'SSE ended before the sleep command started');
        buffered += decoder.decode(chunk.value, { stream: true }).replaceAll('\r\n', '\n');
        let separator;
        while ((separator = buffered.indexOf('\n\n')) !== -1) {
          const frame = buffered.slice(0, separator);
          buffered = buffered.slice(separator + 2);
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const event = normalizeEvent(JSON.parse(data));
          if (event.type === 'session.status_running') seenRunning = true;
          if (event.type === 'session.error') throw new Error(`Session error before disconnect: ${contentText(event.error)}`);
          if (API_TOOL_TYPES.has(event.type) && event.name === 'bash' && /\bsleep\s+15\b/.test(JSON.stringify(event.input))) {
            turn.disconnectedAt = iso();
            turn.disconnectedAfterSeq = event.seq;
            turn.disconnectedToolId = event.id;
            controller.abort();
            await reader.cancel().catch(() => {});
            // Verify this was a live disconnect, not replay of an already
            // completed turn. Then leave every HTTP connection closed.
            const state = await json(sessionPath(sessionId));
            turn.statusAtDisconnect = state.status;
            assert.equal(state.status, 'running', 'The turn had already stopped before the disconnect check');
            await step('sse_disconnected_while_running', { sessionId, toolUseId: event.id, offlineSeconds: 20 });
            await wait(20_000);
            turn.reconnectedAt = iso();
            await step('polling_resumed_after_offline_window', { sessionId });
            return;
          }
          if (seenRunning && event.type === 'session.status_idle') throw new Error('Turn ended before the required sleep-15 bash command was observed');
        }
      }
    } finally {
      clearTimeout(timeout);
      controller.abort();
      await reader?.cancel().catch(() => {});
    }
  }

  async function sendTurn(sessionId, prompt, disconnect = false) {
    const turn = { sessionId, sentAt: iso(), prompt, events: [] };
    record.turns.push(turn);
    await post(`${sessionPath(sessionId)}/events`, { events: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }] });
    await step('message_accepted', { sessionId });
    if (disconnect) await disconnectDuringSleep(sessionId, turn);
    const events = await pollTurn(sessionId, turn);
    const pairs = toolPairs(events);
    const successful = name => pairs.filter(pair => pair.use.name === name && pair.result && !pair.result.is_error);
    assert(successful('bash').length > 0, 'The agent did not complete a real bash tool call');
    assert(successful('browser_navigate').some(pair => JSON.stringify(pair.use.input).includes(`file://${htmlPath}`)), 'The browser did not navigate to the HTML file inside this computer');
    assert(successful('browser_get_text').some(pair => contentText(pair.result.content).includes(marker)), 'The browser did not read the marker from the local HTML file');
    if (disconnect) {
      const sleep = pairs.find(pair => pair.use.id === turn.disconnectedToolId);
      assert(sleep?.result && !sleep.result.is_error, 'The command did not complete after SSE disconnected');
      assert(sleep.result.seq > turn.disconnectedAfterSeq, 'No persisted tool result followed the disconnect event');
      assert(turn.idleSeq > turn.disconnectedAfterSeq, 'No persisted turn completion followed the disconnect event');
      record.checks.continuedAfterDisconnect = true;
    } else {
      assert(successful('bash').some(pair => contentText(pair.result.content).includes(marker)), 'The second session could not read the persisted workspace marker');
    }
    const listing = await json(`${sessionPath(sessionId)}/outputs`);
    assert(listing.data?.some(file => file.filename === filename), `Output ${filename} is missing from the Files API`);
    const downloaded = await (await request(`${sessionPath(sessionId)}/outputs/${filename}`)).text();
    assert(downloaded.includes(marker), 'Downloaded output does not contain the expected marker');
    turn.download = { filename, bytes: Buffer.byteLength(downloaded), sha256: createHash('sha256').update(downloaded).digest('hex'), markerMatched: true };
    await step('tools_and_download_verified', { sessionId });
    return turn;
  }

  const readPrompt = sessionId => `Use the real tools to verify the retained computer. First use bash to run cat ${markerPath}; do not recreate or overwrite that file or ${htmlPath}. Then use browser_navigate to open file://${htmlPath} and browser_get_text to read the page. Copy the exact marker read from that file into /mnt/sessions/${sessionId}/outputs/${filename} using bash or write. Report completion briefly. The existing marker must be read from disk, not inferred.`;

  try {
    await step('smoke_started');
    const environment = await post('/v1/environments', {
      name: `${runId}-environment`, metadata: { smoke_run_id: runId },
      config: { type: 'cloud', networking: { type: 'unrestricted' }, sandbox: {
        provider: 'daytona', scope: 'agent', image: options.image ?? 'node:22-bookworm',
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        workdir: '/workspace', ephemeral: false, bootstrap_tools: true,
        browser: true, idle_stop_minutes: idleMinutes, sdk_mode: 'off',
      } },
    });
    assert(environment?.id, 'Environment creation returned no id');
    record.resources.environmentId = environment.id;
    await step('environment_created', { environmentId: environment.id });
    const agent = await post('/v1/agents', {
      name: runId, harness: 'default', model: record.settings.model,
      ...(options.modelCardId ? { model_card_id: options.modelCardId } : {}),
      system: 'You are running a computer integration test. Execute the requested tools exactly, using the cloud computer provided. Do not substitute web_fetch for browser tools. Do not ask questions. Complete the requested file and browser checks, save the output file, and stop. If a tool fails, report the failure honestly.',
      tools: [{ type: 'agent_toolset_20260401', default_config: { enabled: true }, configs: [{ name: 'browser', enabled: true }] }],
      metadata: { smoke_run_id: runId, purpose: 'agent-computer-integration-test' },
    });
    assert(agent?.id, 'Agent creation returned no id');
    record.resources.agentId = agent.id;
    await step('agent_created', { agentId: agent.id });
    const first = await createSession('disconnected browser task');
    const html = `<!doctype html><html><head><title>${runId}</title></head><body><h1>${marker}</h1><p>Shared Linux filesystem and Chromium verified.</p></body></html>`;
    const command = `sleep 15; printf '%s\\n' '${marker}' > '${markerPath}'; printf '%s' '${html}' > '${htmlPath}'; cat '${markerPath}'`;
    await sendTurn(first, `This is a live disconnect test. Your FIRST tool call must be bash with exactly this command: ${command}\nAfter it finishes, use browser_navigate to open file://${htmlPath}, then browser_get_text to read the page. Write the exact marker seen in the page to /mnt/sessions/${first}/outputs/${filename} using bash or write. Finish with one sentence. Keep working if the client disconnects.`, true);
    const originalMachine = await machine();
    assert(originalMachine?.state === 'running' && originalMachine.browserEnabled, 'Expected a running computer with its browser enabled');
    record.machineIdentity.first = originalMachine;
    const png = Buffer.from(await (await request(`${agentPath()}/machine/screenshot`, { accept: 'image/png' })).arrayBuffer());
    assert(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'Screenshot endpoint did not return a PNG');
    const screenshotPath = outputPath.replace(/\.json$/i, '') + '.png';
    await writeFile(screenshotPath, png);
    record.screenshot = { path: screenshotPath, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') };
    const second = await createSession('same computer next session');
    await sendTurn(second, readPrompt(second));
    record.machineIdentity.second = await machine();
    assert.equal(record.machineIdentity.second.id, originalMachine.id, 'Second session received a different computer');
    assert.equal(record.machineIdentity.second.generation, originalMachine.generation, 'Second session recreated the computer');
    record.checks.sharedAcrossSessions = true;
    const stopped = await post(`${agentPath()}/machine/stop`);
    assert.equal(stopped.machine?.state, 'stopped', 'Computer did not stop');
    record.machineIdentity.stopped = stopped.machine;
    await step('computer_stopped_for_persistence_check');
    const started = await post(`${agentPath()}/machine/start`);
    assert.equal(started.machine?.state, 'running', 'Computer did not restart');
    assert.equal(started.machine.id, originalMachine.id, 'Restart changed the computer id');
    assert.equal(started.machine.generation, originalMachine.generation, 'Restart recreated the disk instead of retaining it');
    record.machineIdentity.restarted = started.machine;
    const third = await createSession('files after stop and start');
    await sendTurn(third, readPrompt(third));
    record.checks.persistedAfterStopStart = true;
    record.status = 'passed';
    await step('all_checks_passed');
  } catch (error) {
    record.status = 'failed';
    record.error = redact(error instanceof Error ? error.message : String(error));
    await step('smoke_failed', { error: record.error });
  } finally {
    if (record.resources.agentId) {
      try {
        const response = await request(`${agentPath()}/machine/stop`, { method: 'POST', body: {}, allowed: [409] });
        const body = await response.json();
        if (response.status === 409) {
          record.cleanup = { stopped: false, retainedRecords: true, reason: 'Test computer is still busy; no running work was interrupted.', code: body.code };
        } else {
          record.cleanup.stopped = !body.machine || body.machine.state === 'stopped';
          record.cleanup.machine = body.machine;
        }
      } catch (error) { record.cleanup.error = redact(error instanceof Error ? error.message : String(error)); }
    }
    record.finishedAt = iso();
    await save();
    console.log(`[${record.finishedAt}] ${record.status.toUpperCase()} Evidence: ${outputPath}`);
    if (!record.cleanup.stopped && record.resources.agentId) console.log('Test computer could not be stopped automatically; review cleanup in the evidence file.');
  }
  return record;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--help')) {
    console.log('Usage: OMA_BASE_URL=https://test.example OMA_API_KEY=... node scripts/agent-computer-smoke.mjs /tmp/computer-evidence.json\nCreates a test agent, cloud computer and three sessions; stops the computer after testing. See the file header for optional settings.');
  } else {
    try {
      assert(process.env.OMA_BASE_URL, 'OMA_BASE_URL is required');
      const result = await runSmoke({
        baseUrl: process.env.OMA_BASE_URL, apiKey: process.env.OMA_API_KEY,
        outputPath: process.argv[2] ?? `./agent-computer-evidence-${Date.now()}.json`,
        model: process.env.OMA_SMOKE_MODEL, modelCardId: process.env.OMA_SMOKE_MODEL_CARD_ID,
        image: process.env.OMA_SMOKE_IMAGE, snapshot: process.env.OMA_SMOKE_SNAPSHOT,
        idleMinutes: process.env.OMA_SMOKE_IDLE_MINUTES ? Number(process.env.OMA_SMOKE_IDLE_MINUTES) : undefined,
        timeoutMs: process.env.OMA_SMOKE_TIMEOUT_MS ? Number(process.env.OMA_SMOKE_TIMEOUT_MS) : undefined,
      });
      if (result.status !== 'passed' || !result.cleanup.stopped) process.exitCode = 1;
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
