import { describe, expect, it } from 'vitest';
import { failedOnlyByRequests, runBakeoff, runOrder, smokeItems, type BakeoffRecord, type RequestLog } from './bakeoff.ts';
import { EngineError, type Engine, type EngineRequest } from './engines/engine.ts';
import { parseGlossary } from './glossary.ts';
import type { SampleItem } from './sample.ts';

const glossary = parseGlossary({ terms: [{ en: 'Save', ko: '저장' }], brands: [] });

function item(id: string, source: string, extra: Partial<SampleItem> = {}): SampleItem {
  return { id, key: source, source, kind: 'text', file: 'resources/views/x.blade.php', placeholders: [], markup: false, stratum: 'representative', ...extra };
}

const items: SampleItem[] = [
  item('a', 'Save'),
  item('b', 'Deleted :name.', { kind: 'toast', placeholders: ['name'] }),
  item('c', 'Read <0>the guide</0>.', { markup: true }),
];

/** 요청에 든 id만 골라 답하는 가짜 엔진. answers[n]은 n번째 요청의 id → 번역(또는 던질 오류·깨진 본문) */
function engine(answers: (Record<string, string> | EngineError | string)[]): Engine & { requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];

  return {
    requests,
    complete: (request) => {
      requests.push(request);
      const answer = answers[requests.length - 1];
      if (answer instanceof EngineError) {
        return Promise.reject(answer);
      }
      const text = typeof answer === 'string' ? answer : JSON.stringify({ translations: Object.entries(answer ?? {}).map(([id, ko]) => ({ id, ko })) });

      return Promise.resolve({ text, finish: 'stop', ms: 5 });
    },
  };
}

async function run(fake: Engine, list: readonly SampleItem[] = items, batchSize = 3): Promise<{ records: BakeoffRecord[]; requests: RequestLog[]; outcome: Awaited<ReturnType<typeof runBakeoff>> }> {
  const records: BakeoffRecord[] = [];
  const requests: RequestLog[] = [];
  const outcome = await runBakeoff({ items: list, glossary, style: 'generic', schema: true, engine: fake, engineId: 'fake', batchSize, retryBatchSize: 2, sleep: () => Promise.resolve(), onRecord: (r) => records.push(r), onRequest: (r) => requests.push(r) });

  return { records, requests, outcome };
}

describe('runBakeoff', () => {
  it('masks placeholders, retries only failed items once, then falls back to English', async () => {
    const fake = engine([
      { a: '저장'.normalize('NFD'), b: '삭제했습니다.' },
      { b: '{{name}}을(를) 삭제했습니다.', c: '<0>안내서</0를 읽으십시오.' },
    ]);

    const { records, requests, outcome } = await run(fake);

    expect(JSON.stringify(fake.requests[0]?.prompt.user)).toContain('Deleted {{name}}.');
    expect(fake.requests[0]?.schema).toBeDefined();
    expect(records.map((r) => [r.id, r.final, r.fallback, r.attempts.length])).toEqual([
      ['a', '저장', false, 1],
      ['b', ':name을(를) 삭제했습니다.', false, 2],
      ['c', 'Read <0>the guide</0>.', true, 2],
    ]);
    expect(records[1]?.attempts[0]?.issues).toEqual(['placeholder-mismatch']);
    expect(records[2]?.attempts.map((a) => a.issues)).toEqual([['missing'], ['tag-structure']]);
    expect(records[0]?.soft).toMatchObject({ glossaryMissing: [], nounLabel: true });
    expect(records[2]?.soft).toBeNull();
    expect(requests.map((r) => [r.ids, r.retry])).toEqual([[['a', 'b', 'c'], false], [['b', 'c'], true]]);
    expect(outcome).toMatchObject({ records: 3, fallbacks: 1, retried: 2, requests: 2 });
  });

  it('retries a broken answer in small groups', async () => {
    const fake = engine(['not json', { a: '저장', b: '{{name}}을(를) 삭제했습니다.' }, { c: '<0>안내서</0>를 읽으십시오.' }]);

    const { records, requests } = await run(fake);

    expect(records.every((r) => !r.fallback)).toBe(true);
    expect(records[0]?.attempts[0]?.issues).toEqual(['parse-failed']);
    expect(requests.map((r) => r.ids)).toEqual([['a', 'b', 'c'], ['a', 'b'], ['c']]);
    expect(requests.map((r) => r.unparsed)).toEqual(['not json', undefined, undefined]);
  });

  it('records a failed request against every item and still retries them', async () => {
    const fake = engine([new EngineError('http', 'HTTP 400'), { a: '저장', b: '{{name}}을(를) 삭제했습니다.' }, new EngineError('http', 'HTTP 400')]);

    const { records, requests } = await run(fake);

    expect(records.map((r) => r.fallback)).toEqual([false, false, true]);
    expect(records[2]?.attempts.map((a) => a.issues)).toEqual([['request-failed'], ['request-failed']]);
    expect(requests[0]?.error).toBe('http: HTTP 400');
  });

  it('builds prompts with the requested prompt version', async () => {
    const v1 = engine([{ a: '저장' }]);
    const v2 = engine([{ a: '저장' }]);
    const options = { items: [items[0] as SampleItem], glossary, style: 'generic' as const, schema: false, engineId: 'fake', batchSize: 20, retryBatchSize: 5, sleep: () => Promise.resolve(), onRecord: () => undefined, onRequest: () => undefined };

    await runBakeoff({ ...options, engine: v1, promptVersion: 1 });
    await runBakeoff({ ...options, engine: v2 });

    expect(v1.requests[0]?.prompt.system).not.toContain('하십시오');
    expect(v2.requests[0]?.prompt.system).toContain('하십시오');
  });

  it('treats a key as a message when any of its kinds is one, in the prompt and in the hard checks', async () => {
    const both = item('a', 'Saved', { kind: 'prop-text', kinds: ['prop-text', 'toast'] });
    const fake = engine([{ a: '저장했습니다. ' }, { a: '저장했습니다.' }]);
    const records: BakeoffRecord[] = [];

    await runBakeoff({ items: [both], glossary, style: 'index', schema: false, engine: fake, engineId: 'fake', batchSize: 20, retryBatchSize: 5, sleep: () => Promise.resolve(), onRecord: (r) => records.push(r), onRequest: () => undefined, promptVersion: 1 });

    expect(fake.requests[0]?.prompt.user).toContain('以下条目是句子：a');
    expect(records[0]?.attempts.map((a) => a.issues)).toEqual([['whitespace-shape'], []]);
  });

  it('reports waits for per-minute limits', async () => {
    const waits: number[] = [];
    const fake = engine([new EngineError('rate-limit', '429', 1_500), { a: '저장' }]);

    await runBakeoff({ items: [items[0] as SampleItem], glossary, style: 'generic', schema: false, engine: fake, engineId: 'fake', batchSize: 20, retryBatchSize: 5, sleep: () => Promise.resolve(), onRecord: () => undefined, onRequest: () => undefined, onWait: (ms) => waits.push(ms) });

    expect(waits).toEqual([1_500]);
    expect(fake.requests[0]?.schema).toBeUndefined();
  });

  it('stops before recording a batch when the daily limit is reached', async () => {
    const fake = engine([{ a: '저장' }, new EngineError('quota-daily', 'day')]);

    const { records, outcome } = await run(fake, items, 1);

    expect(records.map((r) => r.id)).toEqual(['a']);
    expect(outcome.stopped).toBe('quota-daily');
  });
});

describe('failedOnlyByRequests', () => {
  const base: BakeoffRecord = { engine: 'e', id: 'a', key: 'k', stratum: 'label', kind: 'text', file: 'f', source: 'Save', masked: 'Save', attempts: [], final: 'Save', fallback: true, soft: null };
  const tried = (...issues: string[][]): BakeoffRecord => ({ ...base, attempts: issues.map((list) => ({ raw: null, issues: list as BakeoffRecord['attempts'][number]['issues'] })) });

  it('marks fallbacks caused only by failed requests, not by bad output', () => {
    expect(failedOnlyByRequests(tried(['request-failed'], ['request-failed']))).toBe(true);
    expect(failedOnlyByRequests(tried(['parse-failed'], ['request-failed']))).toBe(false);
    expect(failedOnlyByRequests(tried(['request-failed'], ['placeholder-mismatch']))).toBe(false);
    expect(failedOnlyByRequests({ ...tried(['request-failed']), fallback: false })).toBe(false);
  });
});

describe('run order', () => {
  it('orders by id and picks a smoke set across strata', () => {
    const list = [item('d', 'x', { stratum: 'label' }), item('b', 'x', { stratum: 'tag' }), item('a', 'x', { stratum: 'label' }), item('c', 'x', { stratum: 'representative' })];

    expect(runOrder(list).map((i) => i.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(smokeItems(list, 3).map((i) => i.id)).toEqual(['b', 'a', 'c']);
    expect(smokeItems(list, 10).map((i) => i.id)).toEqual(['b', 'a', 'c', 'd']);
  });
});
