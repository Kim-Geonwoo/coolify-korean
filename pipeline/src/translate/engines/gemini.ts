import { EngineError, fetchFailure, readJson, type Engine, type EngineRequest, type EngineResult, type FinishReason } from './engine.ts';

export interface GeminiOptions {
  readonly model: string;
  /** 요청 헤더(x-goog-api-key)로만 보낸다. URL·로그·오류 문구에 넣지 않는다 */
  readonly apiKey: string;
  /** generationConfig에 그대로 들어가는 값(temperature, topP, topK, maxOutputTokens) */
  readonly sampling: Readonly<Record<string, number>>;
  readonly thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high';
  /** false면 시스템 지시를 사용자 차례 앞에 붙인다(시스템 지시를 받지 않는 모델) */
  readonly systemInstruction: boolean;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
}

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

/** 표준 JSON 스키마 → Gemini Schema(대문자 type, propertyOrdering). additionalProperties는 뺀다. */
export function toGeminiSchema(schema: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'additionalProperties') {
      continue;
    }
    if (key === 'type' && typeof value === 'string') {
      out[key] = value.toUpperCase();
    } else if (key === 'properties' && typeof value === 'object' && value !== null) {
      const properties = value as Record<string, Readonly<Record<string, unknown>>>;
      out[key] = Object.fromEntries(Object.entries(properties).map(([name, sub]) => [name, toGeminiSchema(sub)]));
      out['propertyOrdering'] = Object.keys(properties);
    } else if (key === 'items' && typeof value === 'object' && value !== null) {
      out[key] = toGeminiSchema(value as Readonly<Record<string, unknown>>);
    } else {
      out[key] = value;
    }
  }

  return out;
}

const FINISH: Readonly<Record<string, FinishReason>> = { STOP: 'stop', MAX_TOKENS: 'length' };

interface GeminiPart {
  readonly text?: unknown;
  readonly thought?: unknown;
}

function rateError(body: unknown): EngineError {
  const details = (body as { error?: { details?: unknown } } | null)?.error?.details;
  const list = Array.isArray(details) ? (details as Record<string, unknown>[]) : [];
  // 걸린 한도 이름(공개 식별자)을 문장에 남겨, 밤 로그에서 정말 일일 한도였는지 보게 한다
  const quotaIds = list.flatMap((detail) => (Array.isArray(detail['violations']) ? (detail['violations'] as { quotaId?: unknown }[]) : [])).flatMap((v) => (typeof v.quotaId === 'string' && /^[A-Za-z0-9_-]{1,120}$/.test(v.quotaId) ? [v.quotaId] : []));
  const named = quotaIds.length === 0 ? '' : `(${quotaIds.join(', ')})`;
  if (quotaIds.some((id) => /PerDay/i.test(id))) {
    return new EngineError('quota-daily', `일일 무료 한도에 닿았습니다${named}.`);
  }
  const delay = list.map((detail) => detail['retryDelay']).find((value): value is string => typeof value === 'string');
  const seconds = delay === undefined ? undefined : /^(\d+(?:\.\d+)?)s$/.exec(delay)?.[1];

  return new EngineError('rate-limit', `분당 한도에 닿았습니다${named}.`, seconds === undefined ? undefined : Math.ceil(Number(seconds) * 1000));
}

export function createGemini(options: GeminiOptions): Engine {
  if (options.apiKey.trim() === '') {
    throw new Error('Gemini 키가 비어 있습니다.');
  }
  const doFetch = options.fetch ?? fetch;
  const scrub = (text: string): string => text.split(options.apiKey).join('***');

  return {
    async complete(request: EngineRequest): Promise<EngineResult> {
      const { system, user } = request.prompt;
      const folded = system !== undefined && !options.systemInstruction;
      const generationConfig: Record<string, unknown> = { ...options.sampling };
      if (options.thinkingLevel !== undefined) {
        generationConfig['thinkingConfig'] = { thinkingLevel: options.thinkingLevel };
      }
      if (request.schema !== undefined) {
        generationConfig['responseMimeType'] = 'application/json';
        generationConfig['responseSchema'] = toGeminiSchema(request.schema);
      }
      const body: Record<string, unknown> = {
        contents: [{ role: 'user', parts: [{ text: folded ? `${system}\n\n${user}` : user }] }],
        generationConfig,
      };
      if (system !== undefined && !folded) {
        body['systemInstruction'] = { parts: [{ text: system }] };
      }
      const started = Date.now();
      try {
        const response = await doFetch(`${API}/${encodeURIComponent(options.model)}:generateContent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': options.apiKey },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (response.status === 429) {
          throw rateError(await readJson(response).catch(() => null));
        }
        if (!response.ok) {
          const data = await readJson(response).catch(() => null);
          const message = (data as { error?: { message?: unknown } } | null)?.error?.message;
          const detail = typeof message === 'string' ? `: ${scrub(message).slice(0, 300)}` : '';
          throw new EngineError(response.status >= 500 ? 'server' : 'http', `HTTP ${String(response.status)}${detail}`);
        }
        const data = (await readJson(response)) as {
          candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: unknown }[];
          promptFeedback?: { blockReason?: unknown };
          usageMetadata?: { promptTokenCount?: unknown; candidatesTokenCount?: unknown; thoughtsTokenCount?: unknown };
          modelVersion?: unknown;
        };
        const candidate = data.candidates?.[0];
        if (candidate === undefined) {
          const reason = data.promptFeedback?.blockReason;
          throw new EngineError('bad-response', `답이 없습니다(${typeof reason === 'string' ? reason : '이유 없음'}).`);
        }
        const text = (candidate.content?.parts ?? [])
          .filter((part) => part.thought !== true && typeof part.text === 'string')
          .map((part) => String(part.text))
          .join('');
        const finishRaw = typeof candidate.finishReason === 'string' ? candidate.finishReason : 'UNKNOWN';
        const usage = data.usageMetadata;
        const result: { -readonly [K in keyof EngineResult]: EngineResult[K] } = { text, finish: FINISH[finishRaw] ?? 'other', finishRaw, ms: Date.now() - started };
        if (typeof usage?.promptTokenCount === 'number' && typeof usage.candidatesTokenCount === 'number') {
          result.usage = { input: usage.promptTokenCount, output: usage.candidatesTokenCount, ...(typeof usage.thoughtsTokenCount === 'number' ? { thinking: usage.thoughtsTokenCount } : {}) };
        }
        if (typeof data.modelVersion === 'string') {
          result.model = data.modelVersion;
        }

        return result;
      } catch (error: unknown) {
        throw fetchFailure(error);
      }
    },
  };
}
