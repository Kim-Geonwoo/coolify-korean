import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { publishCommand, type PublishIo } from './publishCli.ts';

const fixture = readFileSync(join(import.meta.dirname, 'fixtures', 'versions.json'), 'utf8');
const published = { schema: 1, versions: { '4.4.6': { kind: 'ko', index: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), publishedAt: '2026-10-19T00:00:00.000Z' } } };

describe('publishCommand', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const io = (cdn: string): PublishIo & { readonly lines: string[] } => {
    const root = mkdtempSync(join(tmpdir(), 'coolify-ko-publish-'));
    dirs.push(root);
    mkdirSync(join(root, 'releases'));
    writeFileSync(join(root, 'releases', 'published.json'), JSON.stringify(published));
    const lines: string[] = [];

    return {
      root,
      lines,
      fetcher: () => Promise.resolve(new Response(cdn, { status: 200 })),
      log: (line) => lines.push(line),
      now: () => new Date('2026-10-20T00:00:00.000Z'),
    };
  };

  it('prints the usage and exits with 2 on a wrong command', async () => {
    const context = io(fixture);

    expect(await publishCommand(['publish'], context)).toBe(2);
    expect(await publishCommand(['publish', 'push'], context)).toBe(2);
    expect(await publishCommand(['publish', 'mirror'], context)).toBe(2);
    expect(context.lines.join('\n')).toContain('사용법');
  });

  it('writes a checked mirror file', async () => {
    const context = io(fixture);
    const out = join(context.root, 'versions.json');

    expect(await publishCommand(['publish', 'mirror', '--out', out], context)).toBe(0);
    expect((JSON.parse(readFileSync(out, 'utf8')) as { coolify: { v4: { version: string } } }).coolify.v4.version).toBe('4.4.6');
  });

  it('writes nothing when the official file went backwards', async () => {
    const context = io(fixture.replace('"4.4.6"', '"4.4.5"'));
    const out = join(context.root, 'versions.json');

    expect(await publishCommand(['publish', 'mirror', '--out', out], context)).toBe(1);
    expect(existsSync(out)).toBe(false);
  });
});

describe('publish site', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'coolify-ko-site-cli-'));
    dirs.push(root);
    const files: Record<string, string> = {
      'releases/published.json': JSON.stringify(published),
      'i18n/languages.json': JSON.stringify({ languages: [{ code: 'ko', name: '한국어', enabled: true, rules: 'ko' }] }),
      'i18n/catalog.json': JSON.stringify({ version: '4.4.6', keys: { Save: { english: 'Save', kinds: ['text'], placeholders: [] } } }),
      'i18n/exclude.json': JSON.stringify({ keys: {} }),
      'i18n/verbatim.json': JSON.stringify({ literals: [] }),
      'i18n/drafts/ko.json': JSON.stringify({ Save: '저장' }),
      'i18n/drafts/ko.meta.json': JSON.stringify({}),
      'scripts/coolify-ko.sh': '#!/usr/bin/env bash\necho ok\n',
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, ...path.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(root, ...path.split('/')), text);
    }
    const git = (...args: string[]): void => {
      const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { windowsHide: true });
      if (result.status !== 0) {
        throw new Error(result.stderr.toString());
      }
    };
    git('init', '-q');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    return root;
  };

  it('builds the whole site from a commit and later refreshes versions.json only', async () => {
    const root = repo();
    const out = join(root, '.work', 'site');
    const lines: string[] = [];
    let now = new Date('2026-10-20T00:00:00.000Z');
    const context: PublishIo = { root, fetcher: () => Promise.resolve(new Response(fixture, { status: 200 })), log: (line) => lines.push(line), now: () => now };

    expect(await publishCommand(['publish', 'site', '--out', out], context)).toBe(0);
    expect(readFileSync(join(out, 'public', 'lang', 'ko.json'), 'utf8')).toBe('{"Save":"저장"}\n');
    expect(readFileSync(join(out, 'public', 'coolify-ko.sh'), 'utf8')).toBe('#!/usr/bin/env bash\necho ok\n');

    now = new Date('2026-10-20T06:00:00.000Z');
    expect(await publishCommand(['publish', 'site', '--refresh-versions', '--out', out], context)).toBe(0);
    expect(lines.at(-1)).toBe('versions.json 갱신');
  });
});
