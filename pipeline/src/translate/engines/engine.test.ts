import { describe, expect, it } from 'vitest';
import { callWithRetry, EngineError, type Engine } from './engine.ts';
import { createGemini } from './gemini.ts';
import { createLlamaServer } from './llamaServer.ts';

type FetchArgs = [input: string | URL | Request, init?: RequestInit];

const urlOf = (input: string | URL | Request | undefined): string => (input === undefined ? '' : typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
const bodyOf = (init: RequestInit | undefined): Record<string, unknown> => JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>;

function fakeFetch(responses: (Response | Error)[]): { fetch: typeof fetch; calls: FetchArgs[] } {
  const calls: FetchArgs[] = [];
  const fn = (...args: FetchArgs): Promise<Response> => {
    calls.push(args);
    const next = responses.shift();
    if (next === undefined) {
      return Promise.reject(new Error('응답이 더 없습니다'));
    }

    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };

  return { fetch: fn, calls };
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const prompt = { system: 'rules', user: 'translate' };
const KEY = 'test-key-value';

function geminiBody(text: string, finishReason = 'STOP'): unknown {
  return { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 }, modelVersion: 'gemini-3.5-flash-lite-001' };
}

function quota(id: string, delay?: string): unknown {
  const details: unknown[] = [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: id }] }];
  if (delay !== undefined) {
    details.push({ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay });
  }

  return { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'quota', details } };
}

const geminiProfile = { model: 'gemini-3.5-flash-lite', sampling: { temperature: 1 }, thinkingLevel: 'minimal', systemInstruction: true, timeoutMs: 1000 } as const;

describe('gemini engine', () => {
  it('sends the key only in a header and reads text, finish reason and usage', async () => {
    const { fetch, calls } = fakeFetch([json(200, geminiBody('{"translations":[]}'))]);
    const engine = createGemini({ ...geminiProfile, apiKey: KEY, fetch });

    const out = await engine.complete({ prompt, schema: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } });

    expect(out).toMatchObject({ text: '{"translations":[]}', finish: 'stop', usage: { input: 10, output: 5, thinking: 3 }, model: 'gemini-3.5-flash-lite-001' });
    const [url, init] = calls[0] ?? [];
    expect(urlOf(url)).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
    expect(urlOf(url)).not.toContain(KEY);
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(KEY);
    const body = bodyOf(init);
    expect(body).toMatchObject({
      systemInstruction: { parts: [{ text: 'rules' }] },
      contents: [{ role: 'user', parts: [{ text: 'translate' }] }],
      generationConfig: { temperature: 1, thinkingConfig: { thinkingLevel: 'minimal' }, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { a: { type: 'STRING' } }, required: ['a'] } },
    });
  });

  it('folds the system prompt into the user turn when the model has no system instruction', async () => {
    const { fetch, calls } = fakeFetch([json(200, geminiBody('{}'))]);
    await createGemini({ ...geminiProfile, systemInstruction: false, apiKey: KEY, fetch }).complete({ prompt });

    const body = bodyOf(calls[0]?.[1]);
    expect(body['systemInstruction']).toBeUndefined();
    expect(body['contents']).toEqual([{ role: 'user', parts: [{ text: 'rules\n\ntranslate' }] }]);
    expect((body['generationConfig'] as Record<string, unknown>)['responseMimeType']).toBeUndefined();
  });

  it('tells a per-minute limit (with its wait) from a daily limit', async () => {
    const minute = fakeFetch([json(429, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '33.5s'))]);
    const daily = fakeFetch([json(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'))]);

    await expect(createGemini({ ...geminiProfile, apiKey: KEY, fetch: minute.fetch }).complete({ prompt })).rejects.toMatchObject({ kind: 'rate-limit', retryAfterMs: 33_500 });
    await expect(createGemini({ ...geminiProfile, apiKey: KEY, fetch: daily.fetch }).complete({ prompt })).rejects.toMatchObject({ kind: 'quota-daily' });
  });

  it('names the quota it hit, so the night log shows whether it was really the daily one', async () => {
    const daily = fakeFetch([json(429, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier'))]);
    const minute = fakeFetch([json(429, quota('GenerateContentInputTokensPerModelPerMinute-FreeTier', '20s'))]);

    await expect(createGemini({ ...geminiProfile, apiKey: KEY, fetch: daily.fetch }).complete({ prompt })).rejects.toThrow('GenerateRequestsPerDayPerProjectPerModel-FreeTier');
    await expect(createGemini({ ...geminiProfile, apiKey: KEY, fetch: minute.fetch }).complete({ prompt })).rejects.toThrow('GenerateContentInputTokensPerModelPerMinute-FreeTier');
  });

  it('maps server errors, timeouts, broken bodies and blocked prompts', async () => {
    const run = async (response: Response | Error): Promise<unknown> => createGemini({ ...geminiProfile, apiKey: KEY, fetch: fakeFetch([response]).fetch }).complete({ prompt }).catch((error: unknown) => error);

    expect(await run(json(503, { error: { message: 'overloaded' } }))).toMatchObject({ kind: 'server' });
    expect(await run(new DOMException('timed out', 'TimeoutError'))).toMatchObject({ kind: 'timeout' });
    expect(await run(new TypeError('fetch failed'))).toMatchObject({ kind: 'network' });
    expect(await run(new Response('<html>', { status: 200 }))).toMatchObject({ kind: 'bad-response' });
    expect(await run(json(200, { promptFeedback: { blockReason: 'OTHER' } }))).toMatchObject({ kind: 'bad-response' });
    expect(await run(json(400, { error: { message: `bad key ${KEY}` } }))).toMatchObject({ kind: 'http' });
    const error = await run(json(400, { error: { message: `bad key ${KEY}` } }));
    expect((error as Error).message).not.toContain(KEY);
  });

  it('reports a cut-off answer as finish length', async () => {
    const { fetch } = fakeFetch([json(200, geminiBody('{"transl', 'MAX_TOKENS'))]);

    await expect(createGemini({ ...geminiProfile, apiKey: KEY, fetch }).complete({ prompt })).resolves.toMatchObject({ finish: 'length' });
  });
});

describe('llama-server engine', () => {
  const profile = { baseUrl: 'http://127.0.0.1:8080', sampling: { temperature: 0, max_tokens: 4096 }, chatTemplateKwargs: { enable_thinking: false }, timeoutMs: 1000 };

  it('posts an OpenAI-style request with schema and reads timings', async () => {
    const { fetch, calls } = fakeFetch([json(200, { model: 'Index-Translate-9B.Q5_K_M.gguf', choices: [{ message: { content: '{"a":"가"}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 }, timings: { predicted_per_second: 55.5 } })]);
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };

    const out = await createLlamaServer({ ...profile, fetch }).complete({ prompt: { user: 'translate' }, schema });

    expect(out).toMatchObject({ text: '{"a":"가"}', finish: 'stop', usage: { input: 20, output: 4 }, tokensPerSecond: 55.5 });
    expect(urlOf(calls[0]?.[0])).toBe('http://127.0.0.1:8080/v1/chat/completions');
    expect(bodyOf(calls[0]?.[1])).toEqual({
      messages: [{ role: 'user', content: 'translate' }],
      temperature: 0,
      max_tokens: 4096,
      chat_template_kwargs: { enable_thinking: false },
      response_format: { type: 'json_schema', json_schema: { name: 'translations', schema } },
      stream: false,
    });
  });

  it('passes server switches such as cache_prompt through to the request', async () => {
    const { fetch, calls } = fakeFetch([json(200, { choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] })]);

    await createLlamaServer({ ...profile, requestExtras: { cache_prompt: false }, fetch }).complete({ prompt: { user: 'x' } });

    expect(bodyOf(calls[0]?.[1])).toMatchObject({ cache_prompt: false, temperature: 0 });
  });

  it('refuses to talk to anything but this computer', () => {
    expect(() => createLlamaServer({ ...profile, baseUrl: 'http://192.168.0.5:8080', fetch: fakeFetch([]).fetch })).toThrow();
  });

  it('reports length and server failures', async () => {
    const cut = fakeFetch([json(200, { choices: [{ message: { content: '{"a":' }, finish_reason: 'length' }] })]);
    const down = fakeFetch([json(503, { error: { message: 'Loading model' } })]);

    await expect(createLlamaServer({ ...profile, fetch: cut.fetch }).complete({ prompt: { user: 'x' } })).resolves.toMatchObject({ finish: 'length' });
    await expect(createLlamaServer({ ...profile, fetch: down.fetch }).complete({ prompt: { user: 'x' } })).rejects.toMatchObject({ kind: 'server' });
  });
});

describe('callWithRetry', () => {
  const ok = { text: 'ok', finish: 'stop' as const, ms: 1 };

  function scripted(outcomes: (EngineError | 'ok')[]): Engine & { count: () => number } {
    let n = 0;

    return {
      complete: () => {
        const next = outcomes[n] ?? 'ok';
        n++;

        return next === 'ok' ? Promise.resolve(ok) : Promise.reject(next);
      },
      count: () => n,
    };
  }

  it('waits out per-minute limits and retries passing failures', async () => {
    const waits: number[] = [];
    const engine = scripted([new EngineError('rate-limit', '429', 20_000), new EngineError('server', '503'), 'ok']);

    await expect(callWithRetry(engine, { prompt }, { sleep: (ms) => { waits.push(ms); return Promise.resolve(); } })).resolves.toEqual(ok);
    expect(waits).toEqual([20_000, 5_000]);
    expect(engine.count()).toBe(3);
  });

  it('stops at once on a daily limit or a request error', async () => {
    const sleep = (): Promise<void> => Promise.resolve();

    await expect(callWithRetry(scripted([new EngineError('quota-daily', 'day')]), { prompt }, { sleep })).rejects.toMatchObject({ kind: 'quota-daily' });
    await expect(callWithRetry(scripted([new EngineError('http', '400')]), { prompt }, { sleep })).rejects.toMatchObject({ kind: 'http' });
  });

  it('gives up after three passing failures', async () => {
    const engine = scripted([new EngineError('timeout', 't'), new EngineError('timeout', 't'), new EngineError('timeout', 't'), 'ok']);

    await expect(callWithRetry(engine, { prompt }, { sleep: () => Promise.resolve() })).rejects.toMatchObject({ kind: 'timeout' });
    expect(engine.count()).toBe(3);
  });
});
