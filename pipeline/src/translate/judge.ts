import { createHash } from 'node:crypto';
import type { BakeoffRecord } from './bakeoff.ts';
import { termsIn, type Glossary } from './glossary.ts';
import { placeholderNames, withoutPlaceholders } from './masking.ts';
import type { SampleItem } from './sample.ts';

const LABELS = ['A', 'B', 'C', 'D', 'E', 'F'] as const;

export type Severity = 'critical' | 'major' | 'minor';

export interface JudgeCandidate {
  readonly label: string;
  readonly text: string;
}

export interface JudgeItem {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly source: string;
  /** 이 문장에 든 용어집 용어("Server → 서버") */
  readonly terms: readonly string[];
  readonly candidates: readonly JudgeCandidate[];
}

export interface JudgeBatch {
  readonly pass: number;
  readonly batch: number;
  readonly items: readonly JudgeItem[];
}

/** `${회차}:${id}` → 라벨 → 엔진. 심판에게는 주지 않는다 */
export type JudgeKey = Record<string, Record<string, string>>;

export interface JudgeError {
  readonly severity: Severity;
  readonly category: string;
  readonly note: string;
}

export interface JudgeVerdict {
  readonly pass: number;
  readonly id: string;
  readonly label: string;
  readonly errors: readonly JudgeError[];
}

/** 시드로 정한 순열(Fisher–Yates, 난수는 sha256). 같은 시드면 늘 같은 순서다 */
export function shuffle<T>(values: readonly T[], seed: string): T[] {
  const out = [...values];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Number.parseInt(createHash('sha256').update(`${seed}:${String(i)}`).digest('hex').slice(0, 8), 16) % (i + 1);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }

  return out;
}

/**
 * 엔진별 기록을 심판용 묶음으로 만든다. 항목마다·회차마다 엔진 순서를 섞어 A~F로 가리고, 회차마다 항목 순서도 섞는다.
 * 영어로 폴백한 기록은 심판에 넣지 않고 따로 알린다(보고서에서 고정 감점).
 */
export function blindBatches(
  items: readonly SampleItem[],
  records: ReadonlyMap<string, ReadonlyMap<string, BakeoffRecord>>,
  glossary: Glossary,
  options: { readonly passes: number; readonly batchSize: number },
): { batches: JudgeBatch[]; key: JudgeKey; excluded: { engine: string; id: string }[] } {
  const engines = [...records.keys()];
  if (engines.length > LABELS.length) {
    throw new Error(`엔진이 ${String(LABELS.length)}개를 넘습니다.`);
  }
  const excluded: { engine: string; id: string }[] = [];
  for (const engine of engines) {
    for (const item of items) {
      const record = records.get(engine)?.get(item.id);
      if (record === undefined) {
        throw new Error(`${engine}에 ${item.id} 기록이 없습니다. 실행을 끝까지 마치세요.`);
      }
      if (record.fallback) {
        excluded.push({ engine, id: item.id });
      }
    }
  }
  const byId = [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const batches: JudgeBatch[] = [];
  const key: JudgeKey = {};
  for (let pass = 1; pass <= options.passes; pass++) {
    const shown: JudgeItem[] = shuffle(byId, `items:${String(pass)}`).map((item) => {
      const order = shuffle(engines, `${String(pass)}:${item.id}`).filter((engine) => records.get(engine)?.get(item.id)?.fallback === false);
      const labels: Record<string, string> = {};
      const candidates = order.map((engine, index) => {
        const label = LABELS[index] ?? '?';
        labels[label] = engine;

        return { label, text: records.get(engine)?.get(item.id)?.final ?? '' };
      });
      key[`${String(pass)}:${item.id}`] = labels;
      const terms = termsIn(withoutPlaceholders(item.source, placeholderNames(item.source, item.placeholders)), glossary).map((t) => `${t.en} → ${t.ko}`);

      return { id: item.id, kind: item.kind, file: item.file, source: item.source, terms, candidates };
    });
    for (let start = 0; start < shown.length; start += options.batchSize) {
      batches.push({ pass, batch: start / options.batchSize + 1, items: shown.slice(start, start + options.batchSize) });
    }
  }

  return { batches, key, excluded };
}

const SEVERITIES = new Set<string>(['critical', 'major', 'minor']);

/** 심판 결과 JSON을 읽는다. 묶음의 모든 항목·라벨이 있어야 하고, 없으면 빠진 것을 모두 적어 오류를 낸다. */
export function parseJudgeResult(text: string, batch: JudgeBatch): JudgeVerdict[] {
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`심판 결과(${String(batch.pass)}회차 ${String(batch.batch)}묶음)가 JSON이 아닙니다.`);
  }
  const entries = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(entries)) {
    throw new Error('심판 결과에 items 목록이 없습니다.');
  }
  const byId = new Map<string, { candidates?: unknown }>();
  for (const entry of entries as { id?: unknown; candidates?: unknown }[]) {
    if (typeof entry.id === 'string') {
      byId.set(entry.id, entry);
    }
  }
  const missing: string[] = [];
  const verdicts: JudgeVerdict[] = [];
  for (const item of batch.items) {
    const entry = byId.get(item.id);
    if (entry === undefined) {
      missing.push(item.id);
      continue;
    }
    const candidates = Array.isArray(entry.candidates) ? (entry.candidates as { label?: unknown; errors?: unknown }[]) : [];
    for (const { label } of item.candidates) {
      const found = candidates.find((c) => c.label === label);
      if (found === undefined || !Array.isArray(found.errors)) {
        missing.push(`${item.id}/${label}`);
        continue;
      }
      const errors = (found.errors as { severity?: unknown; category?: unknown; note?: unknown }[]).map((error): JudgeError => {
        if (typeof error.severity !== 'string' || !SEVERITIES.has(error.severity)) {
          throw new Error(`알 수 없는 심각도: ${String(error.severity)} (${item.id}/${label})`);
        }

        return { severity: error.severity as Severity, category: typeof error.category === 'string' ? error.category : '', note: typeof error.note === 'string' ? error.note : '' };
      });
      verdicts.push({ pass: batch.pass, id: item.id, label, errors });
    }
  }
  if (missing.length > 0) {
    throw new Error(`심판 결과에 빠진 것: ${missing.join(', ')}`);
  }

  return verdicts;
}
