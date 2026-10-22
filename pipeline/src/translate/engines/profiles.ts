import type { PromptStyle } from '../prompt.ts';
import type { Engine } from './engine.ts';
import { createGemini } from './gemini.ts';
import { createLlamaServer } from './llamaServer.ts';

/** 실측 엔진 하나의 실행 조건. 보고서에 그대로 싣는다 */
export interface EngineProfile {
  readonly id: string;
  readonly label: string;
  readonly runtime: 'llama-server' | 'gemini';
  readonly style: PromptStyle;
  /** API 모델 이름 또는 GGUF 파일 이름 */
  readonly model: string;
  /** 내려받은 모델의 저장소@리비전 */
  readonly revision?: string;
  readonly sampling: Readonly<Record<string, number>>;
  /** 구조화 출력(JSON 스키마)을 쓸지. 문서에 지원이 없는 모델은 프롬프트로만 요구한다 */
  readonly schema: boolean;
  readonly thinkingLevel?: 'minimal' | 'low';
  readonly systemInstruction?: boolean;
  readonly chatTemplateKwargs?: Readonly<Record<string, unknown>>;
  /** llama-server 요청에 더할 스위치 */
  readonly requestExtras?: Readonly<Record<string, unknown>>;
  /** 이 엔진이 쓰는 프롬프트 버전(없으면 2) */
  readonly promptVersion?: 1 | 2;
  /** 한 요청의 항목 수와 재요청 묶음(없으면 실행기 기본 20·5) */
  readonly batchSize?: number;
  readonly retryBatchSize?: number;
  readonly timeoutMs: number;
}

const LOCAL_TIMEOUT_MS = 180_000;
const CPU_TIMEOUT_MS = 900_000;
const API_TIMEOUT_MS = 120_000;
const SEED = 20261017;

export const PROFILES: readonly EngineProfile[] = [
  {
    id: 'hy-mt2',
    label: 'Hy-MT2-7B Q6_K (llama.cpp)',
    runtime: 'llama-server',
    style: 'hy-mt2',
    model: 'HY-MT2-7B-Q6_K.gguf',
    revision: 'tencent/Hy-MT2-7B-GGUF@ab8472660ac61fac25f1af43fac2599d52a8a775',
    sampling: { temperature: 0.7, top_p: 0.6, top_k: 20, repeat_penalty: 1.05, max_tokens: 4096, seed: SEED },
    schema: true,
    timeoutMs: LOCAL_TIMEOUT_MS,
  },
  {
    id: 'index-9b',
    label: 'Index-Translate-9B Q5_K_M (llama.cpp)',
    runtime: 'llama-server',
    style: 'index',
    model: 'Index-Translate-9B.Q5_K_M.gguf',
    revision: 'IndexTeam/Index-Translate-9B-GGUF@645939fbab839a656f1bc39975a872bc8ad749f8',
    sampling: { temperature: 0, max_tokens: 4096, seed: SEED },
    chatTemplateKwargs: { enable_thinking: false },
    // 2b 검토: 프롬프트 캐시가 켜져 있으면 같은 입력도 결과가 달라질 수 있다
    requestExtras: { cache_prompt: false },
    // 2b A/B(표본2 80개): v2 규칙은 겨냥한 설정 설명을 고치지 못하고 라벨·설명을 반대로 밀었다. 하세요는 정규화가 맡는다
    promptVersion: 1,
    schema: true,
    timeoutMs: LOCAL_TIMEOUT_MS,
  },
  {
    id: 'index-9b-cpu',
    label: 'Index-Translate-9B Q5_K_M (llama.cpp, 우분투 2 CPU)',
    runtime: 'llama-server',
    style: 'index',
    model: 'Index-Translate-9B.Q5_K_M.gguf',
    revision: 'IndexTeam/Index-Translate-9B-GGUF@645939fbab839a656f1bc39975a872bc8ad749f8',
    // 묶음 6개의 출력은 보통 200토큰 안팎이다. 상한을 다 써도(1024 ÷ 3.2 tok/s × 2 ≈ 11분) 시간 제한 15분 안에 끝난다
    sampling: { temperature: 0, max_tokens: 1024, seed: SEED },
    chatTemplateKwargs: { enable_thinking: false },
    // 2b 검토: 프롬프트 캐시가 켜져 있으면 같은 입력도 결과가 달라질 수 있다
    requestExtras: { cache_prompt: false },
    // 2b A/B(표본2 80개): v2 규칙은 겨냥한 설정 설명을 고치지 못하고 라벨·설명을 반대로 밀었다. 하세요는 정규화가 맡는다
    promptVersion: 1,
    schema: true,
    // 서버 CPU는 메모리 대역폭(소켓당 2채널)이 좁아 생성이 느리다(실측 2026-10-17: 노드 0·8스레드 생성 3.2 tok/s, 입력 29.6 tok/s, 12·16스레드도 나아지지 않음)
    batchSize: 6,
    retryBatchSize: 3,
    timeoutMs: CPU_TIMEOUT_MS,
  },
  {
    id: 'gemma4-26b',
    label: 'Gemma 4 26B A4B (Gemini API)',
    runtime: 'gemini',
    style: 'generic',
    model: 'gemma-4-26b-a4b-it',
    sampling: { temperature: 1.0, topP: 0.95, topK: 64, maxOutputTokens: 8192 },
    schema: false,
    thinkingLevel: 'minimal',
    systemInstruction: true,
    timeoutMs: API_TIMEOUT_MS,
  },
  {
    id: 'gemma4-31b',
    label: 'Gemma 4 31B (Gemini API)',
    runtime: 'gemini',
    style: 'generic',
    model: 'gemma-4-31b-it',
    sampling: { temperature: 1.0, topP: 0.95, topK: 64, maxOutputTokens: 8192 },
    schema: false,
    thinkingLevel: 'minimal',
    systemInstruction: true,
    timeoutMs: API_TIMEOUT_MS,
  },
  {
    id: 'flash',
    label: 'Gemini 3.8 Flash (사고 low)',
    runtime: 'gemini',
    style: 'generic',
    model: 'gemini-3.8-flash',
    sampling: { temperature: 1.0, maxOutputTokens: 8192 },
    schema: true,
    thinkingLevel: 'low',
    systemInstruction: true,
    timeoutMs: API_TIMEOUT_MS,
  },
  {
    id: 'flash-lite',
    label: 'Gemini 3.5 Flash-Lite (사고 minimal)',
    runtime: 'gemini',
    style: 'generic',
    model: 'gemini-3.5-flash-lite',
    sampling: { temperature: 1.0, maxOutputTokens: 8192 },
    schema: true,
    thinkingLevel: 'minimal',
    systemInstruction: true,
    timeoutMs: API_TIMEOUT_MS,
  },
];

export function profile(id: string): EngineProfile {
  const found = PROFILES.find((p) => p.id === id);
  if (found === undefined) {
    throw new Error(`엔진 id를 모릅니다: ${id} (가능: ${PROFILES.map((p) => p.id).join(', ')})`);
  }

  return found;
}

export interface EngineDeps {
  /** gemini에만 필요하다 */
  readonly apiKey?: string;
  /** llama-server 주소(이 PC) */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export function createEngine(p: EngineProfile, deps: EngineDeps): Engine {
  const fetchOption = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  if (p.runtime === 'gemini') {
    if (deps.apiKey === undefined) {
      throw new Error(`${p.id}에는 Gemini 키가 필요합니다.`);
    }

    return createGemini({
      model: p.model,
      apiKey: deps.apiKey,
      sampling: p.sampling,
      systemInstruction: p.systemInstruction ?? true,
      timeoutMs: p.timeoutMs,
      ...(p.thinkingLevel === undefined ? {} : { thinkingLevel: p.thinkingLevel }),
      ...fetchOption,
    });
  }

  return createLlamaServer({
    baseUrl: deps.baseUrl ?? 'http://127.0.0.1:8080',
    sampling: p.sampling,
    timeoutMs: p.timeoutMs,
    ...(p.chatTemplateKwargs === undefined ? {} : { chatTemplateKwargs: p.chatTemplateKwargs }),
    ...(p.requestExtras === undefined ? {} : { requestExtras: p.requestExtras }),
    ...fetchOption,
  });
}
