import { describe, expect, it } from 'vitest';
import { diffCatalogs, planDrafts, type CatalogLite } from './memory.ts';

const entry = (english: string, placeholders: string[] = []) => ({ english, kinds: ['text'], placeholders });

describe('diffCatalogs', () => {
  it('finds added, removed and changed keys (an upstream dot key whose English changed)', () => {
    const previous: CatalogLite = { version: '4.4.5', keys: { Save: entry('Save'), Old: entry('Old'), 'auth.throttle': entry('Too many attempts.') } };
    const next: CatalogLite = { version: '4.4.6', keys: { Save: entry('Save'), New: entry('New'), 'auth.throttle': entry('Too many login attempts.') } };

    expect(diffCatalogs(previous, next)).toEqual({ added: ['New'], removed: ['Old'], changed: ['auth.throttle'] });
  });
});

describe('planDrafts', () => {
  const drafts = { 'Delete :name?': ':name을(를) 삭제하시겠습니까?', Save: '저장', 'Restart the server.': '서버를 다시 시작합니다.' };
  const catalog: CatalogLite = {
    version: '4.4.7',
    keys: {
      'Delete :name?': entry('Delete :name?', ['name']),
      Save: entry('Save'),
      'Restart the server.': entry('Restart the server.'),
      'Delete :server?': entry('Delete :server?', ['server']),
      'button.save': entry('Save'),
      'Restart the server': entry('Restart the server'),
      'Brand new text': entry('Brand new text'),
      'dup.key': entry('Brand new text'),
      nginx: entry('nginx'),
    },
  };

  it('reuses, renames, flags near matches, shares duplicates and sends only the rest to the engine', () => {
    const plan = planDrafts({ catalog, drafts, exclusions: new Map([['nginx', '예시 값']]), keys: ['Delete :server?', 'button.save', 'Restart the server', 'Brand new text', 'dup.key', 'nginx'] });

    expect(plan).toEqual([
      { key: 'Brand new text', kind: 'mt' },
      { key: 'Delete :server?', kind: 'tm-rename', from: 'Delete :name?', text: ':server을(를) 삭제하시겠습니까?' },
      { key: 'Restart the server', kind: 'tm-near', from: 'Restart the server.', text: '서버를 다시 시작합니다.' },
      { key: 'button.save', kind: 'tm-exact', from: 'Save', text: '저장' },
      { key: 'dup.key', kind: 'shared', from: 'Brand new text' },
    ]);
  });

  it('renames each placeholder by position, keeping case variants', () => {
    const plan = planDrafts({
      catalog: { version: '1', keys: { 'Copy :name to :Target': entry('Copy :name to :Target', ['name', 'target']), 'Copy :src to :Dest': entry('Copy :src to :Dest', ['src', 'dest']) } },
      drafts: { 'Copy :name to :Target': ':name을(를) :Target(으)로 복사' },
      exclusions: new Map(),
      keys: ['Copy :src to :Dest'],
    });

    expect(plan).toEqual([{ key: 'Copy :src to :Dest', kind: 'tm-rename', from: 'Copy :name to :Target', text: ':src을(를) :Dest(으)로 복사' }]);
  });

  it('translates a dot key again when its English changed, instead of reusing its own stale draft', () => {
    const plan = planDrafts({
      catalog: { version: '2', keys: { 'auth.throttle': entry('Too many login attempts.') } },
      drafts: { 'auth.throttle': '시도가 너무 많습니다.' },
      exclusions: new Map(),
      keys: ['auth.throttle'],
    });

    expect(plan).toEqual([{ key: 'auth.throttle', kind: 'mt' }]);
  });
});
