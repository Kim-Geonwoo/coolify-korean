import { callWithRetry, EngineError, type Engine, type EngineRequest, type EngineUsage } from './engines/engine.ts';
import type { Glossary } from './glossary.ts';
import { mask, unmask, type Masked } from './masking.ts';
import { buildPrompt, parseTranslations, responseSchema, type PromptStyle } from './prompt.ts';
import type { SampleItem, Stratum } from './sample.ts';
import { hardIssues, softReport, type HardIssue, type SoftReport } from './validate.ts';

export type AttemptIssue = HardIssue | 'missing' | 'parse-failed' | 'request-failed';

export interface Attempt {
  /** 엔진이 이 항목에 준 번역(가린 채 그대로). 답이 없으면 null */
  readonly raw: string | null;
  readonly issues: readonly AttemptIssue[];
}

export interface BakeoffRecord {
  readonly engine: string;
  readonly id: string;
  readonly key: string;
  readonly stratum: Stratum;
  readonly kind: string;
  readonly file: string;
  readonly source: string;
  readonly masked: string;
  /** 첫 요청과(하드 검사에 걸렸으면) 재요청 한 번 */
  readonly attempts: readonly Attempt[];
  /** 통과한 번역(NFC, 자리표시자 복원). 폴백이면 영어 원문 */
  readonly final: string;
  readonly fallback: boolean;
  readonly soft: SoftReport | null;
}

export interface RequestLog {
  readonly batch: number;
  readonly ids: readonly string[];
  readonly retry: boolean;
  readonly ms: number;
  readonly finish?: string;
  readonly usage?: EngineUsage;
  readonly tokensPerSecond?: number;
  readonly error?: string;
  /** JSON으로 읽지 못한 응답 원문(앞부분). 실패 원인을 보려고 남긴다 */
  readonly unparsed?: string;
}

const UNPARSED_LIMIT = 8000;

export interface RunOutcome {
  readonly records: number;
  readonly fallbacks: number;
  readonly retried: number;
  readonly requests: number;
  /** 일일 한도로 멈췄으면 그 이유. 그 묶음부터는 기록하지 않았다(다시 돌리면 이어서 한다) */
  readonly stopped?: 'quota-daily';
}

export interface RunOptions {
  readonly items: readonly SampleItem[];
  readonly glossary: Glossary;
  readonly style: PromptStyle;
  /** 엔진의 구조화 출력(JSON 스키마)을 쓸지 */
  readonly schema: boolean;
  readonly engine: Engine;
  readonly engineId: string;
  readonly batchSize: number;
  readonly retryBatchSize: number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onRecord: (record: BakeoffRecord) => void;
  readonly onRequest: (log: RequestLog) => void;
  /** 분당 한도·지나가는 실패로 기다릴 때 */
  readonly onWait?: (ms: number, error: EngineError) => void;
  /** 1: 2a 동결 프롬프트, 2: 2b 규칙(기본) */
  readonly promptVersion?: 1 | 2;
}

const SMOKE_STRATA: readonly Stratum[] = ['tag', 'placeholder', 'label', 'long', 'edge', 'representative'];

/** 모든 시도가 요청 실패(API 오류)로만 끝난 폴백. 번역 품질이 아니라 API 문제라서 나중에 다시 돌릴 수 있다 */
export function failedOnlyByRequests(record: BakeoffRecord): boolean {
  return record.fallback && record.attempts.length > 0 && record.attempts.every((a) => a.issues.length === 1 && a.issues[0] === 'request-failed');
}

/** 실행 순서: id(키 해시) 순. 층이 한 묶음에 몰리지 않고, 엔진마다 같은 묶음이 된다 */
export function runOrder(items: readonly SampleItem[]): SampleItem[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 프롬프트 시험용 n개: 층을 돌아가며 id 순으로 하나씩 */
export function smokeItems(items: readonly SampleItem[], n: number): SampleItem[] {
  const queues = SMOKE_STRATA.map((stratum) => runOrder(items.filter((i) => i.stratum === stratum)));
  const out: SampleItem[] = [];
  while (out.length < n && queues.some((q) => q.length > 0)) {
    for (const queue of queues) {
      const next = queue.shift();
      if (next !== undefined && out.length < n) {
        out.push(next);
      }
    }
  }

  return out;
}

interface Prepared {
  readonly item: SampleItem;
  readonly masked: Masked;
}

interface Checked extends Attempt {
  /** 하드 검사를 통과했을 때의 최종 문장 */
  readonly text: string | null;
}

/** 묶음 번역 → 하드 검사 → 걸린 항목만 작은 묶음으로 한 번 재요청 → 그래도 실패하면 영어 폴백. */
export async function runBakeoff(options: RunOptions): Promise<RunOutcome> {
  const { glossary, style, engine } = options;
  let requests = 0;
  let fallbacks = 0;
  let retried = 0;
  let records = 0;

  const ask = async (group: readonly Prepared[], retry: boolean, batch: number): Promise<Map<string, Checked>> => {
    const ids = group.map((p) => p.item.id);
    const prompt = buildPrompt(style, group.map((p) => ({ id: p.item.id, text: p.masked.text, kind: p.item.kind, ...(p.item.kinds === undefined ? {} : { kinds: p.item.kinds }), file: p.item.file })), glossary, { version: options.promptVersion ?? 2 });
    const request: EngineRequest = options.schema ? { prompt, schema: responseSchema(style, ids) } : { prompt };
    const started = Date.now();
    let failure: AttemptIssue | null = null;
    let translations = new Map<string, string>();
    requests++;
    try {
      const result = await callWithRetry(engine, request, options.onWait === undefined ? { sleep: options.sleep } : { sleep: options.sleep, onWait: options.onWait });
      try {
        translations = parseTranslations(result.text, ids);
      } catch {
        failure = 'parse-failed';
      }
      options.onRequest({
        batch,
        ids,
        retry,
        ms: result.ms,
        finish: result.finishRaw ?? result.finish,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
        ...(result.tokensPerSecond === undefined ? {} : { tokensPerSecond: result.tokensPerSecond }),
        ...(failure === null ? {} : { unparsed: result.text.slice(0, UNPARSED_LIMIT) }),
      });
    } catch (error: unknown) {
      if (!(error instanceof EngineError)) {
        throw error;
      }
      options.onRequest({ batch, ids, retry, ms: Date.now() - started, error: `${error.kind}: ${error.message}` });
      if (error.kind === 'quota-daily') {
        throw error;
      }
      failure = 'request-failed';
    }
    const out = new Map<string, Checked>();
    for (const { item, masked } of group) {
      const raw = translations.get(item.id);
      if (failure !== null || raw === undefined) {
        out.set(item.id, { raw: null, issues: [failure ?? 'missing'], text: null });
        continue;
      }
      const text = unmask(raw.normalize('NFC'), masked).text;
      const issues = hardIssues(item, text);
      out.set(item.id, { raw, issues, text: issues.length === 0 ? text : null });
    }

    return out;
  };

  const prepared: Prepared[] = options.items.map((item) => ({ item, masked: mask(item.source, item.placeholders) }));
  try {
    for (let start = 0; start < prepared.length; start += options.batchSize) {
      const batch = prepared.slice(start, start + options.batchSize);
      const batchNo = start / options.batchSize;
      const first = await ask(batch, false, batchNo);
      const failed = batch.filter((p) => first.get(p.item.id)?.text == null);
      const second = new Map<string, Checked>();
      for (let r = 0; r < failed.length; r += options.retryBatchSize) {
        for (const [id, attempt] of await ask(failed.slice(r, r + options.retryBatchSize), true, batchNo)) {
          second.set(id, attempt);
        }
      }
      retried += failed.length;
      for (const { item, masked } of batch) {
        const attempts = [first.get(item.id), second.get(item.id)].filter((a): a is Checked => a !== undefined);
        const text = attempts.at(-1)?.text ?? null;
        const fallback = text === null;
        fallbacks += fallback ? 1 : 0;
        records++;
        options.onRecord({
          engine: options.engineId,
          id: item.id,
          key: item.key,
          stratum: item.stratum,
          kind: item.kind,
          file: item.file,
          source: item.source,
          masked: masked.text,
          attempts: attempts.map(({ raw, issues }) => ({ raw, issues })),
          final: text ?? item.source,
          fallback,
          soft: text === null ? null : softReport(item, text, glossary),
        });
      }
    }
  } catch (error: unknown) {
    if (error instanceof EngineError && error.kind === 'quota-daily') {
      return { records, fallbacks, retried, requests, stopped: 'quota-daily' };
    }
    throw error;
  }

  return { records, fallbacks, retried, requests };
}

/** 요청 한 건을 진행 줄 하나로 */
export function describeRequest(log: RequestLog): string {
  const head = `${log.retry ? '재요청' : '묶음'} ${String(log.batch + 1)} (${String(log.ids.length)}개) ${(log.ms / 1000).toFixed(1)}s`;
  if (log.error !== undefined) {
    return `${head} 실패 ${log.error}`;
  }
  const speed = log.tokensPerSecond === undefined ? '' : ` ${log.tokensPerSecond.toFixed(1)} tok/s`;
  const tokens = log.usage === undefined ? '' : ` 입력 ${String(log.usage.input)}·출력 ${String(log.usage.output)}${log.usage.thinking === undefined ? '' : `·사고 ${String(log.usage.thinking)}`}`;

  return `${head} ${log.finish ?? ''}${tokens}${speed}`;
}
