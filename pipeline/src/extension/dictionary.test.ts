import { describe, expect, it } from 'vitest';
import type { CatalogLite } from '../i18n/memory.ts';
import { buildDictionary, mergeLang } from './dictionary.ts';

type Entry = CatalogLite['keys'][string];

const entry = (english: string, placeholders: readonly string[] = [], kinds: readonly string[] = ['text']): Entry => ({ english, kinds, placeholders });

const keys: Record<string, Entry> = {
  Save: entry('Save'),
  'Deploy :name': entry('Deploy :name', ['name']),
  ':count of :total done': entry(':count of :total done', ['total', 'count']),
  'Click <0>here</0> to continue': entry('Click <0>here</0> to continue', [], ['rich']),
  '<0>:name</0> is used by': entry('<0>:name</0> is used by', ['name'], ['rich']),
  'Docker Hub': entry('Docker Hub'),
  'cleanup deleted backups': entry('cleanup deleted backups'),
  'auth.login': entry('Login', [], ['existing']),
  ':count domain|:count domains': entry(':count domain|:count domains', ['count'], ['plural']),
  'warning.sslipdomain': entry('Use <a href="https://sslip.io">sslip</a> only for tests', [], ['existing']),
};

const catalog: CatalogLite = { version: '4.4.6', keys };

const drafts: Record<string, string> = {
  Save: '저장',
  'Deploy :name': ':name 배포',
  ':count of :total done': ':total개 중 :count개 완료',
  'Click <0>here</0> to continue': '계속하려면 <0>여기</0>를 누르세요',
  '<0>:name</0> is used by': '<0>:name</0>을(를) 쓰는 곳',
  'Docker Hub': '도커 허브',
  'cleanup deleted backups': '삭제된 백업 정리',
  'auth.login': '로그인',
  ':count domain|:count domains': '도메인 :count개',
  'warning.sslipdomain': '<a href="https://sslip.io">sslip</a>은 시험용으로만 쓰세요',
};

const verbatim = ['cleanup deleted backups'];
const exclusions = new Map([['Docker Hub', '단독 브랜드']]);

const lang = (): Record<string, string> => mergeLang({ catalog, reviewed: {}, drafts, exclusions, verbatim });
const build = (input: { catalog?: CatalogLite; lang?: Record<string, string> } = {}): ReturnType<typeof buildDictionary> =>
  buildDictionary({ catalog: input.catalog ?? catalog, lang: input.lang ?? lang(), verbatim, code: 'ko', version: '4.4.6.1' });

describe('mergeLang', () => {
  it('prefers reviewed over drafts and drops excluded keys', () => {
    const merged = mergeLang({ catalog, reviewed: { Save: '저장하기' }, drafts, exclusions, verbatim });

    expect(merged['Save']).toBe('저장하기');
    expect(merged['auth.login']).toBe('로그인');
    expect(merged).not.toHaveProperty('Docker Hub');
  });

  it('falls back to the draft when the reviewed value fails a hard check', () => {
    const merged = mergeLang({ catalog, reviewed: { 'Deploy :name': '배포' }, drafts, exclusions, verbatim });

    expect(merged['Deploy :name']).toBe(':name 배포');
  });
});

describe('buildDictionary', () => {
  it('leaves out excluded keys and verbatim originals, and always protects the default confirmation text', () => {
    const dict = build();
    const sources = [...Object.keys(dict.exact), ...Object.keys(dict.tagged), ...dict.patterns.map((pattern) => pattern.source)];

    expect(sources).not.toContain('Docker Hub');
    expect(sources).not.toContain('cleanup deleted backups');
    expect(dict.verbatim).toEqual(['Confirm Deletion', 'cleanup deleted backups']);
  });

  it('puts plain keys in exact, using the English text rather than the dotted key', () => {
    const dict = build();

    expect(dict.exact['Save']).toBe('저장');
    expect(dict.exact['Login']).toBe('로그인');
    expect(dict.exact).not.toHaveProperty('auth.login');
  });

  it('sends :name keys to patterns, keeping the order the names appear in', () => {
    const dict = build();

    expect(dict.patterns).toContainEqual({ source: 'Deploy :name', names: ['name'], value: ':name 배포' });
    expect(dict.patterns).toContainEqual({ source: ':count of :total done', names: ['count', 'total'], value: ':total개 중 :count개 완료' });
  });

  it('sends numbered-tag keys to tagged, and tagged keys with names to patterns', () => {
    const dict = build();

    expect(dict.tagged['Click <0>here</0> to continue']).toBe('계속하려면 <0>여기</0>를 누르세요');
    expect(dict.patterns).toContainEqual({ source: '<0>:name</0> is used by', names: ['name'], value: '<0>:name</0>을(를) 쓰는 곳' });
  });

  it('splits plural forms into one pattern each', () => {
    const dict = build();

    expect(dict.patterns).toContainEqual({ source: ':count domain', names: ['count'], value: '도메인 :count개' });
    expect(dict.patterns).toContainEqual({ source: ':count domains', names: ['count'], value: '도메인 :count개' });
  });

  it('skips keys whose English carries raw HTML tags the page would render as elements', () => {
    const dict = build();
    const sources = [...Object.keys(dict.exact), ...Object.keys(dict.tagged), ...dict.patterns.map((pattern) => pattern.source)];

    expect(sources.some((source) => source.includes('sslip'))).toBe(false);
  });

  it('gives the same JSON bytes for the same input, whatever the key order', () => {
    const reversed: CatalogLite = { version: '4.4.6', keys: Object.fromEntries(Object.entries(keys).reverse()) };
    const reversedLang = Object.fromEntries(Object.entries(lang()).reverse());

    expect(JSON.stringify(build({ catalog: reversed, lang: reversedLang }))).toBe(JSON.stringify(build()));
    expect(build().schema).toBe(1);
    expect(build().code).toBe('ko');
    expect(build().version).toBe('4.4.6.1');
  });
});
