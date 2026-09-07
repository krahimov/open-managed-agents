import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSmoke } from './agent-computer-smoke.mjs';

function fakeDeployment({ browserMatches = true, storageLostAt, downloadMatches = true, browserEvalError = false, sseError, pollError } = {}) {
  let marker;
  let htmlPath;
  let sessionCount = 0;
  let offline = false;
  let disconnected = false;
  let stopCalls = 0;
  const prompts = new Map();
  const streams = new Map();
  const requests = [];
  const storageToken = '0ed974fa-8b5b-4982-8f50-65b6490c1d86';
  const machine = { id: 'amch-smoke', generation: 1, state: 'running', browserEnabled: true };
  const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  function events(sessionId) {
    const prompt = prompts.get(sessionId);
    const result = [{ type: 'session.status_running' }];
    function pair(name, input, content) {
      const id = `${name}-${sessionId}-${result.length}`;
      result.push({ type: 'agent.tool_use', id, name, input }, { type: 'agent.tool_result', tool_use_id: id, content, is_error: false });
    }
    pair('bash', { command: sessionId === 'sess-1' ? prompt.match(/exactly this command: ([^\n]+)/)[1] : 'cat /workspace/marker.txt' }, marker);
    pair('browser_navigate', { url: `file://${htmlPath}` }, `Loaded file://${htmlPath} (HTTP ?)`);
    pair('browser_get_text', {}, browserMatches ? marker : 'WRONG COMPUTER');
    const storageExpression = prompt.match(/localStorage: ([^\n]+)/)[1];
    pair('browser_eval', { expression: storageExpression }, browserEvalError ? 'Eval error: storage unavailable' : JSON.stringify(sessionId === storageLostAt ? null : storageToken));
    const downloadExpression = prompt.match(/real browser download: ([^\n]+)/)[1];
    const downloadCommand = prompt.match(/read the downloaded file: ([^\n]+)/)[1];
    const downloadToken = `8470b5db-fd6a-4405-a85d-777dfef6a38${sessionId.at(-1)}`;
    pair('browser_eval', { expression: downloadExpression }, JSON.stringify(downloadToken));
    pair('bash', { command: downloadCommand }, downloadMatches ? downloadToken : 'missing download');
    result.push({ type: 'session.status_idle', stop_reason: { type: 'end_turn' } });
    return result.map((event, index) => ({ ...event, seq: index + 1 }));
  }
  return {
    async fetchImpl(raw, init) {
      const url = new URL(raw);
      const path = url.pathname;
      const body = init.body ? JSON.parse(init.body) : {};
      requests.push(`${init.method} ${path}`);
      assert.equal(init.headers['x-api-key'], 'unit-test-secret');
      if (path === '/v1/environments') {
        assert.equal(body.config.sandbox.scope, 'agent');
        return response({ id: 'env-smoke', status: 'ready' });
      }
      if (path === '/v1/agents') {
        assert.equal(body.harness, 'default');
        assert.deepEqual(body.tools[0].configs, [{ name: 'browser', enabled: true }]);
        return response({ id: 'agent-smoke' });
      }
      if (path === '/v1/sessions') return response({ id: `sess-${++sessionCount}` });
      if (path.endsWith('/machine/stop')) { stopCalls++; machine.state = 'stopped'; return response({ machine }); }
      if (path.endsWith('/machine/start')) { machine.state = 'running'; return response({ machine }); }
      if (path.endsWith('/machine/screenshot')) return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]), { headers: { 'content-type': 'image/png' } });
      if (path.endsWith('/machine')) return response({ machine });
      const sessionId = path.match(/\/sessions\/([^/]+)/)?.[1];
      if (path.endsWith('/events') && init.method === 'POST') {
        const prompt = body.events[0].content[0].text;
        prompts.set(sessionId, prompt);
        if (sessionId === 'sess-1') {
          assert(streams.has(sessionId), 'SSE must be established before the first message is posted');
          marker = prompt.match(/OMA_COMPUTER_[a-f0-9]+/)[0];
          htmlPath = prompt.match(/file:\/\/(\/workspace\/[^,\s]+\.html)/)[1];
          const live = sseError
            ? [{ type: 'session.status_running', seq: 1 }, { type: 'session.error', error: 'harness_turn_failed', message: sseError, seq: 2 }]
            : events(sessionId).slice(0, 2);
          for (const event of live) streams.get(sessionId).enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        }
        return new Response(null, { status: 202 });
      }
      if (path.endsWith('/events/stream')) {
        assert.equal(url.searchParams.get('replay'), '1');
        assert(!prompts.has(sessionId), 'The subscription must not rely on replaying an already-started turn');
        return new Response(new ReadableStream({
          start(controller) {
            streams.set(sessionId, controller);
            // Initial idle state must not be confused with this turn's end.
            controller.enqueue(new TextEncoder().encode('data: {"type":"session.status_idle","seq":0}\n\n'));
          },
          cancel() { disconnected = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path.endsWith('/events')) {
        assert(disconnected && offline, 'Polling must start after the disconnected offline interval');
        const list = pollError
          ? [{ type: 'session.status_running', seq: 1 }, { type: 'session.error', error: 'harness_turn_failed', message: pollError, seq: 2 }]
          : events(sessionId);
        const after = Number(url.searchParams.get('after_seq'));
        const limit = Number(url.searchParams.get('limit'));
        const remaining = list.filter(event => event.seq > after);
        // Exercise the SQL event-log envelope as well as SSE direct events.
        return response({ data: remaining.slice(0, limit).map(event => ({ seq: event.seq, data: JSON.stringify(event) })), has_more: remaining.length > limit });
      }
      if (path.endsWith('/outputs')) return response({ data: [{ filename: 'computer-smoke-result.txt' }] });
      if (path.endsWith('/outputs/computer-smoke-result.txt')) return new Response(marker);
      if (/\/sessions\/[^/]+$/.test(path)) return response({ status: 'running' });
      throw new Error(`Unexpected fake request ${init.method} ${path}`);
    },
    async wait(ms) { if (ms === 20_000) { assert(disconnected); offline = true; } },
    get stopCalls() { return stopCalls; },
    get prompts() { return prompts; },
    get requests() { return requests; },
  };
}

async function smokeWith(fakeOptions, check) {
  const dir = await mkdtemp(join(tmpdir(), 'oma-smoke-test-'));
  try {
    const fake = fakeDeployment(fakeOptions);
    const outputPath = join(dir, 'evidence.json');
    const result = await runSmoke({ baseUrl: 'https://unit-test.invalid', apiKey: 'unit-test-secret', outputPath, fetchImpl: fake.fetchImpl, wait: fake.wait });
    const evidence = await readFile(outputPath, 'utf8');
    assert(!evidence.includes('unit-test-secret'));
    await check(result, fake, JSON.parse(evidence));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('smoke connects SSE before submitting and verifies files, browser storage and downloads across restart', async () => {
  await smokeWith({}, (result, fake) => {
    assert.equal(result.status, 'passed', result.error);
    assert.equal(result.cleanup.stopped, true);
    assert.deepEqual(result.checks, {
      continuedAfterDisconnect: true,
      browserDownloadsVerified: true,
      sharedAcrossSessions: true,
      localStorageSharedAcrossSessions: true,
      persistedAfterStopStart: true,
      localStoragePersistedAfterStopStart: true,
    });
    assert.equal(result.resources.sessions.length, 3);
    assert.equal(fake.stopCalls, 2);
    assert(fake.requests.indexOf('GET /v1/sessions/sess-1/events/stream') < fake.requests.indexOf('POST /v1/sessions/sess-1/events'));
    assert(result.turns.every(turn => turn.browserDownload.verified));
    assert.equal(new Set(result.turns.map(turn => turn.browserDownload.token)).size, 3);
    for (const sessionId of ['sess-2', 'sess-3']) {
      assert(!fake.prompts.get(sessionId).includes(result.marker), 'Follow-up must read the marker rather than receiving it in the prompt');
      assert(!fake.prompts.get(sessionId).includes(result.turns[0].browserState.token), 'Follow-up must read the browser token rather than receiving it in the prompt');
    }
  });
});

test('smoke rejects browser content from another computer and stops only its test machine', async () => {
  await smokeWith({ browserMatches: false }, (result, fake) => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /browser did not read the marker/);
    assert.equal(result.cleanup.stopped, true);
    assert.equal(fake.stopCalls, 1);
    assert.equal(result.resources.sessions.length, 1);
  });
});

test('smoke rejects localStorage lost after stop and start', async () => {
  await smokeWith({ storageLostAt: 'sess-3' }, result => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /localStorage did not return a browser-generated UUID/);
    assert.equal(result.checks.localStorageSharedAcrossSessions, true);
    assert.equal(result.checks.localStoragePersistedAfterStopStart, undefined);
    assert.equal(result.cleanup.stopped, true);
  });
});

test('smoke requires the browser download to reach the shell filesystem', async () => {
  await smokeWith({ downloadMatches: false }, result => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /shell could not read the browser-created download/);
    assert.equal(result.checks.browserDownloadsVerified, undefined);
  });
});

test('smoke rejects browser errors returned as text without an is_error flag', async () => {
  await smokeWith({ browserEvalError: true }, result => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /exact localStorage browser expression successfully/);
  });
});

test('smoke preserves the real SSE failure in saved evidence before polling begins', async () => {
  await smokeWith({ sseError: 'Chromium bootstrap failed: unit-test-secret' }, (result, fake, evidence) => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /harness_turn_failed: Chromium bootstrap failed: \[REDACTED\]/);
    assert.equal(evidence.turns[0].sseEvents.at(-1).message, 'Chromium bootstrap failed: [REDACTED]');
    assert(!fake.requests.includes('GET /v1/sessions/sess-1/events'));
    assert.equal(result.cleanup.stopped, true);
  });
});

test('smoke preserves the real polling failure in saved evidence', async () => {
  await smokeWith({ pollError: 'Model provider request failed: unit-test-secret' }, (result, _fake, evidence) => {
    assert.equal(result.status, 'failed');
    assert.match(result.error, /harness_turn_failed: Model provider request failed: \[REDACTED\]/);
    assert.equal(evidence.turns[0].events.at(-1).message, 'Model provider request failed: [REDACTED]');
    assert.equal(result.cleanup.stopped, true);
  });
});
