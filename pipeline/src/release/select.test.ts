import { describe, expect, it } from 'vitest';
import type { CatalogLite } from '../i18n/memory.ts';
import { selectKo } from './select.ts';

const entry = (english: string, placeholders: string[] = []): CatalogLite['keys'][string] => ({ english, kinds: ['text'], placeholders });
const catalog: CatalogLite = {
  version: '4.4.6',
  keys: {
    Save: entry('Save'),
    Cancel: entry('Cancel'),
    Delete: entry('Delete'),
    'Deploy :name': entry('Deploy :name', ['name']),
    localhost: entry('localhost'),
    Logs: entry('Logs'),
  },
};
const store = {
  drafts: { Save: '저장 초안', Cancel: '취소 초안', Delete: '삭제 초안', 'Deploy :name': ':name 배포', 'Old screen': '옛 화면' },
  meta: {
    Save: { run: 'r', sourceHash: 'h', via: 'mt' as const },
    'Old screen': { run: 'r', sourceHash: 'h', via: 'mt' as const, removedIn: '4.4.6' },
  },
};
const exclusions = new Map([['localhost', '식별자']]);
const base = { catalog, store, exclusions, verbatim: [] };

describe('selectKo', () => {
  it('takes the Weblate approval first, then the edited-but-unapproved translation, then the machine draft, else leaves English', () => {
    const picked = selectKo({ ...base, weblate: { reviewed: { Save: '저장' }, pending: { Save: '저장(수정)', Cancel: '취소' } } });

    expect(picked?.ko).toEqual({ Save: '저장', Cancel: '취소', Delete: '삭제 초안', 'Deploy :name': ':name 배포', 'Old screen': '옛 화면' });
    expect(picked?.counts).toEqual({ approved: 1, pending: 1, drafts: 3, english: 1 });
  });

  it('falls back to the draft when an approval is withdrawn in Weblate, never to an older reviewed value', () => {
    const picked = selectKo({ ...base, weblate: { reviewed: {}, pending: {} } });

    expect(picked?.ko['Save']).toBe('저장 초안');
  });

  it('drops a value that breaks the hard checks or carries control characters or broken UTF-16, and tries the next one', () => {
    const picked = selectKo({
      ...base,
      weblate: { reviewed: { 'Deploy :name': '배포' }, pending: { Delete: `삭제${String.fromCodePoint(7)}`, Save: `저장${String.fromCharCode(0xd800)}` } },
    });

    expect(picked?.ko['Deploy :name']).toBe(':name 배포');
    expect(picked?.ko['Delete']).toBe('삭제 초안');
    expect(picked?.ko['Save']).toBe('저장 초안');
    expect(selectKo({ ...base, weblate: { reviewed: { Save: '저장\n다음 줄' }, pending: {} } })?.ko['Save']).toBe('저장\n다음 줄');
  });

  it('keeps drafts of keys removed in the newest catalog, so a server still on the older version stays in Korean', () => {
    expect(selectKo({ ...base, weblate: { reviewed: {}, pending: {} } })?.ko['Old screen']).toBe('옛 화면');
  });

  it('never translates excluded keys, and gives nothing back when Weblate could not be read (the caller keeps the last file)', () => {
    expect(selectKo({ ...base, weblate: { reviewed: { localhost: '로컬호스트' }, pending: {} } })?.ko).not.toHaveProperty('localhost');
    expect(selectKo({ ...base, weblate: undefined })).toBeNull();
  });
});
