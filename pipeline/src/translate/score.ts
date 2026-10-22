import { createHash } from 'node:crypto';
import type { JudgeKey, JudgeVerdict } from './judge.ts';

/** MQM-lite 가중치. 치명은 두 회차가 모두 달았을 때만 25, 아니면 중대(5)로 낮춘다 */
export const WEIGHTS = { critical: 25, major: 5, minor: 1 } as const;
/** 영어로 폴백한 항목의 고정 감점(번역 안 됨 = 중대 하나) */
export const FALLBACK_PENALTY = 5;

export interface ItemPenalty {
  /** 두 회차 평균 감점 */
  readonly penalty: number;
  /** 두 회차 평균 중대 수(낮춘 치명 포함) */
  readonly majors: number;
  /** 두 회차가 모두 단 치명 수 */
  readonly criticals: number;
  readonly fallback: boolean;
}

interface PassCount {
  critical: number;
  major: number;
  minor: number;
}

/** 엔진 → 항목 id → 감점. 라벨은 key로 엔진에 되돌린다 */
export function itemPenalties(verdicts: readonly JudgeVerdict[], key: JudgeKey, excluded: readonly { engine: string; id: string }[]): Map<string, Map<string, ItemPenalty>> {
  const passes = new Map<string, Map<string, Map<number, PassCount>>>();
  for (const verdict of verdicts) {
    const engine = key[`${String(verdict.pass)}:${verdict.id}`]?.[verdict.label];
    if (engine === undefined) {
      throw new Error(`라벨을 엔진으로 되돌릴 수 없습니다: ${String(verdict.pass)}:${verdict.id}/${verdict.label}`);
    }
    const byId = passes.get(engine) ?? new Map<string, Map<number, PassCount>>();
    passes.set(engine, byId);
    const byPass = byId.get(verdict.id) ?? new Map<number, PassCount>();
    byId.set(verdict.id, byPass);
    const count = byPass.get(verdict.pass) ?? { critical: 0, major: 0, minor: 0 };
    byPass.set(verdict.pass, count);
    for (const error of verdict.errors) {
      count[error.severity]++;
    }
  }
  const out = new Map<string, Map<string, ItemPenalty>>();
  for (const [engine, byId] of passes) {
    const scored = new Map<string, ItemPenalty>();
    for (const [id, byPass] of byId) {
      const counts = [...byPass.values()];
      const confirmed = counts.length > 0 && counts.every((c) => c.critical > 0);
      const penalty = counts.reduce((sum, c) => sum + c.critical * (confirmed ? WEIGHTS.critical : WEIGHTS.major) + c.major * WEIGHTS.major + c.minor * WEIGHTS.minor, 0) / counts.length;
      const majors = counts.reduce((sum, c) => sum + c.major + (confirmed ? 0 : c.critical), 0) / counts.length;
      scored.set(id, { penalty, majors, criticals: confirmed ? Math.min(...counts.map((c) => c.critical)) : 0, fallback: false });
    }
    out.set(engine, scored);
  }
  for (const { engine, id } of excluded) {
    const scored = out.get(engine) ?? new Map<string, ItemPenalty>();
    out.set(engine, scored);
    scored.set(id, { penalty: FALLBACK_PENALTY, majors: 0, criticals: 0, fallback: true });
  }

  return out;
}

export interface ScoredItem {
  readonly id: string;
  readonly stratum: string;
  /** 원문 영어 단어 수 */
  readonly words: number;
  /** 엔진 → 감점 */
  readonly penalty: Readonly<Record<string, number>>;
}

function per100(items: readonly ScoredItem[], engine: string): number {
  const words = items.reduce((sum, item) => sum + item.words, 0);

  return words === 0 ? 0 : (items.reduce((sum, item) => sum + (item.penalty[engine] ?? 0), 0) / words) * 100;
}

/** 원문 100단어당 감점(낮을수록 좋음): 전체와 층별 */
export function stratumScores(items: readonly ScoredItem[], engines: readonly string[]): { overall: Record<string, number>; byStratum: Record<string, Record<string, number>> } {
  const strata = [...new Set(items.map((item) => item.stratum))];

  return {
    overall: Object.fromEntries(engines.map((engine) => [engine, per100(items, engine)])),
    byStratum: Object.fromEntries(strata.map((stratum) => [stratum, Object.fromEntries(engines.map((engine) => [engine, per100(items.filter((item) => item.stratum === stratum), engine)]))])),
  };
}

function prng(seed: string): () => number {
  let state = Number.parseInt(createHash('sha256').update(seed).digest('hex').slice(0, 8), 16) >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 엔진 a − b의 100단어당 감점 차이와 층화 부트스트랩 95% 구간. 구간이 0을 넘으면 a가 확실히 더 나쁘다 */
export function bootstrapDifference(items: readonly ScoredItem[], a: string, b: string, iterations: number, seed: string): { estimate: number; low: number; high: number } {
  const random = prng(seed);
  const strata = [...new Set(items.map((item) => item.stratum))].map((stratum) => items.filter((item) => item.stratum === stratum));
  const diffs: number[] = [];
  for (let n = 0; n < iterations; n++) {
    const resampled = strata.flatMap((group) => group.map(() => group[Math.floor(random() * group.length)] as ScoredItem));
    diffs.push(per100(resampled, a) - per100(resampled, b));
  }
  diffs.sort((x, y) => x - y);

  return {
    estimate: per100(items, a) - per100(items, b),
    low: diffs[Math.floor(0.025 * (diffs.length - 1))] ?? 0,
    high: diffs[Math.ceil(0.975 * (diffs.length - 1))] ?? 0,
  };
}
