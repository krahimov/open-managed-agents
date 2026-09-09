import { describe, expect, it, vi } from 'vitest';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { DefaultHarness } from '../../agent/src/harness/default-loop';
import type { HarnessContext } from '../../agent/src/harness/interface';

const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
function stream(parts: unknown[]) { return new ReadableStream({ start(controller) { parts.forEach(p => controller.enqueue(p)); controller.close(); } }); }

async function runAfterTool(fail: boolean) {
  let call = 0;
  const execute = vi.fn(async () => 'real tool result');
  const broadcast = vi.fn();
  const model = new MockLanguageModelV3({
    doStream: async () => ({ stream: stream(++call === 1 ? [
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'tool-1', toolName: 'bash', input: '{}' },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
    ] : fail ? [
      { type: 'error', error: new Error('Your credit balance is too low to access the Anthropic API') },
    ] : [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'answer' },
      { type: 'text-delta', id: 'answer', delta: 'Finished checking' },
      { type: 'text-end', id: 'answer' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
    ]) }),
  });
  const harness = new DefaultHarness();
  const ctx = {
    agent: { id: 'agent-test', model: 'test', tools: [] }, model, systemPrompt: 'Test', env: {},
    tools: { bash: tool({ inputSchema: z.object({}), execute }) },
    runtime: {
      history: { getEvents: () => [{ type: 'user.message', content: [{ type: 'text', text: 'Check and report' }] }] },
      broadcast, broadcastStreamStart: vi.fn(), broadcastStreamEnd: vi.fn(), broadcastChunk: vi.fn(),
      broadcastThinkingStart: vi.fn(), broadcastThinkingChunk: vi.fn(), broadcastThinkingEnd: vi.fn(),
      broadcastToolInputStart: vi.fn(), broadcastToolInputChunk: vi.fn(), broadcastToolInputEnd: vi.fn(),
    },
  } as unknown as HarnessContext;
  return { execution: harness.run(ctx), execute, broadcast };
}

describe('provider failures after completed tool steps', () => {
  it('preserves the completed tool and rejects a subsequent stream error', async () => {
    const { execution, execute, broadcast } = await runAfterTool(true);
    await expect(execution).rejects.toThrow('credit balance');
    expect(execute).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({type:'agent.tool_result',tool_use_id:'tool-1'}));
  });
  it('still completes a successful follow-up model step', async () => {
    const { execution, execute, broadcast } = await runAfterTool(false);
    await expect(execution).resolves.toBeUndefined();
    expect(execute).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({type:'agent.message',content:[{type:'text',text:'Finished checking'}]}));
  });
});
