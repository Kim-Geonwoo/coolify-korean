import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CatalogLite } from '../i18n/memory.ts';
import { serializeKo } from './handoff.ts';
import { publicLangFile, selectPublic } from './publicLang.ts';

const entry = (english: string, placeholders: string[] = []): CatalogLite['keys'][string] => ({ english, kinds: ['text'], placeholders });
const catalog: CatalogLite = {
  version: '4.4.6',
  keys: { Save: entry('Save'), Cancel: entry('Cancel'), 'Deploy :name': entry('Deploy :name', ['name']), localhost: entry('localhost') },
};
const meta = { Save: { run: 'r', sourceHash: 'h', via: 'mt' as const } };
const drafts = { Save: '저장 초안', Cancel: '취소 초안', 'Deploy :name': ':name 배포', localhost: '로컬' };
const exclusions = new Map([['localhost', '식별자']]);

describe('selectPublic', () => {
  it('prefers the reviewed translation and never uses pending human edits', () => {
    const picked = selectPublic({ catalog, reviewed: { Save: '저장' }, drafts, meta, exclusions, verbatim: [] });

    expect(picked.ko).toEqual({ Save: '저장', Cancel: '취소 초안', 'Deploy :name': ':name 배포' });
    expect(picked.counts).toEqual({ approved: 1, pending: 0, drafts: 2, english: 0 });
  });

  it('falls back to the draft when the reviewed value fails the hard checks', () => {
    const picked = selectPublic({ catalog, reviewed: { 'Deploy :name': '배포' }, drafts, meta, exclusions, verbatim: [] });

    expect(picked.ko['Deploy :name']).toBe(':name 배포');
  });
});

describe('publicLangFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const repoWith = (files: Readonly<Record<string, unknown>>): { repo: string; commit: string } => {
    const repo = mkdtempSync(join(tmpdir(), 'coolify-ko-publiclang-'));
    dirs.push(repo);
    const git = (...args: string[]): string => {
      const result = spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }

      return result.stdout.trim();
    };
    git('init', '-q');
    for (const [path, value] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), JSON.stringify(value));
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    return { repo, commit: git('rev-parse', 'HEAD') };
  };
  const base = {
    'i18n/catalog.json': catalog,
    'i18n/exclude.json': { keys: { localhost: '식별자' } },
    'i18n/verbatim.json': { literals: [] },
    'i18n/drafts/ko.json': drafts,
    'i18n/drafts/ko.meta.json': meta,
  };

  it('builds the language file from the committed reviewed and draft files', () => {
    const { repo, commit } = repoWith({ ...base, 'i18n/reviewed/ko.json': { Save: '저장' } });
    const file = publicLangFile(repo, commit, 'ko');
    const expected = serializeKo({ Save: '저장', Cancel: '취소 초안', 'Deploy :name': ':name 배포' });

    expect(file.text).toBe(expected);
    expect(file.sha256).toBe(createHash('sha256').update(expected).digest('hex'));
    expect(file.counts.approved).toBe(1);
  });

  it('works before anything has been reviewed', () => {
    const { repo, commit } = repoWith(base);

    expect(publicLangFile(repo, commit, 'ko').counts).toEqual({ approved: 0, pending: 0, drafts: 3, english: 0 });
  });

  it('fails when a required file is missing from the commit', () => {
    const { repo, commit } = repoWith({ 'i18n/catalog.json': catalog });

    expect(() => publicLangFile(repo, commit, 'ko')).toThrow();
  });
});
