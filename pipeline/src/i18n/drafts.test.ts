import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyDrafts, pendingKeys, readStore, resultsFromPlan, writeStore, type DraftMeta, type DraftStore } from './drafts.ts';
import { checkIntegrity, sourceHash } from './integrity.ts';
import type { CatalogLite } from './memory.ts';

const entry = (english: string, placeholders: string[] = []) => ({ english, kinds: ['text'], placeholders });
const run = { engine: 'index-9b', prompt: 'p1', glossary: 'g1' };

describe('resultsFromPlan', () => {
  it('turns memory hits into results, copies shared keys from their translated twin and drops what the engine failed', () => {
    const plan = [
      { key: 'A', kind: 'mt' as const },
      { key: 'B', kind: 'tm-exact' as const, from: 'Old', text: '저장' },
      { key: 'C', kind: 'shared' as const, from: 'A' },
      { key: 'D', kind: 'mt' as const },
      { key: 'E', kind: 'shared' as const, from: 'D' },
    ];
    const translated = new Map([['A', { text: '가', run: 'r-mt', edits: [{ rule: 'imperative', before: '하십시오', after: '하세요' }] }]]);

    expect(resultsFromPlan(plan, translated, 'r-tm')).toEqual(
      new Map([
        ['A', { text: '가', run: 'r-mt', via: 'mt', edits: [{ rule: 'imperative', before: '하십시오', after: '하세요' }] }],
        ['B', { text: '저장', run: 'r-tm', via: 'tm-exact', from: 'Old' }],
        ['C', { text: '가', run: 'r-mt', via: 'shared', from: 'A', edits: [{ rule: 'imperative', before: '하십시오', after: '하세요' }] }],
      ]),
    );
  });
});

describe('applyDrafts', () => {
  const previous: CatalogLite = { version: '4.4.5', keys: { Save: entry('Save'), Old: entry('Old'), 'auth.throttle': entry('Too many attempts.') } };
  const next: CatalogLite = { version: '4.4.6', keys: { Save: entry('Save'), New: entry('New :name', ['name']), 'auth.throttle': entry('Too many login attempts.'), Broken: entry('Broken :x', ['x']) } };
  const store: DraftStore = {
    drafts: { Save: '저장', Old: '옛것', 'auth.throttle': '시도가 너무 많습니다.', Gone: '사라짐' },
    meta: {
      Save: { run: 'r0', sourceHash: sourceHash('Save'), via: 'mt' },
      Old: { run: 'r0', sourceHash: sourceHash('Old'), via: 'mt' },
      'auth.throttle': { run: 'r0', sourceHash: sourceHash('Too many attempts.'), via: 'mt' },
      Gone: { run: 'r0', sourceHash: sourceHash('Gone'), via: 'mt', removedIn: '4.4.3' },
    },
    runs: { r0: run },
  };

  it('adds new keys, replaces changed ones, keeps existing values, marks removed keys and drops them after three versions', () => {
    const results = new Map([
      ['New', { text: ':name 새로 만들기', run: 'r1', via: 'mt' as const }],
      ['auth.throttle', { text: '로그인 시도가 너무 많습니다.', run: 'r1', via: 'mt' as const }],
      ['Save', { text: '저장하기', run: 'r1', via: 'mt' as const }],
      ['Broken', { text: '고장', run: 'r1', via: 'mt' as const }],
    ]);

    const out = applyDrafts({ store, previous, next, results, runs: { r1: run }, history: ['4.4.3', '4.4.4', '4.4.5', '4.4.6'], keepVersions: 3, exclusions: new Map() });

    expect(out.store.drafts).toEqual({ Save: '저장', Old: '옛것', New: ':name 새로 만들기', 'auth.throttle': '로그인 시도가 너무 많습니다.' });
    expect(out.store.meta.Old).toEqual({ run: 'r0', sourceHash: sourceHash('Old'), via: 'mt', removedIn: '4.4.6' });
    expect(out.store.meta.New).toEqual({ run: 'r1', sourceHash: sourceHash('New :name'), via: 'mt' });
    expect(out.store.meta.Gone).toBeUndefined();
    expect(out.store.runs).toEqual({ r0: run, r1: run });
    expect(out.rejected).toEqual([{ key: 'Broken', issues: ['placeholder-mismatch'] }]);
    expect(out.increment).toEqual({ version: '4.4.6', added: ['Broken', 'New'], changed: ['auth.throttle'], removed: ['Old'], drafted: 2 });
    expect(checkIntegrity({ catalog: next, stateVersion: '4.4.6', exclusions: new Map(), drafts: out.store.drafts, meta: out.store.meta, runs: out.store.runs })).toEqual([]);
  });

  it('drops a stale draft whose English changed when no new translation came back', () => {
    const out = applyDrafts({ store, previous, next, results: new Map(), runs: {}, history: ['4.4.5', '4.4.6'], keepVersions: 3, exclusions: new Map() });

    expect(out.store.drafts['auth.throttle']).toBeUndefined();
    expect(out.store.meta['auth.throttle']).toBeUndefined();
    expect(out.store.runs).toEqual({ r0: run });
  });

  it('replaces existing values only for the keys it is told to (an import from a stronger engine)', () => {
    const out = applyDrafts({ store, previous: next, next, results: new Map([['Save', { text: '저장하기', run: 'r2', via: 'mt' as const }]]), runs: { r2: run }, history: ['4.4.6'], keepVersions: 3, exclusions: new Map(), replace: new Set(['Save']) });

    expect(out.store.drafts.Save).toBe('저장하기');
    expect(out.store.meta.Save).toEqual({ run: 'r2', sourceHash: sourceHash('Save'), via: 'mt' });
    expect(out.increment.drafted).toBe(1);
  });

  it('rejects a translation that drops a confirmation text the user has to type verbatim', () => {
    const confirm: CatalogLite = { version: '4.4.6', keys: { 'Type cleanup deleted backups to confirm.': entry('Type cleanup deleted backups to confirm.') } };
    const results = new Map([['Type cleanup deleted backups to confirm.', { text: '확인하려면 삭제된 백업을 정리한다고 입력하세요.', run: 'r1', via: 'mt' as const }]]);

    const out = applyDrafts({ store: { drafts: {}, meta: {}, runs: {} }, previous: { version: '', keys: {} }, next: confirm, results, runs: { r1: run }, history: ['4.4.6'], keepVersions: 3, exclusions: new Map(), verbatim: ['cleanup deleted backups'] });

    expect(out.store.drafts).toEqual({});
    expect(out.rejected).toEqual([{ key: 'Type cleanup deleted backups to confirm.', issues: ['verbatim'] }]);
  });

  it('lists the keys that still need a draft', () => {
    expect(pendingKeys(next, { drafts: { Save: '저장', 'auth.throttle': '시도가 너무 많습니다.' }, meta: { Save: store.meta.Save as DraftMeta, 'auth.throttle': store.meta['auth.throttle'] as DraftMeta }, runs: {} }, new Map([['Broken', '예시']]))).toEqual(['New', 'auth.throttle']);
  });

  it('never writes excluded keys or keys outside the catalog', () => {
    const out = applyDrafts({
      store: { drafts: {}, meta: {}, runs: {} },
      previous: { version: '4.4.5', keys: {} },
      next: { version: '4.4.6', keys: { nginx: entry('nginx') } },
      results: new Map([['nginx', { text: '엔진엑스', run: 'r1', via: 'mt' as const }], ['ghost', { text: '유령', run: 'r1', via: 'mt' as const }]]),
      runs: { r1: run },
      history: ['4.4.6'],
      keepVersions: 3,
      exclusions: new Map([['nginx', '예시 값']]),
    });

    expect(out.store.drafts).toEqual({});
    expect(out.store.runs).toEqual({});
    expect(out.rejected).toEqual([{ key: 'ghost', issues: ['unknown-key'] }, { key: 'nginx', issues: ['excluded'] }]);
  });
});

describe('readStore / writeStore', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts empty, writes canonical files with the increment and reads them back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drafts-'));
    dirs.push(dir);
    expect(readStore(dir, 'ko')).toEqual({ drafts: {}, meta: {}, runs: {} });

    const store: DraftStore = { drafts: { b: '나', a: '가' }, meta: { a: { run: 'r1', sourceHash: 'h', via: 'mt' }, b: { run: 'r1', sourceHash: 'h', via: 'mt' } }, runs: { r1: run } };
    writeStore(dir, 'ko', store, { version: '4.4.6', added: ['a', 'b'], changed: [], removed: [], drafted: 2 });

    expect(readStore(dir, 'ko')).toEqual(store);
    expect(readFileSync(join(dir, 'ko.json'), 'utf8')).toBe('{\n  "a": "가",\n  "b": "나"\n}\n');
    expect(JSON.parse(readFileSync(join(dir, 'increments', '4.4.6.json'), 'utf8'))).toEqual({ version: '4.4.6', added: ['a', 'b'], changed: [], removed: [], drafted: 2 });
  });
});
