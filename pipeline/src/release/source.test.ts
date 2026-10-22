import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fetchDev, readDevFile } from './source.ts';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'release-src-'));
  dirs.push(dir);

  return dir;
};
const git = (cwd: string, ...args: string[]): string =>
  spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', windowsHide: true }).stdout.trim();

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('fetchDev and readDevFile', () => {
  it('reads files of the remote dev branch without a work tree, and sees the next commit after another fetch', () => {
    const remote = temp();
    git(remote, 'init', '-q', '-b', 'dev');
    mkdirSync(join(remote, 'i18n'));
    writeFileSync(join(remote, 'i18n', 'release.json'), '{"mode":"drafts"}\n');
    git(remote, 'add', '.');
    git(remote, 'commit', '-q', '-m', 'one');
    const first = git(remote, 'rev-parse', 'HEAD');
    const bare = join(temp(), 'release-src.git');

    expect(fetchDev(bare, remote)).toBe(first);
    expect(readDevFile(bare, 'i18n/release.json')).toBe('{"mode":"drafts"}\n');
    expect(readDevFile(bare, 'i18n/missing.json')).toBeUndefined();

    writeFileSync(join(remote, 'i18n', 'release.json'), '{"mode":"reviewed"}\n');
    git(remote, 'commit', '-q', '-am', 'two');
    const second = fetchDev(bare, remote);

    expect(second).not.toBe(first);
    expect(readDevFile(bare, 'i18n/release.json')).toBe('{"mode":"reviewed"}\n');
  });

  it('reads files larger than the default 1MB child-process buffer (the catalog is 2.4MB)', () => {
    const remote = temp();
    git(remote, 'init', '-q', '-b', 'dev');
    const big = `${JSON.stringify({ text: 'x'.repeat(3 * 1024 * 1024) })}\n`;
    writeFileSync(join(remote, 'catalog.json'), big);
    git(remote, 'add', '.');
    git(remote, 'commit', '-q', '-m', 'big');
    const bare = join(temp(), 'release-src.git');
    fetchDev(bare, remote);

    expect(readDevFile(bare, 'catalog.json')).toBe(big);
  });

  it('fails with a short message when the remote cannot be fetched', () => {
    expect(() => fetchDev(join(temp(), 'x.git'), join(temp(), 'no-such-repo'))).toThrow('dev를 받지 못했습니다');
  });
});
