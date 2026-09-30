// Write-ahead tool execution + step checkpoints in the default harness
// (docs/durable-execution.md). Runs the real DefaultHarness against a mock
// model with an in-memory event log standing in for the runtime.

import { describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { DefaultHarness } from '../../agent/src/harness/default-loop';
import type { HarnessContext } from '../../agent/src/harness/interface';
import { eventsToMessages } from '../../agent/src/runtime/history';
import { reconcileOrphanedToolCalls, resetInflightToolCallsForTest } from '../../agent/src/harness/durable-tools';
import { recoverInterruptedState } from '@open-managed-agents/session-runtime';
import { InMemoryEventLog, InMemoryStreamRepo } from '@open-managed-agents/event-log/memory';
import type { SessionEvent } from '@open-managed-agents/shared';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function stream(parts: unknown[]) { return new ReadableStream({ start(c) { parts.forEach((p) => c.enqueue(p)); c.close(); } }); }
const finish = (unified: string) => ({ type: 'finish', finishReason: { unified, raw: unified }, usage });

type Ev = Record<string, any>;

function makeRuntime(initial: Ev[]) {
  const events: Ev[] = initial.map((e) => ({ ...e }));
  const persisted: Ev[] = [];
  const runtime = {
    history: { getEvents: () => events.slice() },
    broadcast: vi.fn((e: Ev) => { events.push(e); }),
    persist: vi.fn(async (e: Ev) => { await Promise.resolve(); events.push(e); persisted.push(e); }),
    broadcastStreamStart: vi.fn(async () => {}), broadcastStreamEnd: vi.fn(async () => {}), broadcastChunk: vi.fn(async () => {}),
    broadcastThinkingStart: vi.fn(async () => {}), broadcastThinkingChunk: vi.fn(async () => {}), broadcastThinkingEnd: vi.fn(async () => {}),
    broadcastToolInputStart: vi.fn(async () => {}), broadcastToolInputChunk: vi.fn(async () => {}), broadcastToolInputEnd: vi.fn(async () => {}),
  };
  return { events, persisted, runtime };
}

function ctxFor(runtime: unknown, model: unknown, tools: Record<string, unknown>): HarnessContext {
  return {
    agent: { id: 'agent-test', model: 'test', tools: [] }, model, systemPrompt: 'Test', env: {},
    session_id: 'sess-1',
    userMessage: { type: 'user.message', content: [{ type: 'text', text: 'go' }] },
    tools, runtime,
  } as unknown as HarnessContext;
}

const USER: Ev = { type: 'user.message', content: [{ type: 'text', text: 'Check the repo and fix it' }] };

describe('write-ahead tool execution', () => {
  it('persists text before tool_use, tool_use before execute, result right after; no double emission', async () => {
    const { events, runtime } = makeRuntime([USER]);
    const seenAtExecute: Record<string, string[]> = {};
    const snapshot = () => events.map((e) => `${e.type}:${e.id ?? e.tool_use_id ?? ''}`);
    const bash = vi.fn(async () => { seenAtExecute.bash = snapshot(); return 'pushed'; });
    const read = vi.fn(async () => { seenAtExecute.read = snapshot(); return 'file body'; });
    let call = 0;
    const model = new MockLanguageModelV3({
      doStream: async () => ({ stream: stream(++call === 1 ? [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Let me look.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-call', toolCallId: 'toolu_A', toolName: 'bash', input: '{"command":"git push"}' },
        { type: 'tool-call', toolCallId: 'toolu_B', toolName: 'read', input: '{"file_path":"/a"}' },
        finish('tool-calls'),
      ] : [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' }, { type: 'text-delta', id: 't2', delta: 'Done.' }, { type: 'text-end', id: 't2' },
        finish('stop'),
      ]) }),
    });
    const tools = {
      bash: tool({ inputSchema: z.object({ command: z.string() }), execute: bash }),
      read: tool({ inputSchema: z.object({ file_path: z.string() }), execute: read }),
    };
    await new DefaultHarness().run(ctxFor(runtime, model, tools));

    // Write-ahead: at execute time the tool's own tool_use (and the step's
    // preceding text) is already in the log, its result is not.
    expect(seenAtExecute.bash).toContain('agent.tool_use:toolu_A');
    expect(seenAtExecute.bash).not.toContain('agent.tool_result:toolu_A');
    expect(seenAtExecute.bash.indexOf('agent.message:')).toBeLessThan(seenAtExecute.bash.indexOf('agent.tool_use:toolu_A'));
    expect(seenAtExecute.read).toContain('agent.tool_use:toolu_B');

    // Durable path used for intent + results.
    const persistedTypes = (runtime.persist.mock.calls as Ev[][]).map(([e]) => `${e.type}:${e.id ?? e.tool_use_id ?? ''}`);
    expect(persistedTypes).toEqual(expect.arrayContaining([
      'agent.tool_use:toolu_A', 'agent.tool_use:toolu_B', 'agent.tool_result:toolu_A', 'agent.tool_result:toolu_B',
    ]));

    // Exactly once each.
    const count = (pred: (e: Ev) => boolean) => events.filter(pred).length;
    for (const id of ['toolu_A', 'toolu_B']) {
      expect(count((e) => e.type === 'agent.tool_use' && e.id === id)).toBe(1);
      expect(count((e) => e.type === 'agent.tool_result' && e.tool_use_id === id)).toBe(1);
    }
    expect(count((e) => e.type === 'agent.message')).toBe(2);
    expect(bash).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();

    // Ordering within the step: text, then both tool_uses.
    const order = events.filter((e) => ['agent.message', 'agent.tool_use'].includes(e.type)).map((e) => e.type === 'agent.message' ? `msg:${e.content[0].text}` : e.id);
    expect(order).toEqual(['msg:Let me look.', 'toolu_A', 'toolu_B', 'msg:Done.']);

    // Durable metadata.
    const useA = events.find((e) => e.id === 'toolu_A')!;
    const useB = events.find((e) => e.id === 'toolu_B')!;
    expect(useA).toMatchObject({ idempotency_key: 'sess-1:toolu_A', execution_class: 'side_effect' });
    expect(useB).toMatchObject({ idempotency_key: 'sess-1:toolu_B', execution_class: 'idempotent' });
    const firstMsg = events.find((e) => e.type === 'agent.message')!;
    expect(useA.model_request_start_id).toBeTruthy();
    expect(useA.model_request_start_id).toBe(firstMsg.model_request_start_id);
    expect(useB.model_request_start_id).toBe(useA.model_request_start_id);

    // History projection round-trip.
    const msgs = eventsToMessages(events as SessionEvent[]);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect((msgs[1].content as Ev[]).map((p) => p.type)).toEqual(['text', 'tool-call', 'tool-call']);
    expect((msgs[2].content as Ev[]).map((p) => p.toolCallId).sort()).toEqual(['toolu_A', 'toolu_B']);
  });

  it('crash between tool_use persist and result → recovery by class; resume re-executes idempotent, not side effects', async () => {
    // Run 1: both tools start, the process "dies" before either returns.
    const { events: crashed, runtime } = makeRuntime([USER]);
    const never = () => new Promise<string>(() => {});
    const model1 = new MockLanguageModelV3({
      doStream: async () => ({ stream: stream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'toolu_A', toolName: 'bash', input: '{"command":"git push"}' },
        { type: 'tool-call', toolCallId: 'toolu_B', toolName: 'read', input: '{"file_path":"/a"}' },
        finish('tool-calls'),
      ]) }),
    });
    const bash1 = vi.fn(never);
    const read1 = vi.fn(never);
    void new DefaultHarness().run(ctxFor(runtime, model1, {
      bash: tool({ inputSchema: z.object({ command: z.string() }), execute: bash1 }),
      read: tool({ inputSchema: z.object({ file_path: z.string() }), execute: read1 }),
    }));
    await vi.waitFor(() => { expect(bash1).toHaveBeenCalled(); expect(read1).toHaveBeenCalled(); });
    // Snapshot = what survived in the durable log at the moment of the crash.
    const durable = crashed.map((e) => ({ ...e, session_thread_id: 'sthr_primary' }));
    expect(durable.filter((e) => e.type === 'agent.tool_use').map((e) => e.id)).toEqual(['toolu_A', 'toolu_B']);
    expect(durable.some((e) => e.type === 'agent.tool_result')).toBe(false);

    // A real crash wipes the process-wide in-flight registry.
    resetInflightToolCallsForTest();

    // Cold-start recovery (CF defers idempotent calls for the harness).
    const log = new InMemoryEventLog(() => {});
    for (const e of durable) log.append(e as SessionEvent);
    const report = await recoverInterruptedState(new InMemoryStreamRepo(), log, { deferIdempotent: true });
    expect(report.injectedToolResults).toEqual(['toolu_A']);
    expect(report.pendingReexecution).toEqual(['toolu_B']);
    const bashResult = (log.getEvents() as Ev[]).find((e) => e.tool_use_id === 'toolu_A')!;
    expect(bashResult).toMatchObject({ is_error: true });
    expect(bashResult.content).toContain('sess-1:toolu_A');

    // Run 2 (turn resume): starts from the log. Idempotent read is
    // re-executed before the model call; bash is NOT re-run; the user
    // message is not duplicated.
    const { events: resumed, runtime: rt2 } = makeRuntime(log.getEvents() as Ev[]);
    const bash2 = vi.fn(async () => 'SHOULD NOT RUN');
    const read2 = vi.fn(async () => 'file body');
    let prompt: Ev[] = [];
    const model2 = new MockLanguageModelV3({
      doStream: async (opts: Ev) => { prompt = opts.prompt; return { stream: stream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: 'Verified push state.' }, { type: 'text-end', id: 't' },
        finish('stop'),
      ]) }; },
    });
    await new DefaultHarness().run(ctxFor(rt2, model2, {
      bash: tool({ inputSchema: z.object({ command: z.string() }), execute: bash2 }),
      read: tool({ inputSchema: z.object({ file_path: z.string() }), execute: read2 }),
    }));
    expect(bash2).not.toHaveBeenCalled();
    expect(read2).toHaveBeenCalledOnce();
    expect(read2.mock.calls[0][0]).toEqual({ file_path: '/a' });
    expect(resumed.filter((e) => e.type === 'agent.tool_result' && e.tool_use_id === 'toolu_B')).toHaveLength(1);
    expect(resumed.find((e) => e.type === 'agent.tool_result' && e.tool_use_id === 'toolu_B')!.content).toBe('file body');
    expect(prompt.filter((m) => m.role === 'user')).toHaveLength(1);
    const toolMsgs = prompt.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(1);
    expect(toolMsgs[0].content.map((p: Ev) => p.toolCallId).sort()).toEqual(['toolu_A', 'toolu_B']);
    expect(resumed.some((e) => e.type === 'session.warning' && e.source === 'tool_call_recovered')).toBe(true);
  });

  it('reconcile leaves client-owned orphans (custom tool / ask) alone', async () => {
    const persisted: Ev[] = [];
    const report = await reconcileOrphanedToolCalls({
      events: [
        USER,
        { type: 'agent.custom_tool_use', id: 'c1', name: 'send_email', input: {}, execution_class: 'client' },
        { type: 'agent.tool_use', id: 'a1', name: 'bash', input: {}, evaluated_permission: 'ask' },
      ] as SessionEvent[],
      tools: { send_email: tool({ inputSchema: z.object({}) }) },
      sessionId: 'sess-1',
      persist: async (e) => { persisted.push(e as Ev); },
      resultEvents: () => [],
    });
    expect(report.reexecuted).toEqual([]);
    expect(report.injected).toEqual([]);
    expect(persisted).toEqual([]);
  });
});

describe('history projection with write-ahead ordering', () => {
  it('keeps one step in one assistant message when results interleave with tool_uses', () => {
    const step = 'sevt-step1';
    const events = [
      USER,
      { type: 'agent.message', content: [{ type: 'text', text: 'Looking' }], model_request_start_id: step },
      { type: 'agent.tool_use', id: 'A', name: 'read', input: {}, model_request_start_id: step },
      { type: 'agent.tool_result', tool_use_id: 'A', content: 'a' },
      { type: 'agent.tool_use', id: 'B', name: 'grep', input: {}, model_request_start_id: step },
      { type: 'agent.tool_result', tool_use_id: 'B', content: 'b' },
      { type: 'agent.tool_use', id: 'C', name: 'glob', input: {}, model_request_start_id: 'sevt-step2' },
      { type: 'agent.tool_result', tool_use_id: 'C', content: 'c' },
    ] as SessionEvent[];
    const msgs = eventsToMessages(events);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
    expect((msgs[1].content as Ev[]).map((p) => p.toolCallId ?? p.type)).toEqual(['text', 'A', 'B']);
    expect((msgs[2].content as Ev[]).map((p) => p.toolCallId)).toEqual(['A', 'B']);
    expect((msgs[3].content as Ev[]).map((p) => p.toolCallId)).toEqual(['C']);
  });

  it('legacy events without step ids keep the old grouping', () => {
    const events = [
      USER,
      { type: 'agent.tool_use', id: 'A', name: 'read', input: {} },
      { type: 'agent.tool_result', tool_use_id: 'A', content: 'a' },
      { type: 'agent.tool_use', id: 'B', name: 'read', input: {} },
      { type: 'agent.tool_result', tool_use_id: 'B', content: 'b' },
    ] as SessionEvent[];
    expect(eventsToMessages(events).map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool']);
  });
});
