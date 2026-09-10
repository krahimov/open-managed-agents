/** Opt-in live acceptance. Run with MODAL_TOKEN_ID/SECRET and OMA_MODAL_SMOKE_DIR.
 * Optional OMA_MODAL_SMOKE_CODEX=1 runs Orrery's real Codex harness and tools.
 * Credentials and artifacts belong outside the repository. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentMachineManager } from '@open-managed-agents/sandbox/machines/manager';
import { InMemoryAgentMachineStore, type AgentMachineSpec } from '@open-managed-agents/sandbox/machines';
import { createModalMachineDriver, sandboxFactory } from '@open-managed-agents/sandbox/adapters/modal';
import { bootstrapAgentComputer, resolveAgentComputerBrowser } from '@open-managed-agents/sandbox/machines/browser';
import { createSandboxBrowserHarness } from '@open-managed-agents/browser-harness/sandbox';
import { buildBrowserTools, buildComputerTools } from '@open-managed-agents/browser-harness';
import { CodexSdkHarness } from '../src/lib/codex-sdk-harness';

const dir = process.env.OMA_MODAL_SMOKE_DIR;
if (!dir || !path.isAbsolute(dir) || !process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) throw new Error('Set an absolute OMA_MODAL_SMOKE_DIR and Modal credentials');
await mkdir(dir, { recursive: true, mode: 0o700 });
const tenantId = 'modal-smoke', agentId = `agent-${randomUUID()}`, sessionId = `sess-${randomUUID()}`;
const store = new InMemoryAgentMachineStore();
const env = { ...process.env, SANDBOX_SCOPE: 'agent', MODAL_APP_NAME: process.env.MODAL_APP_NAME ?? 'orrery-modal-branch-smoke' };
const driver = createModalMachineDriver(env);
const manager = new AgentMachineManager({ store, drivers: { modal: driver }, bootstrap: bootstrapAgentComputer, browserEndpoint: resolveAgentComputerBrowser, tickIntervalMs: 0 });
const spec: AgentMachineSpec = { provider: 'modal', image: 'node:22-bookworm', workdir: '/workspace', aptPackages: ['python3','git','jq','ripgrep'], bootstrapTools: true, browser: true, desktop: true, idleStopMinutes: 5, sdkMode: 'off' };
const sb = await sandboxFactory({ sessionId, workdir: dir, tenantId, agentId, machines: { tenantId, agentId, manager, spec } }, env);
const browser = createSandboxBrowserHarness(sb);
const ids = new Set<string>();
const report: Record<string, unknown> = { startedAt: new Date().toISOString(), agentId, app: env.MODAL_APP_NAME };
const save = async () => writeFile(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
try {
  console.log('Starting Modal computer through Orrery manager');
  const started = Date.now();
  await sb.writeFile('/workspace/retained.txt', 'retained through Modal snapshot');
  let box = (await manager.getBox(tenantId, agentId))!; ids.add(box.sb.id);
  report.startupSeconds = (Date.now() - started) / 1000; report.sandboxIds = [...ids]; await save();
  console.log('Computer ready; testing browser and private desktop');
  const view = await browser.launch(); const page = await view.page();
  const sites = [];
  for (const url of ['https://example.com','https://github.com','https://www.google.com','https://duckduckgo.com']) {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    sites.push({ url, status: response?.status?.() }); assert.equal(response?.status?.(), 200);
  }
  report.sites = sites;
  await box.sb.computerUse!.keyboard.press('l', ['ctrl']);
  await box.sb.computerUse!.keyboard.type('https://example.com');
  await box.sb.computerUse!.keyboard.press('Return');
  for (let i=0; i<40 && !page.url().startsWith('https://example.com'); i++) await new Promise(r => setTimeout(r, 250));
  assert(page.url().startsWith('https://example.com')); report.nativeKeyboard = true;
  await page.goto('https://example.com');
  await page.evaluate(() => { localStorage.setItem('orrery-modal', 'retained'); document.cookie = 'orrery_modal=retained; Max-Age=86400; Path=/; Secure'; });
  const preview = await box.sb.getPreviewLink(6080);
  const desktopUrl = new URL('/vnc.html', preview.url);
  assert.equal((await fetch(desktopUrl)).status, 401);
  assert.equal((await fetch(desktopUrl, { headers: preview.headers })).status, 200);
  report.desktopAuthentication = true;
  await writeFile(path.join(dir, 'desktop.png'), Buffer.from((await box.sb.computerUse!.screenshot.takeFullScreen()).screenshot!, 'base64'));
  await view.close();

  if (process.env.OMA_MODAL_SMOKE_CODEX === '1') {
    console.log('Running the real Orrery Codex harness with cloud-only tools');
    const agent = { id: agentId, name: 'Modal branch acceptance', model: 'gpt-5.6-sol', reasoning_level: 'low' };
    process.env.OMA_CODEX_ALLOWED_AGENTS = `${tenantId}/${agentId}`;
    process.env.SANDBOX_WORKDIR = path.join(dir, 'codex-work');
    const desktop = box.sb.computerUse!;
    const tools = {
      ...buildBrowserTools(browser),
      ...buildComputerTools({ screenshot: async () => (await desktop.screenshot.takeFullScreen()).screenshot!, click: (...a) => desktop.mouse.click(...a), type: text => desktop.keyboard.type(text), press: (key, modifiers) => desktop.keyboard.press(key, modifiers), scroll: (...a) => desktop.mouse.scroll(...a) }),
      bash: tool({ description: 'Execute a shell command on the remote Modal Linux computer.', inputSchema: z.object({ command: z.string() }), execute: async ({command}) => sb.exec(command, 120000) }),
    };
    const events: unknown[] = [];
    const ctx = { agent, session_id: sessionId, tenant_id: tenantId, tools,
      systemPrompt: 'Test only your remote cloud computer. Do not send messages or authenticate external accounts.',
      userMessage: { content: [{type:'text',text:'Use the browser tool to open https://example.com and report its heading. Take a desktop screenshot using the computer tool. Then use bash to write exactly MODAL_AGENT_OK to /workspace/agent-result.txt. Report any failure honestly.'}] },
      runtime: { sandbox: sb, broadcast: (e: unknown) => { events.push(e); }, abortSignal: AbortSignal.timeout(240000) },
    };
    await sb.setTurnActive!(true);
    try { await new CodexSdkHarness().run(ctx as never); }
    finally { await sb.setTurnActive!(false); await writeFile(path.join(dir, 'agent-events.json'), JSON.stringify(events, null, 2)); }
    assert.equal((await sb.readFile('/workspace/agent-result.txt')).trim(), 'MODAL_AGENT_OK');
    report.codexHarness = true;
  }

  console.log('Testing background work and stop/restore persistence');
  const bg = await sb.startProcess!('sleep 5; printf background-ok > /workspace/background.txt'); assert(bg);
  await sb.destroy!();
  await new Promise(r => setTimeout(r, 7000));
  box = (await manager.getBox(tenantId, agentId))!;
  assert.equal((await box.sb.fs.downloadFile('/workspace/background.txt')).toString(), 'background-ok');
  report.backgroundAfterDetach = true;
  await browser.launch().then(v => v.close());
  await manager.stop(tenantId, agentId);
  const stopped = (await manager.get(tenantId, agentId))!; report.snapshot = stopped.snapshot; await save();
  const restored = await manager.start(tenantId, agentId, spec); ids.add(restored.providerRef!);
  report.sandboxIds = [...ids];
  assert.equal(restored.generation, 2);
  box = (await manager.getBox(tenantId, agentId))!;
  assert.equal((await box.sb.fs.downloadFile('/workspace/retained.txt')).toString(), 'retained through Modal snapshot');
  const check = await browser.launch(); const restoredPage = await check.page(); await restoredPage.goto('https://example.com');
  assert.equal(await restoredPage.evaluate(() => localStorage.getItem('orrery-modal')), 'retained');
  assert.match(await restoredPage.evaluate(() => document.cookie), /orrery_modal=retained/);
  await check.close(); report.persistence = true;
  report.completedAt = new Date().toISOString(); console.log('Modal branch acceptance passed');
} catch (error) {
  report.error = String(error); process.exitCode = 1; console.error(String(error));
} finally {
  const row = await manager.get(tenantId, agentId);
  if (row?.providerRef) ids.add(row.providerRef);
  const client = await driver.client();
  // Also cover create-to-database failures by the machine ownership tag.
  if (row) for (const box of (await client.list({ 'oma-machine-id': row.id })).items) ids.add(box.id);
  const cleanupErrors: string[] = [];
  for (const id of ids) try { await (await client.get(id)).stop(); } catch (e) { if (!driver.isNotFound(e)) cleanupErrors.push(String(e)); }
  if (row?.snapshot && row.snapshot !== spec.snapshot) try { await driver.deleteCheckpoint!(row.snapshot); } catch (e) { cleanupErrors.push(String(e)); }
  report.sandboxIds = [...ids]; report.cleanupErrors = cleanupErrors; await save(); await manager.dispose();
  if (cleanupErrors.length) { process.exitCode = 1; console.error('Cleanup requires attention; see report'); }
}
