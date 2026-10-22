import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson, checkIntegrity, sourceHash, type IntegrityInput } from './integrity.ts';

const catalog = {
  version: '4.4.6',
  keys: {
    'Delete :name?': { english: 'Delete :name?', kinds: ['text'], placeholders: ['name'] },
    'auth.throttle': { english: 'Too many attempts. Wait :seconds seconds.', kinds: ['upstream-lang'], placeholders: [] },
    nginx: { english: 'nginx', kinds: ['prop-text'], placeholders: [] },
  },
};

function input(extra: Partial<IntegrityInput> = {}): IntegrityInput {
  return { catalog, stateVersion: '4.4.6', exclusions: new Map([['nginx', '예시 값']]), ...extra };
}

describe('checkIntegrity', () => {
  it('passes matching versions and clean drafts', () => {
    const drafts = { 'Delete :name?': ':name을(를) 삭제하시겠습니까?' };
    const meta = { 'Delete :name?': { run: 'r1', sourceHash: sourceHash('Delete :name?') } };

    expect(checkIntegrity(input({ drafts, meta, runs: { r1: {} } }))).toEqual([]);
  });

  it('reports version drift, unknown and excluded keys, hard issues and stale sources', () => {
    const drafts = { 'Gone key': '없어짐', nginx: '엔진엑스', 'Delete :name?': '삭제하시겠습니까?', 'auth.throttle': ':seconds초 기다리세요.' };
    const meta = {
      'Gone key': { run: 'r1', sourceHash: 'x' },
      nginx: { run: 'r1', sourceHash: sourceHash('nginx') },
      'Delete :name?': { run: 'r1', sourceHash: sourceHash('Delete :name?') },
      'auth.throttle': { run: 'r9', sourceHash: sourceHash('Old English') },
    };

    expect(checkIntegrity(input({ stateVersion: '4.4.7', drafts, meta, runs: { r1: {} } }))).toEqual([
      'state.json 버전 4.4.7이 카탈로그 버전 4.4.6과 다릅니다.',
      '초안 키가 카탈로그에 없습니다: Gone key',
      '번역 제외 키에 초안이 있습니다: nginx',
      '초안이 하드 검사에 걸립니다: Delete :name? (placeholder-mismatch)',
      '원문이 바뀐 뒤 그대로인 초안: auth.throttle',
      '메타의 실행 기록이 없습니다: auth.throttle (r9)',
    ]);
  });

  it('keeps keys marked removed until they are dropped', () => {
    const drafts = { 'Gone key': '없어짐' };
    const meta = { 'Gone key': { run: 'r1', sourceHash: 'x', removedIn: '4.4.6' } };

    expect(checkIntegrity(input({ drafts, meta, runs: { r1: {} } }))).toEqual([]);
  });

  it('reports drafts that dropped a confirmation text the user types verbatim', () => {
    const confirm = { version: '4.4.6', keys: { 'Type cleanup deleted backups to confirm.': { english: 'Type cleanup deleted backups to confirm.', kinds: ['prop-text'], placeholders: [] } } };
    const drafts = { 'Type cleanup deleted backups to confirm.': '확인하려면 삭제된 백업을 정리한다고 입력하세요.' };
    const meta = { 'Type cleanup deleted backups to confirm.': { run: 'r1', sourceHash: sourceHash('Type cleanup deleted backups to confirm.') } };

    expect(checkIntegrity({ catalog: confirm, stateVersion: '4.4.6', exclusions: new Map(), drafts, meta, runs: { r1: {} }, verbatim: ['cleanup deleted backups'] })).toEqual(['확인 문구를 그대로 두지 않은 초안: Type cleanup deleted backups to confirm. (cleanup deleted backups)']);
  });

  it('checks reviewed and pending translations from Weblate and the release switch, independently of drafts', () => {
    const reviewed = { 'Delete :name?': ':name을(를) 삭제하시겠습니까?' };
    const reviewedMeta = { 'Delete :name?': { sourceHash: sourceHash('Delete :name?') } };

    expect(checkIntegrity(input({ reviewed, reviewedMeta, pending: { 'Delete :name?': ':name을(를) 지우시겠습니까?' }, release: { mode: 'reviewed' } }))).toEqual([]);
    expect(checkIntegrity(input({ release: { mode: 'drafts' } }))).toEqual([]);
  });

  it('reports reviewed translations that are unknown, excluded, broken, stale or without meta, and a bad release mode', () => {
    const reviewed = { 'Gone key': '없어짐', nginx: '엔진엑스', 'Delete :name?': '삭제하시겠습니까?', 'auth.throttle': ':seconds초 기다리세요.' };
    const reviewedMeta = { nginx: { sourceHash: sourceHash('nginx') }, 'Delete :name?': { sourceHash: sourceHash('Delete :name?') }, 'auth.throttle': { sourceHash: sourceHash('Old English') } };

    expect(checkIntegrity(input({ reviewed, reviewedMeta, pending: { 'Other gone': '없음', 'Delete :name?': '삭제' }, release: { mode: 'all' } }))).toEqual([
      '검수 번역 키가 카탈로그에 없습니다: Gone key',
      '번역 제외 키에 검수 번역이 있습니다: nginx',
      '검수 번역이 하드 검사에 걸립니다: Delete :name? (placeholder-mismatch)',
      '검수 뒤 원문이 바뀐 번역: auth.throttle',
      '메타가 없는 검수 번역: Gone key',
      '승인 전 번역 키가 카탈로그에 없습니다: Other gone',
      '승인 전 번역이 하드 검사에 걸립니다: Delete :name? (placeholder-mismatch)',
      'release.json mode는 reviewed 또는 drafts여야 합니다.',
    ]);
  });

  it('treats a dropped confirmation text in a reviewed translation as a hard issue', () => {
    const confirm = { version: '4.4.6', keys: { 'Type cleanup deleted backups to confirm.': { english: 'Type cleanup deleted backups to confirm.', kinds: ['prop-text'], placeholders: [] } } };
    const key = 'Type cleanup deleted backups to confirm.';

    expect(checkIntegrity({ catalog: confirm, stateVersion: '4.4.6', exclusions: new Map(), verbatim: ['cleanup deleted backups'], reviewed: { [key]: '확인하려면 정리한다고 입력하세요.' }, reviewedMeta: { [key]: { sourceHash: sourceHash(key) } } })).toEqual([
      `검수 번역이 하드 검사에 걸립니다: ${key} (verbatim)`,
    ]);
  });

  it('requires a meta entry for every draft', () => {
    expect(checkIntegrity(input({ drafts: { 'Delete :name?': ':name을(를) 삭제하시겠습니까?' }, meta: {}, runs: {} }))).toEqual(['메타가 없는 초안: Delete :name?']);
  });
});

describe('canonicalJson', () => {
  it('sorts keys and ends with a newline so diffs stay small', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{\n  "a": {\n    "c": 3,\n    "d": 2\n  },\n  "b": 1\n}\n');
  });
});

describe('repository i18n files', () => {
  const root = join(import.meta.dirname, '..', '..', '..');
  const read = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;

  it('are consistent with each other', () => {
    const drafts = existsSync(join(root, 'i18n/drafts/ko.json')) ? (read('i18n/drafts/ko.json') as Record<string, string>) : undefined;
    const problems = checkIntegrity({
      catalog: read('i18n/catalog.json') as IntegrityInput['catalog'],
      stateVersion: (read('i18n/state.json') as { upstream: { version: string } }).upstream.version,
      exclusions: new Map(Object.entries((read('i18n/exclude.json') as { keys: Record<string, string> }).keys)),
      ...(existsSync(join(root, 'i18n/verbatim.json')) ? { verbatim: (read('i18n/verbatim.json') as { literals: string[] }).literals } : {}),
      ...(drafts === undefined ? {} : { drafts, meta: read('i18n/drafts/ko.meta.json') as IntegrityInput['meta'] & object, runs: read('i18n/drafts/runs.json') as Record<string, unknown> }),
      ...(existsSync(join(root, 'i18n/reviewed/ko.json')) ? { reviewed: read('i18n/reviewed/ko.json') as Record<string, string>, reviewedMeta: read('i18n/reviewed/ko.meta.json') as Record<string, { sourceHash: string }> } : {}),
      ...(existsSync(join(root, 'i18n/pending/ko.json')) ? { pending: read('i18n/pending/ko.json') as Record<string, string> } : {}),
      ...(existsSync(join(root, 'i18n/release.json')) ? { release: read('i18n/release.json') } : {}),
    });

    expect(problems).toEqual([]);
    for (const path of ['i18n/state.json', 'i18n/exclude.json', 'i18n/verbatim.json', 'i18n/release.json', 'i18n/drafts/ko.json', 'i18n/drafts/ko.meta.json', 'i18n/drafts/runs.json', 'i18n/reviewed/ko.json', 'i18n/reviewed/ko.meta.json', 'i18n/pending/ko.json']) {
      if (existsSync(join(root, path))) {
        expect(readFileSync(join(root, path), 'utf8'), path).toBe(canonicalJson(read(path)));
      }
    }
  });
});
