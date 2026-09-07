import { describe, expect, it, vi, afterEach } from 'vitest';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { resolveModel, reasoningProviderOptions, isOpenAiResponsesModel } from '../../agent/src/harness/provider';

afterEach(() => vi.unstubAllGlobals());
describe('GPT-6 Astra provider', () => {
  it.each([undefined, 'instant', 'low', 'medium', 'high', 'max'] as const)('uses Responses at reasoning level %s', (level) => {
    const model = resolveModel('gpt-6-astra', 'test', undefined, 'oai', undefined, level);
    expect(isOpenAiResponsesModel(model)).toBe(true);
    expect(reasoningProviderOptions(model, 'gpt-6-astra', level, true)).toEqual({openai:{forceReasoning:true,store:false,reasoningEffort: level === 'max' ? 'xhigh' : level === undefined || level === 'instant' ? 'low' : level}});
  });
  it('sends function calls and replays results through Responses', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      expect(String(url)).toBe('https://api.openai.com/v1/responses');
      bodies.push(JSON.parse(init.body));
      return Response.json({id:'resp_'+bodies.length, created_at:0, model:'gpt-6-astra', object:'response', status:'completed', output: bodies.length === 1 ? [{type:'function_call',id:'fc_1',call_id:'call_1',name:'probe',arguments:'{}',status:'completed'}] : [{type:'message',id:'msg_1',role:'assistant',status:'completed',content:[{type:'output_text',text:'OK',annotations:[]}]}], usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
    }));
    const model = resolveModel('gpt-6-astra', 'test', undefined, 'oai');
    const execute = vi.fn(async () => 'Linux ready');
    const result = await generateText({model,prompt:'Probe the computer',tools:{probe:tool({inputSchema:z.object({}),execute})},stopWhen:stepCountIs(2),providerOptions:reasoningProviderOptions(model,'gpt-6-astra',undefined,true)});
    expect(result.text).toBe('OK');
    expect(execute).toHaveBeenCalledOnce();
    expect(bodies).toHaveLength(2);
    for (const body of bodies) {
      expect(body.reasoning.effort).toBe('low');
      expect(body.temperature).toBeUndefined();
      expect(body.top_p).toBeUndefined();
      expect(body.store).toBe(false);
      expect(body.include).toContain('reasoning.encrypted_content');
    }
    expect(bodies[1].input).toContainEqual(expect.objectContaining({type:'function_call_output',call_id:'call_1',output:'Linux ready'}));
  });
});
