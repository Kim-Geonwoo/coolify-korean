import { describe, expect, it } from 'vitest';
import { createEngine, profile, PROFILES } from './profiles.ts';

const urlOf = (input: string | URL | Request | undefined): string => (input === undefined ? '' : typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

function capture(): { fetch: typeof fetch; bodies: Record<string, unknown>[]; urls: string[] } {
  const bodies: Record<string, unknown>[] = [];
  const urls: string[] = [];
  const fn = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(urlOf(input));
    bodies.push(bodyOf(init));
    const body = urls[0]?.includes('googleapis')
      ? { candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] }
      : { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] };

    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };

  return { fetch: fn, bodies, urls };
}

describe('engine profiles', () => {
  it('keeps Index on prompt v1, where the 2b A/B showed v2 rules pushing labels and descriptions the wrong way', () => {
    expect(profile('index-9b').promptVersion).toBe(1);
    expect(profile('flash').promptVersion).toBeUndefined();
  });

  it('runs the same Index model on the server CPU in small batches with a longer timeout', () => {
    const gpu = profile('index-9b');
    const cpu = profile('index-9b-cpu');

    expect({ model: cpu.model, revision: cpu.revision, style: cpu.style, promptVersion: cpu.promptVersion, requestExtras: cpu.requestExtras }).toEqual({ model: gpu.model, revision: gpu.revision, style: gpu.style, promptVersion: gpu.promptVersion, requestExtras: gpu.requestExtras });
    expect(cpu.batchSize).toBe(6);
    expect(cpu.retryBatchSize).toBe(3);
    expect(cpu.timeoutMs).toBeGreaterThan(gpu.timeoutMs);
    expect(gpu.batchSize).toBeUndefined();
    // 우분투 2 실측(2026-10-17, 노드 0·8스레드): 생성 3.2 tok/s. 출력 상한을 다 써도 시간 제한 안에 끝나야 한다(상한 ÷ 속도 × 2)
    const maxTokens = cpu.sampling['max_tokens'] ?? Number.POSITIVE_INFINITY;
    expect(maxTokens).toBe(1024);
    expect(cpu.timeoutMs).toBeGreaterThanOrEqual((maxTokens / 3.2) * 2 * 1000);
  });

  it('has seven engines with unique ids and rejects unknown ones', () => {
    expect(PROFILES.map((p) => p.id)).toEqual(['hy-mt2', 'index-9b', 'index-9b-cpu', 'gemma4-26b', 'gemma4-31b', 'flash', 'flash-lite']);
    expect(() => profile('gpt')).toThrow();
  });

  it('turns a Gemini profile into requests with its model, thinking level and sampling', async () => {
    const { fetch, bodies, urls } = capture();
    await createEngine(profile('flash'), { apiKey: 'k', fetch }).complete({ prompt: { system: 's', user: 'u' } });

    expect(urls[0]).toContain('/models/gemini-3.8-flash:generateContent');
    expect(bodies[0]?.['generationConfig']).toMatchObject({ temperature: 1, maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: 'low' } });
    expect(() => createEngine(profile('flash'), {})).toThrow();
  });

  it('turns a local profile into llama-server requests with its template switches', async () => {
    const { fetch, bodies, urls } = capture();
    await createEngine(profile('index-9b'), { baseUrl: 'http://127.0.0.1:8091', fetch }).complete({ prompt: { user: 'u' } });

    expect(urls[0]).toBe('http://127.0.0.1:8091/v1/chat/completions');
    expect(bodies[0]).toMatchObject({ temperature: 0, chat_template_kwargs: { enable_thinking: false }, cache_prompt: false });
  });
});
