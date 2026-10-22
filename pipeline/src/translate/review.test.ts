import { describe, expect, it } from 'vitest';
import { EngineError, type Engine, type EngineRequest } from './engines/engine.ts';
import { parseGlossary } from './glossary.ts';
import { buildReviewPrompt, parseReview, reviewFailed, runReview, type ReviewItem, type ReviewResult } from './review.ts';

const glossary = parseGlossary({ terms: [{ en: 'Server', ko: '서버' }, { en: 'Registry', ko: '레지스트리' }], brands: ['Docker'] });
const items: ReviewItem[] = [
  { id: 'a', source: 'Restart the server.', draft: '서버를 다시 시작하세요.', kind: 'toast', file: 'x.php', placeholders: [] },
  { id: 'b', source: 'Log in to :registry', draft: ':registry에 로그인하세요', kind: 'prop-text', file: 'y.blade.php', placeholders: ['registry'] },
];

describe('buildReviewPrompt', () => {
  it('gives the style rules, the glossary terms of the batch and every source with its draft', () => {
    const prompt = buildReviewPrompt(items, glossary);

    expect(prompt.system).toContain('하세요');
    expect(prompt.system).toContain('을(를)');
    expect(prompt.system).toContain('major');
    // 2a Opus 심판과 같은 기준(라벨을 문장으로 쓰면 중대, 남은 하십시오는 경미 — 정규화가 고친다)
    expect(prompt.system).toContain('written as a full sentence');
    expect(prompt.system).toContain('already post-processed');
    expect(prompt.system).toMatch(/minor:[^\n]*하십시오/);
    expect(prompt.user).toContain('Server → 서버');
    expect(prompt.user).not.toContain('레지스트리');
    expect(JSON.parse(prompt.user.slice(prompt.user.indexOf('['))) as unknown).toEqual([
      { id: 'a', kind: 'toast', file: 'x.php', source: 'Restart the server.', draft: '서버를 다시 시작하세요.' },
      { id: 'b', kind: 'prop-text', file: 'y.blade.php', source: 'Log in to :registry', draft: ':registry에 로그인하세요' },
    ]);
  });
});

describe('parseReview', () => {
  it('reads verdicts for known ids and rejects unknown verdicts', () => {
    const text = JSON.stringify({ reviews: [{ id: 'a', verdict: 'ok', fix: '', reason: '' }, { id: 'b', verdict: 'major', fix: ':registry 로그인', reason: '라벨이 문장' }, { id: 'z', verdict: 'ok', fix: '', reason: '' }] });

    expect(parseReview(text, ['a', 'b'])).toEqual(new Map([['a', { verdict: 'ok', fix: '', reason: '' }], ['b', { verdict: 'major', fix: ':registry 로그인', reason: '라벨이 문장' }]]));
    expect(() => parseReview(JSON.stringify({ reviews: [{ id: 'a', verdict: 'bad', fix: '', reason: '' }] }), ['a'])).toThrow(/bad/);
  });
});

function engine(answers: (string | EngineError)[]): Engine & { requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];

  return {
    requests,
    complete: (request) => {
      requests.push(request);
      const answer = answers[requests.length - 1];

      return answer instanceof EngineError ? Promise.reject(answer) : Promise.resolve({ text: answer ?? '{}', finish: 'stop', ms: 1 });
    },
  };
}

describe('runReview', () => {
  it('keeps a fix only when it passes the hard checks, and asks again for missing ids once', async () => {
    const fake = engine([
      JSON.stringify({ reviews: [{ id: 'b', verdict: 'major', fix: '레지스트리 로그인', reason: '라벨이 문장' }] }),
      JSON.stringify({ reviews: [{ id: 'a', verdict: 'ok', fix: '', reason: '' }] }),
    ]);
    const results: ReviewResult[] = [];

    const outcome = await runReview({ items, glossary, engine: fake, batchSize: 20, sleep: () => Promise.resolve(), onResult: (r) => results.push(r) });

    expect(results).toEqual([
      { id: 'b', verdict: 'major', reason: '라벨이 문장', fixRejected: ['placeholder-mismatch'] },
      { id: 'a', verdict: 'ok', reason: '' },
    ]);
    expect(outcome).toEqual({ reviewed: 2, missing: 0, requests: 2 });
    expect(fake.requests[0]?.schema).toBeDefined();
  });

  it('counts a run where every request failed as a failure, but not one stopped by the daily limit', () => {
    expect(reviewFailed({ reviewed: 0, missing: 2, requests: 3 })).toBe(true);
    expect(reviewFailed({ reviewed: 0, missing: 2, requests: 1, stopped: 'quota-daily' })).toBe(false);
    expect(reviewFailed({ reviewed: 1, missing: 1, requests: 3 })).toBe(false);
    expect(reviewFailed({ reviewed: 0, missing: 0, requests: 0 })).toBe(false);
  });

  it('stops quietly at the daily limit and reports what is left', async () => {
    const fake = engine([new EngineError('quota-daily', 'day')]);

    expect(await runReview({ items, glossary, engine: fake, batchSize: 20, sleep: () => Promise.resolve(), onResult: () => undefined })).toEqual({ reviewed: 0, missing: 2, requests: 1, stopped: 'quota-daily' });
  });
});
