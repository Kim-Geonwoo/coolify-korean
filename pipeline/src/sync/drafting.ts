import type { Translated } from '../i18n/drafts.ts';
import { sourceHash } from '../i18n/integrity.ts';
import { failedOnlyByRequests, runBakeoff, runOrder, type BakeoffRecord, type RequestLog } from '../translate/bakeoff.ts';
import type { Engine, EngineError } from '../translate/engines/engine.ts';
import type { Glossary } from '../translate/glossary.ts';
import { placeholderNames } from '../translate/masking.ts';
import { normalize } from '../translate/normalize.ts';
import type { PromptStyle } from '../translate/prompt.ts';
import type { CatalogEntry, SampleItem } from '../translate/sample.ts';

const HARD_WORDS = 15;

/** 첫 전량 번역의 절충안(2026-10-17 사용자 결정): 자리표시자·번호 태그·긴 글은 더 강한 엔진이 다시 번역한다 */
export function isHardKey(entry: CatalogEntry): boolean {
  const words = entry.english.replace(/<\/?\d+\/?>/g, ' ').split(/\s+/).filter((word) => /[A-Za-z]/.test(word)).length;

  return placeholderNames(entry.english, entry.placeholders).length > 0 || entry.markup || /<\/?\d+\/?>/.test(entry.english) || words >= HARD_WORDS;
}

/** 카탈로그 키를 엔진 항목으로. id는 영어 원문의 지문이라 원장에서 같은 원문을 다시 찾는다 */
export function draftItems(catalog: Readonly<Record<string, CatalogEntry>>, keys: readonly string[]): SampleItem[] {
  const seen = new Set<string>();

  return keys.map((key) => {
    const entry = catalog[key];
    if (entry === undefined) {
      throw new Error(`카탈로그에 없는 키: ${key}`);
    }
    const id = sourceHash(entry.english);
    if (seen.has(id)) {
      throw new Error(`같은 영어가 두 번 들어왔습니다(번역 메모리에서 나눠야 한다): ${key}`);
    }
    seen.add(id);

    return { id, key, source: entry.english, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, file: entry.occurrences[0]?.file ?? '', placeholders: entry.placeholders, markup: entry.markup, stratum: 'representative' };
  });
}

export interface TranslateOptions {
  readonly catalog: Readonly<Record<string, CatalogEntry>>;
  readonly keys: readonly string[];
  readonly glossary: Glossary;
  readonly engine: Engine;
  readonly engineId: string;
  readonly style: PromptStyle;
  readonly schema: boolean;
  readonly promptVersion: 1 | 2;
  readonly batchSize: number;
  readonly retryBatchSize: number;
  /** 이번 실행 id(runs.json) */
  readonly run: string;
  /** 같은 엔진·프롬프트로 이미 받은 결과(id → 기록) */
  readonly ledger: ReadonlyMap<string, BakeoffRecord>;
  readonly onRecord: (record: BakeoffRecord) => void;
  readonly onRequest: (log: RequestLog) => void;
  readonly onWait?: (ms: number, error: EngineError) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

export interface TranslateOutcome {
  readonly translated: Map<string, Translated>;
  /** 출력이 하드 검사를 끝내 못 넘은 키(엔진·프롬프트가 바뀔 때만 다시 시도) */
  readonly fallbacks: readonly string[];
  readonly resumed: number;
  readonly requests: number;
  readonly stopped?: 'quota-daily';
}

function toTranslated(record: BakeoffRecord, item: SampleItem, run: string): Translated {
  const result = normalize(record.final, placeholderNames(item.source, item.placeholders), { plural: (item.kinds ?? [item.kind]).includes('plural') });
  const edits = result.edits.map(({ rule, before, after }) => ({ rule, before, after }));

  return { text: result.text, run, ...(edits.length === 0 ? {} : { edits }), ...(result.warnings.length === 0 ? {} : { warnings: result.warnings }) };
}

/** 원장에 없는 키만 엔진에 보낸다. API 실패로만 끝난 기록은 다시 보내고, 출력이 틀린 기록은 실패로 둔다 */
export async function translateKeys(options: TranslateOptions): Promise<TranslateOutcome> {
  const items = draftItems(options.catalog, options.keys);
  const byId = new Map(items.map((item) => [item.id, item]));
  const translated = new Map<string, Translated>();
  const fallbacks: string[] = [];
  const take = (record: BakeoffRecord, run: string): void => {
    const item = byId.get(record.id);
    if (item === undefined) {
      return;
    }
    if (record.fallback) {
      fallbacks.push(item.key);
    } else {
      translated.set(item.key, toTranslated(record, item, run));
    }
  };
  const pending: SampleItem[] = [];
  let resumed = 0;
  for (const item of items) {
    const record = options.ledger.get(item.id);
    if (record === undefined || failedOnlyByRequests(record)) {
      pending.push(item);
    } else {
      resumed++;
      take(record, options.run);
    }
  }

  const outcome = await runBakeoff({
    items: runOrder(pending),
    glossary: options.glossary,
    style: options.style,
    schema: options.schema,
    engine: options.engine,
    engineId: options.engineId,
    batchSize: options.batchSize,
    retryBatchSize: options.retryBatchSize,
    promptVersion: options.promptVersion,
    sleep: options.sleep,
    onRequest: options.onRequest,
    ...(options.onWait === undefined ? {} : { onWait: options.onWait }),
    onRecord: (record) => {
      options.onRecord(record);
      take(record, options.run);
    },
  });

  return {
    translated,
    fallbacks: fallbacks.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    resumed,
    requests: outcome.requests,
    ...(outcome.stopped === undefined ? {} : { stopped: outcome.stopped }),
  };
}
