import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSmoke } from './agent-computer-smoke.mjs';

function fakeDeployment({ browserMatches = true } = {}) {
  let marker;
  let htmlPath;
  let sessionCount = 0;
  let offline = false;
  let disconnected = false;
  let stopCalls = 0;
  const prompts = new Map();
  const machine = { id: 'amch-smoke', generation: 1, state: 'running', browserEnabled: true };
  const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  function events(sessionId) {
    return [
      { type: 'session.status_running' },
      { type: 'agent.tool_use', id: `bash-${sessionId}`, name: 'bash', input: { command: sessionId === 'sess-1' ? 'sleep 15' : 'cat /workspace/marker.txt' } },
      { type: 'agent.tool_result', tool_use_id: `bash-${sessionId}`, content: marker, is_error: false },
      { type: 'agent.tool_use', id: `nav-${sessionId}`, name: 'browser_navigate', input: { url: `file://${htmlPath}` } },
      { type: 'agent.tool_result', tool_use_id: `nav-${sessionId}`, content: 'navigated', is_error: false },
      { type: 'agent.tool_use', id: `text-${sessionId}`, name: 'browser_get_text', input: {} },
      { type: 'agent.tool_result', tool_use_id: `text-${sessionId}`, content: browserMatches ? marker : 'WRONG COMPUTER', is_error: false },
      { type: 'session.status_idle', stop_reason: { type: 'end_turn' } },
    ].map((event, index) => ({ ...event, seq: index + 1 }));
  }
  return {
    async fetchImpl(raw, init) {
      const url = new URL(raw);
      const path = url.pathname;
      const body = init.body ? JSON.parse(init.body) : {};
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
          marker = prompt.match(/OMA_COMPUTER_[a-f0-9]+/)[0];
          htmlPath = prompt.match(/file:\/\/(\/workspace\/[^,\s]+\.html)/)[1];
        }
        return new Response(null, { status: 202 });
      }
      if (path.endsWith('/events/stream')) {
        assert.equal(url.searchParams.get('replay'), '1');
        const encoder = new TextEncoder();
        return new Response(new ReadableStream({
          start(controller) {
            // Initial idle state must not be confused with this turn's end.
            controller.enqueue(encoder.encode('data: {"type":"session.status_idle","seq":0}\n\n'));
            for (const event of events(sessionId).slice(0, 2)) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
            }
          },
          cancel() { disconnected = true; },
        }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (path.endsWith('/events')) {
        assert(disconnected && offline, 'Polling must start after the disconnected offline interval');
        // Exercise the SQL event-log envelope as well as SSE direct events.
        return response({ data: events(sessionId).map(event => ({ seq: event.seq, data: JSON.stringify(event) })) });
      }
      if (path.endsWith('/outputs')) return response({ data: [{ filename: 'computer-smoke-result.txt' }] });
      if (path.endsWith('/outputs/computer-smoke-result.txt')) return new Response(marker);
      if (/\/sessions\/[^/]+$/.test(path)) return response({ status: 'running' });
      throw new Error(`Unexpected fake request ${init.method} ${path}`);
    },
    async wait(ms) { if (ms === 20_000) { assert(disconnected); offline = true; } },
    get stopCalls() { return stopCalls; },
    get prompts() { return prompts; },
  };
}

test('smoke verifies disconnect, three sessions, downloads and retained disk without network', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oma-smoke-test-'));
  try {
    const fake = fakeDeployment();
    const outputPath = join(dir, 'evidence.json');
    const result = await runSmoke({ baseUrl: 'https://unit-test.invalid', apiKey: 'unit-test-secret', outputPath, fetchImpl: fake.fetchImpl, wait: fake.wait });
    assert.equal(result.status, 'passed');
    assert.equal(result.cleanup.stopped, true);
    assert.deepEqual(result.checks, { continuedAfterDisconnect: true, sharedAcrossSessions: true, persistedAfterStopStart: true });
    assert.equal(result.resources.sessions.length, 3);
    assert.equal(fake.stopCalls, 2);
    assert(!fake.prompts.get('sess-2').includes(result.marker), 'Follow-up must read the marker rather than receiving it in the prompt');
    assert(!(await readFile(outputPath, 'utf8')).includes('unit-test-secret'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('smoke rejects browser content from another computer and stops only its test machine', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'oma-smoke-test-'));
  try {
    const fake = fakeDeployment({ browserMatches: false });
    const result = await runSmoke({ baseUrl: 'https://unit-test.invalid', apiKey: 'unit-test-secret', outputPath: join(dir, 'evidence.json'), fetchImpl: fake.fetchImpl, wait: fake.wait });
    assert.equal(result.status, 'failed');
    assert.match(result.error, /browser did not read the marker/);
    assert.equal(result.cleanup.stopped, true);
    assert.equal(fake.stopCalls, 1);
    assert.equal(result.resources.sessions.length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
