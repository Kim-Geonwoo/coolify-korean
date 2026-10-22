import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findForbiddenTrackedPaths, findInternalNames, loadInternalNames, parseInternalNames } from './repo-guard.ts';

describe('findForbiddenTrackedPaths', () => {
  it('flags AI artifact and local work paths', () => {
    const tracked = [
      '.local/plans/plan.md',
      '.work/upstream/4.4.6/app/x.php',
      '.claude/settings.json',
      'memory/notes.md',
      'docs/design/spec.md',
      'docs/superpowers/plan.md',
      '.screenshots/home.png',
      'tools/.superpowers/sdd/x.md',
    ];
    expect(findForbiddenTrackedPaths(tracked)).toEqual(tracked);
  });

  it('flags CLAUDE.md at any depth', () => {
    expect(findForbiddenTrackedPaths(['CLAUDE.md', 'codemod/CLAUDE.md'])).toEqual(['CLAUDE.md', 'codemod/CLAUDE.md']);
  });

  it('flags env files but allows the example file', () => {
    expect(
      findForbiddenTrackedPaths(['.env', 'deploy/.env.production', 'deploy/.env.example', 'pipeline/env.ts']),
    ).toEqual(['.env', 'deploy/.env.production']);
  });

  it('allows ordinary project files, including look-alike names', () => {
    expect(
      findForbiddenTrackedPaths([
        'README.md',
        'codemod/src/Blade/BladeTransformer.php',
        'docs/user-guide.md',
        'pipeline/src/local.ts',
        'i18n/en.json',
        'memory.md',
      ]),
    ).toEqual([]);
  });

  it('normalizes Windows separators before matching', () => {
    expect(findForbiddenTrackedPaths(['.local\\research\\x.md'])).toEqual(['.local\\research\\x.md']);
  });
});

// 2026-10-22 보안 점검: 진짜 이름은 조각 문자열로도, 솔트 없는 해시로도 레포에 두지 않는다(해시는 사전 대입으로 되돌릴 수 있다).
// 이름 목록은 레포 밖 로컬 파일에만 있고, 시험은 가짜 이름으로 한다
describe('findInternalNames', () => {
  const fake = ['acmebox', 'opsuser7', 'skyport'];
  // 가짜 tailnet 주소도 일반 꼴 검사에 걸리므로 이어 붙여 만든다
  const FAKE_TAILNET = ['tail', '0a1b2c', '.ts.net'].join('');
  const at = (lines: readonly string[]): { path: string; line: number; text: string }[] => lines.map((text, index) => ({ path: `f${String(index)}`, line: index + 1, text }));

  it('flags a listed name anywhere in a line, in any case, and any tailnet address', () => {
    const lines = ['ssh admin@acmebox-2', 'readonly ADMIN=opsuser7', 'Skyport handoff', 'skyportApp', 'nonacmeboxes', `https://box.${FAKE_TAILNET}:8444`];

    expect(findInternalNames(at(lines), fake)).toHaveLength(lines.length);
  });

  it('allows neutral wording', () => {
    expect(findInternalNames(at(['PaaS 호스트가 읽는 전달 폴더, weblate.example.internal', 'opsuser']), fake)).toEqual([]);
  });

  it('still finds tailnet addresses without a name list', () => {
    expect(findInternalNames(at([`https://box.${FAKE_TAILNET}`, 'acmebox']), [])).toEqual(['f0:1']);
  });

  it('reads the local list: one name per line, lower-cased, without blanks or comments', () => {
    expect(parseInternalNames('# 내부 이름\nAcmeBox\n\n  skyport  \r\n')).toEqual(['acmebox', 'skyport']);
    expect(loadInternalNames(join(tmpdir(), 'coolify-ko-no-such-names-file.txt'))).toBeUndefined();
  });
});
