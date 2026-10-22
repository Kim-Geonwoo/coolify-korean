import type { Prompt } from '../prompt.ts';

export type FinishReason = 'stop' | 'length' | 'other';

export interface EngineRequest {
  readonly prompt: Prompt;
  /** 표준 JSON 스키마. 주면 엔진의 구조화 출력을 쓴다 */
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface EngineUsage {
  readonly input: number;
  readonly output: number;
  readonly thinking?: number;
}

export interface EngineResult {
  readonly text: string;
  readonly finish: FinishReason;
  /** 엔진이 준 그대로의 끝난 이유 */
  readonly finishRaw?: string;
  readonly ms: number;
  readonly usage?: EngineUsage;
  readonly model?: string;
  readonly tokensPerSecond?: number;
}

export interface Engine {
  complete(request: EngineRequest): Promise<EngineResult>;
}

/**
 * rate-limit: 분당 한도(기다리면 됨), quota-daily: 일일 한도(그 엔진을 멈춤),
 * server·timeout·network: 지나가는 실패(몇 번 다시), http·bad-response: 요청이나 응답이 잘못됨(다시 해도 같음)
 */
export type EngineErrorKind = 'rate-limit' | 'quota-daily' | 'server' | 'timeout' | 'network' | 'http' | 'bad-response';

export class EngineError extends Error {
  readonly kind: EngineErrorKind;
  readonly retryAfterMs: number | undefined;

  constructor(kind: EngineErrorKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'EngineError';
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

/** fetch가 던진 것을 시간 초과와 연결 실패로 나눈다. */
export function fetchFailure(error: unknown): EngineError {
  if (error instanceof EngineError) {
    return error;
  }
  const name = error instanceof Error || error instanceof DOMException ? error.name : '';

  return name === 'TimeoutError' || name === 'AbortError' ? new EngineError('timeout', '요청 시간이 지났습니다.') : new EngineError('network', `연결하지 못했습니다(${name || '알 수 없음'}).`);
}

export async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new EngineError('bad-response', `응답 본문이 JSON이 아닙니다(HTTP ${String(response.status)}).`);
  }
}

export interface RetryOptions {
  readonly sleep: (ms: number) => Promise<void>;
  readonly onWait?: (ms: number, error: EngineError) => void;
}

const PASSING_BACKOFF_MS = [5_000, 15_000];
const MAX_RATE_WAITS = 10;
const DEFAULT_RATE_WAIT_MS = 60_000;

/** 분당 한도는 기다렸다 다시, 지나가는 실패는 3번까지. 일일 한도·요청 오류는 바로 던진다. */
export async function callWithRetry(engine: Engine, request: EngineRequest, options: RetryOptions): Promise<EngineResult> {
  let passing = 0;
  let rateWaits = 0;
  for (;;) {
    try {
      return await engine.complete(request);
    } catch (error: unknown) {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      let wait: number;
      if (error.kind === 'rate-limit' && rateWaits < MAX_RATE_WAITS) {
        rateWaits++;
        wait = error.retryAfterMs ?? DEFAULT_RATE_WAIT_MS;
      } else if ((error.kind === 'server' || error.kind === 'timeout' || error.kind === 'network') && passing < PASSING_BACKOFF_MS.length) {
        wait = PASSING_BACKOFF_MS[passing] ?? 15_000;
        passing++;
      } else {
        throw error;
      }
      options.onWait?.(wait, error);
      await options.sleep(wait);
    }
  }
}
