import { EngineError, fetchFailure, readJson, type Engine, type EngineRequest, type EngineResult, type FinishReason } from './engine.ts';

export interface LlamaServerOptions {
  /** 이 PC의 llama-server(127.0.0.1·localhost·[::1])만 허용한다 */
  readonly baseUrl: string;
  /** 요청 본문에 그대로 들어가는 값(temperature, top_p, top_k, repeat_penalty, max_tokens, seed) */
  readonly sampling: Readonly<Record<string, number>>;
  readonly chatTemplateKwargs?: Readonly<Record<string, unknown>>;
  /** 요청 본문에 더할 서버 스위치(예: cache_prompt false — 켜 두면 같은 입력도 결과가 달라질 수 있다) */
  readonly requestExtras?: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const FINISH: Readonly<Record<string, FinishReason>> = { stop: 'stop', length: 'length' };

export function createLlamaServer(options: LlamaServerOptions): Engine {
  const base = new URL(options.baseUrl);
  if (!LOCAL_HOSTS.has(base.hostname) || (base.protocol !== 'http:' && base.protocol !== 'https:')) {
    throw new Error(`llama-server는 이 PC 주소만 씁니다: ${base.host}`);
  }
  const endpoint = new URL('/v1/chat/completions', base).toString();
  const doFetch = options.fetch ?? fetch;

  return {
    async complete(request: EngineRequest): Promise<EngineResult> {
      const { system, user } = request.prompt;
      const body: Record<string, unknown> = {
        messages: [...(system === undefined ? [] : [{ role: 'system', content: system }]), { role: 'user', content: user }],
        ...options.sampling,
        ...options.requestExtras,
        stream: false,
      };
      if (options.chatTemplateKwargs !== undefined) {
        body['chat_template_kwargs'] = options.chatTemplateKwargs;
      }
      if (request.schema !== undefined) {
        body['response_format'] = { type: 'json_schema', json_schema: { name: 'translations', schema: request.schema } };
      }
      const started = Date.now();
      try {
        const response = await doFetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(options.timeoutMs) });
        if (!response.ok) {
          const data = await readJson(response).catch(() => null);
          const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
          throw new EngineError(response.status >= 500 || response.status === 429 ? 'server' : 'http', `HTTP ${String(response.status)}${typeof message === 'string' ? `: ${message.slice(0, 300)}` : ''}`);
        }
        const data = (await readJson(response)) as {
          model?: unknown;
          choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
          timings?: { predicted_per_second?: unknown };
        };
        const choice = data.choices?.[0];
        if (choice === undefined || typeof choice.message?.content !== 'string') {
          throw new EngineError('bad-response', '응답에 choices[0].message.content가 없습니다.');
        }
        const finishRaw = typeof choice.finish_reason === 'string' ? choice.finish_reason : 'unknown';
        const result: { -readonly [K in keyof EngineResult]: EngineResult[K] } = { text: choice.message.content, finish: FINISH[finishRaw] ?? 'other', finishRaw, ms: Date.now() - started };
        if (typeof data.usage?.prompt_tokens === 'number' && typeof data.usage.completion_tokens === 'number') {
          result.usage = { input: data.usage.prompt_tokens, output: data.usage.completion_tokens };
        }
        if (typeof data.timings?.predicted_per_second === 'number') {
          result.tokensPerSecond = data.timings.predicted_per_second;
        }
        if (typeof data.model === 'string') {
          result.model = data.model;
        }

        return result;
      } catch (error: unknown) {
        throw fetchFailure(error);
      }
    },
  };
}

/** 떠 있는 llama-server가 기대한 모델을 올렸는지 보고, 실행 기록에 남길 모델 경로·빌드를 읽는다 */
export async function llamaProps(baseUrl: string, model: string): Promise<{ modelPath: string; build: string }> {
  const response = await fetch(new URL('/props', baseUrl), { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) {
    throw new Error(`llama-server /props가 HTTP ${String(response.status)}를 돌려줬습니다.`);
  }
  const data = (await response.json()) as { model_path?: unknown; build_info?: unknown };
  const modelPath = typeof data.model_path === 'string' ? data.model_path : '';
  if (!modelPath.replaceAll('\\', '/').endsWith(`/${model}`) && modelPath !== model) {
    throw new Error(`llama-server에 다른 모델이 올라 있습니다: ${modelPath || '알 수 없음'} (기대: ${model})`);
  }

  return { modelPath, build: typeof data.build_info === 'string' ? data.build_info : '알 수 없음' };
}
