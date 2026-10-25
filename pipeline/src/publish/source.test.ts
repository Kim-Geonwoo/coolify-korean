import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { EXPORT_PATHS, exportSource, PRIVATE_PATHS, publishBlockers, unclassifiedPaths } from './source.ts';

// 2026-10-22 보안 점검: 진짜 내부 이름은 시험에도 두지 않는다
const FAKE_NAMES: readonly string[] = ['acmebox', 'skyport'];

const root = fileURLToPath(new URL('../../../', import.meta.url));
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'coolify-ko-source-'));
  dirs.push(dir);

  return dir;
};

describe('unclassifiedPaths', () => {
  it('makes every top-level path of this repository either exported or kept private', () => {
    const tracked = spawnSync('git', ['-C', root, 'ls-files'], { encoding: 'utf8', windowsHide: true }).stdout.split('\n').filter((line) => line !== '');

    expect(unclassifiedPaths(tracked)).toEqual([]);
  });

  it('reports a new top-level path that nobody decided about', () => {
    expect(unclassifiedPaths(['Dockerfile', 'notes/todo.md', 'ops/x.sh'])).toEqual(['notes']);
  });

  it('keeps the home server operations and CI private', () => {
    expect(PRIVATE_PATHS).toEqual(['.github', 'ops']);
    expect(EXPORT_PATHS).not.toContain('ops');
  });
});

describe('exportSource', () => {
  const repo = (files: Readonly<Record<string, string>>): { readonly dir: string; readonly commit: string } => {
    const dir = temp();
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...path.split('/')), text);
    }
    const git = (...args: string[]): string => {
      const result = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', windowsHide: true });
      if (result.status !== 0) {
        throw new Error(result.stderr);
      }

      return result.stdout.trim();
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    return { dir, commit: git('rev-parse', 'HEAD') };
  };

  it('replaces the public working copy with the exported paths only and keeps its git folder', () => {
    const { dir, commit } = repo({ 'README.md': '# coolify-ko\n', 'pipeline/a.ts': 'export {};\n', 'ops/server.sh': 'echo private\n' });
    const to = temp();
    mkdirSync(join(to, '.git'));
    writeFileSync(join(to, 'stale.txt'), 'old');
    const result = exportSource({ repo: dir, commit, to, internalNames: FAKE_NAMES });

    expect(result.files).toBe(2);
    expect(readdirSync(to).sort()).toEqual(['.git', 'README.md', 'pipeline']);
    expect(readFileSync(join(to, 'pipeline', 'a.ts'), 'utf8')).toBe('export {};\n');
  });

  // 2026-10-25 공개 소개 준비: 이슈 양식은 공개 레포에 있어야 하고, CI(.github/workflows)는 여전히 내보내지 않는다
  it('exports the issue forms and the security policy but not the CI workflows', () => {
    const { dir, commit } = repo({ 'SECURITY.md': '# 보안\n', '.github/ISSUE_TEMPLATE/translation.yml': 'name: 번역\n', '.github/workflows/ci.yml': 'on: push\n' });
    const to = temp();
    exportSource({ repo: dir, commit, to, internalNames: FAKE_NAMES });

    expect(readFileSync(join(to, '.github', 'ISSUE_TEMPLATE', 'translation.yml'), 'utf8')).toBe('name: 번역\n');
    expect(existsSync(join(to, 'SECURITY.md'))).toBe(true);
    expect(existsSync(join(to, '.github', 'workflows'))).toBe(false);
  });

  it('refuses an export that still carries an internal name and leaves the working copy alone', () => {
    const { dir, commit } = repo({ 'README.md': 'server acmebox-2\n' });
    const to = temp();
    writeFileSync(join(to, 'kept.txt'), 'kept');

    expect(() => exportSource({ repo: dir, commit, to, internalNames: FAKE_NAMES })).toThrow('내부 이름');
    expect(existsSync(join(to, 'kept.txt'))).toBe(true);
  });

  // 보안 검토(2026-10-19): 경로 이름과 NUL이 든 파일(UTF-16 글 등)도 본다
  it.each([
    ['a path that names the server', { 'pipeline/acmebox-notes.ts': 'export {};\n' }],
    ['a UTF-16 text file', { 'README.md': '# ok\n', 'reports/notes.txt': Buffer.from('server acmebox-2', 'utf16le').toString('latin1') }],
    ['a binary that carries the name', { 'README.md': '# ok\n', 'tools/blob.bin': '\0\0skyport\0' }],
    // 가짜 tailnet 주소도 일반 꼴 검사에 걸리므로 이어 붙여 만든다
    ['a tailnet address', { 'README.md': `https://box.${['tail', '0a1b2c', '.ts.net'].join('')}\n` }],
  ])('refuses %s', (_label, files) => {
    const { dir, commit } = repo(files);

    expect(() => exportSource({ repo: dir, commit, to: temp(), internalNames: FAKE_NAMES })).toThrow('내부 이름');
  });

  it('refuses an export that still has a publish-time placeholder unless asked for a draft', () => {
    const { dir, commit } = repo({ 'README.md': 'address: ' + 'REPLACE_AT_' + 'PUBLISH\n' });

    expect(() => exportSource({ repo: dir, commit, to: temp(), internalNames: FAKE_NAMES })).toThrow('발행 준비');
    expect(exportSource({ repo: dir, commit, to: temp(), ready: false, internalNames: FAKE_NAMES }).files).toBe(1);
  });

  it('finds nothing that still blocks publishing this repository', () => {
    const tracked = spawnSync('git', ['-C', root, 'ls-files', '-z', '--', ...EXPORT_PATHS], { encoding: 'utf8', windowsHide: true }).stdout.split('\0').filter((path) => path !== '');
    const files = tracked.map((path) => ({ path, data: readFileSync(join(root, ...path.split('/'))) }));

    expect(publishBlockers(files)).toEqual([]);
  });

  it('exports this repository without internal names or private paths', () => {
    const head = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
    const to = temp();
    const result = exportSource({ repo: root, commit: head, to, ready: false, internalNames: [`nobody-${randomUUID()}`] });

    expect(result.files).toBeGreaterThan(100);
    expect(existsSync(join(to, 'ops'))).toBe(false);
    expect(existsSync(join(to, 'Dockerfile'))).toBe(true);
  });
});
