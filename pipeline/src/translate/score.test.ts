import { describe, expect, it } from 'vitest';
import type { JudgeKey, JudgeVerdict } from './judge.ts';
import { bootstrapDifference, itemPenalties, stratumScores, type ScoredItem } from './score.ts';

const key: JudgeKey = { '1:aa': { A: 'e1', B: 'e2' }, '2:aa': { A: 'e2', B: 'e1' }, '1:bb': { A: 'e1' }, '2:bb': { A: 'e1' } };

function verdict(pass: number, id: string, label: string, severities: ('critical' | 'major' | 'minor')[]): JudgeVerdict {
  return { pass, id, label, errors: severities.map((severity) => ({ severity, category: 'accuracy', note: '' })) };
}

describe('itemPenalties', () => {
  it('averages the two passes, counting critical only when both passes found one', () => {
    const verdicts = [
      verdict(1, 'aa', 'A', ['critical']), // e1: 1회차 치명
      verdict(1, 'aa', 'B', ['minor']), // e2
      verdict(2, 'aa', 'A', ['minor', 'minor']), // e2
      verdict(2, 'aa', 'B', ['major']), // e1: 2회차 중대만 → 치명은 중대로 낮춘다
      verdict(1, 'bb', 'A', ['critical']),
      verdict(2, 'bb', 'A', ['critical', 'minor']), // e1: 두 회차 모두 치명 → 25
    ];

    const penalties = itemPenalties(verdicts, key, [{ engine: 'e2', id: 'bb' }]);

    expect(penalties.get('e1')?.get('aa')).toEqual({ penalty: 5, majors: 1, criticals: 0, fallback: false });
    expect(penalties.get('e2')?.get('aa')).toEqual({ penalty: 1.5, majors: 0, criticals: 0, fallback: false });
    expect(penalties.get('e1')?.get('bb')).toEqual({ penalty: 25.5, majors: 0, criticals: 1, fallback: false });
    expect(penalties.get('e2')?.get('bb')).toEqual({ penalty: 5, majors: 0, criticals: 0, fallback: true });
  });
});

const items: ScoredItem[] = [
  { id: 'a', stratum: 'label', words: 2, penalty: { x: 0, y: 5 } },
  { id: 'b', stratum: 'label', words: 2, penalty: { x: 1, y: 0 } },
  { id: 'c', stratum: 'representative', words: 10, penalty: { x: 2, y: 4 } },
  { id: 'd', stratum: 'representative', words: 10, penalty: { x: 0, y: 6 } },
];

describe('stratumScores', () => {
  it('reports penalty per 100 source words overall and per stratum', () => {
    const scores = stratumScores(items, ['x', 'y']);

    expect(scores.overall).toEqual({ x: 12.5, y: 62.5 });
    expect(scores.byStratum['label']).toEqual({ x: 25, y: 125 });
    expect(scores.byStratum['representative']).toEqual({ x: 10, y: 50 });
  });
});

describe('bootstrapDifference', () => {
  it('gives a deterministic interval that excludes zero when one engine is clearly worse', () => {
    const first = bootstrapDifference(items, 'y', 'x', 500, 'seed');
    const second = bootstrapDifference(items, 'y', 'x', 500, 'seed');

    expect(first).toEqual(second);
    expect(first.estimate).toBe(50);
    expect(first.low).toBeGreaterThan(0);
    expect(first.high).toBeGreaterThanOrEqual(first.low);
  });
});
