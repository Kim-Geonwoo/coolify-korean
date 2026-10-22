import { describe, expect, it } from 'vitest';
import type { BakeoffRecord } from '../translate/bakeoff.ts';
import { type Engine, type EngineRequest } from '../translate/engines/engine.ts';
import { parseGlossary } from '../translate/glossary.ts';
import type { CatalogEntry } from '../translate/sample.ts';
import { draftItems, isHardKey, translateKeys } from './drafting.ts';

const glossary = parseGlossary({ terms: [], brands: [] });
const entry = (english: string, kinds: string[], placeholders: string[] = []): CatalogEntry => ({ english, markup: false, kinds, placeholders, occurrences: [{ file: 'resources/views/x.blade.php', line: 1, kind: kinds[0] ?? 'text' }] });
const catalog: Record<string, CatalogEntry> = {
  'Restart the server.': entry('Restart the server.', ['text']),
  'Deleted :name.': entry('Deleted :name.', ['toast'], ['name']),
  'auth.failed': entry('These credentials do not match.', ['upstream-lang']),
};

/** 요청에 든 id를 원문으로 되짚어 답하는 가짜 엔진 */
function engine(answer: (source: string) => string | undefined): Engine & { requests: EngineRequest[] } {
  const requests: EngineRequest[] = [];
  const byId = new Map(draftItems(catalog, Object.keys(catalog)).map((item) => [item.id, item.source]));

  return {
    requests,
    complete: (request) => {
      requests.push(request);
      const ids = Object.keys(JSON.parse(/【源文】\n([\s\S]*?)\n【约束要求】/.exec(request.prompt.user)?.[1] ?? '{}') as Record<string, string>);
      const translations = ids.flatMap((id) => {
        const ko = answer(byId.get(id) ?? '');

        return ko === undefined ? [] : [{ id, ko }];
      });

      return Promise.resolve({ text: JSON.stringify({ translations }), finish: 'stop', ms: 1 });
    },
  };
}

const base = { glossary, style: 'index' as const, schema: true, engineId: 'index-9b', run: 'r1', batchSize: 10, retryBatchSize: 5, promptVersion: 1 as const, sleep: () => Promise.resolve(), onRequest: () => undefined };

describe('draftItems', () => {
  it('builds one engine item per key with the source English, all kinds and a stable id', () => {
    const items = draftItems(catalog, ['auth.failed', 'Deleted :name.']);

    expect(items.map((i) => [i.key, i.source, i.kind, i.kinds, i.placeholders])).toEqual([
      ['auth.failed', 'These credentials do not match.', 'upstream-lang', ['upstream-lang'], []],
      ['Deleted :name.', 'Deleted :name.', 'toast', ['toast'], ['name']],
    ]);
    expect(items[0]?.id).toMatch(/^[0-9a-f]{16}$/);
    expect(() => draftItems(catalog, ['missing'])).toThrow(/missing/);
  });
});

describe('translateKeys', () => {
  it('translates, normalizes, keeps a ledger and returns drafts by key', async () => {
    const ledger: BakeoffRecord[] = [];
    const fake = engine((source) => ({ 'Restart the server.': '서버를 다시 시작하십시오.', 'Deleted :name.': '{{name}}를 삭제했습니다.', 'These credentials do not match.': '자격 증명이 일치하지 않습니다.' })[source]);

    const out = await translateKeys({ ...base, catalog, keys: Object.keys(catalog), engine: fake, ledger: new Map(), onRecord: (r) => ledger.push(r) });

    expect(out.translated.get('Restart the server.')).toEqual({ text: '서버를 다시 시작하세요.', run: 'r1', edits: [{ rule: 'imperative', before: '십시오', after: '세요' }] });
    expect(out.translated.get('Deleted :name.')?.text).toBe(':name을(를) 삭제했습니다.');
    expect(out.translated.get('auth.failed')).toEqual({ text: '자격 증명이 일치하지 않습니다.', run: 'r1' });
    expect(ledger).toHaveLength(3);
    expect(out).toMatchObject({ fallbacks: [], resumed: 0 });
  });

  it('resumes from the ledger, keeps output failures as failures and retries only API failures', async () => {
    const [restart, deleted, failed] = draftItems(catalog, ['Restart the server.', 'Deleted :name.', 'auth.failed']);
    const record = (id: string, final: string, fallback: boolean, issues: string[]): BakeoffRecord => ({ engine: 'index-9b', id, key: '', stratum: 'representative', kind: 'text', file: '', source: '', masked: '', attempts: [{ raw: null, issues: issues as BakeoffRecord['attempts'][number]['issues'] }], final, fallback, soft: null });
    const ledger = new Map([
      [restart?.id ?? '', record(restart?.id ?? '', '서버를 다시 시작합니다.', false, [])],
      [deleted?.id ?? '', record(deleted?.id ?? '', 'Deleted :name.', true, ['placeholder-mismatch'])],
      [failed?.id ?? '', record(failed?.id ?? '', 'These credentials do not match.', true, ['request-failed'])],
    ]);
    const fake = engine(() => '자격 증명이 일치하지 않습니다.');

    const out = await translateKeys({ ...base, catalog, keys: Object.keys(catalog), engine: fake, ledger, onRecord: () => undefined });

    expect(fake.requests).toHaveLength(1);
    expect([...out.translated.keys()].sort()).toEqual(['Restart the server.', 'auth.failed']);
    expect(out).toMatchObject({ fallbacks: ['Deleted :name.'], resumed: 2 });
  });
});

describe('isHardKey', () => {
  it('sends placeholders, numbered tags and long texts to the stronger engine', () => {
    expect(isHardKey(entry('Deleted :name.', ['toast'], ['name']))).toBe(true);
    expect(isHardKey(entry('Too many attempts. Wait :seconds seconds.', ['upstream-lang']))).toBe(true);
    expect(isHardKey({ ...entry('Read <0>the guide</0>.', ['text']), markup: true })).toBe(true);
    expect(isHardKey(entry('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen', ['text']))).toBe(true);
    expect(isHardKey(entry('one two three four five six seven eight nine ten eleven twelve thirteen fourteen', ['text']))).toBe(false);
    expect(isHardKey(entry('Restart the server.', ['text']))).toBe(false);
  });
});
