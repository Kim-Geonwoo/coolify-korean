import { describe, expect, it } from 'vitest';
import type { DraftStore } from './drafts.ts';
import { sourceHash } from './integrity.ts';
import { applyCachedReviews, applyReviews, reviewQueue } from './reviews.ts';

const meta = (english: string, extra: object = {}) => ({ run: 'r1', sourceHash: sourceHash(english), via: 'mt' as const, ...extra });
const store: DraftStore = {
  drafts: { A: '가', B: '나', C: '다', D: '라', Gone: '없음' },
  meta: {
    A: meta('A'),
    B: meta('B', { review: { verdict: 'ok', reason: '', run: 'v0' } }),
    C: meta('C'),
    D: meta('D'),
    Gone: meta('Gone', { removedIn: '4.4.7' }),
  },
  runs: { r1: { engine: 'index-9b', prompt: 'p', glossary: 'g' } },
};

describe('reviewQueue', () => {
  it('takes unreviewed drafts of the newest version first, skips removed keys and stops at the limit', () => {
    expect(reviewQueue(store, { newest: ['D'], limit: 2 })).toEqual(['D', 'A']);
    expect(reviewQueue(store, { newest: [], limit: 10 })).toEqual(['A', 'C', 'D']);
  });
});

describe('applyReviews', () => {
  it('stores verdicts and suggestions, and marks only major ones for human review when the gate passed', () => {
    const results = [
      { id: 'A', verdict: 'major' as const, reason: '라벨이 문장', fix: '가2' },
      { id: 'C', verdict: 'minor' as const, reason: '띄어쓰기', fix: '다 2' },
      { id: 'D', verdict: 'major' as const, reason: '자리표시자', fixRejected: ['placeholder-mismatch' as const] },
    ];

    const flagged = applyReviews(store, results, { run: 'v1', gatePassed: true });
    expect(flagged.meta.A?.review).toEqual({ verdict: 'major', reason: '라벨이 문장', fix: '가2', run: 'v1', needsReview: true });
    expect(flagged.meta.C?.review).toEqual({ verdict: 'minor', reason: '띄어쓰기', fix: '다 2', run: 'v1' });
    expect(flagged.meta.D?.review).toEqual({ verdict: 'major', reason: '자리표시자', run: 'v1', needsReview: true });
    expect(flagged.drafts).toEqual(store.drafts);

    const suggestions = applyReviews(store, results, { run: 'v1', gatePassed: false });
    expect(suggestions.meta.A?.review).toEqual({ verdict: 'major', reason: '라벨이 문장', fix: '가2', run: 'v1' });
  });

  it('re-applies cached verdicts only to drafts whose English and text are still the ones reviewed', () => {
    const cached = [
      { key: 'A', sourceHash: sourceHash('A'), draft: '가', id: 'A', verdict: 'major' as const, reason: '틀림', run: 'v1' },
      { key: 'C', sourceHash: sourceHash('C (old)'), draft: '다', id: 'C', verdict: 'major' as const, reason: '옛 원문', run: 'v1' },
      { key: 'D', sourceHash: sourceHash('D'), draft: '옛 번역', id: 'D', verdict: 'major' as const, reason: '옛 초안', run: 'v1' },
    ];

    const out = applyCachedReviews(store, cached, { gatePassed: true });

    expect(out.meta.A?.review).toEqual({ verdict: 'major', reason: '틀림', run: 'v1', needsReview: true });
    expect(out.meta.C?.review).toBeUndefined();
    expect(out.meta.D?.review).toBeUndefined();
  });

  it('ignores results for keys that are not drafts any more', () => {
    expect(applyReviews(store, [{ id: 'Z', verdict: 'ok', reason: '' }], { run: 'v1', gatePassed: true }).meta).toEqual(store.meta);
  });
});
