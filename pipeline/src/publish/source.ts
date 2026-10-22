import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findForbiddenTrackedPaths, hasInternalName } from '../../../scripts/repo-guard.ts';

/**
 * 공개 소스 레포(Kim-Geonwoo/coolify-korean, 새 히스토리) 내보내기(5단계 공개 계획 P4, 사용자 결정 "공개용 레포를 새로 만들자").
 * 비공개 작업 레포의 한 커밋에서 정해 둔 경로만 꺼낸다(기본 거부). 집 서버 운영(ops)과 CI 설정(.github, 11-03 전 Actions 금지)은 내보내지 않는다.
 * 임시 폴더에 먼저 풀어 내부 이름·금지 경로를 검사하고, 통과해야 공개 레포 작업 사본(.git은 남김)을 바꾼다
 */
export const EXPORT_PATHS: readonly string[] = ['.dockerignore', '.gitattributes', '.gitignore', 'Dockerfile', 'LICENSE', 'NOTICE', 'README.md', 'codemod', 'docs', 'eslint.config.js', 'extension', 'i18n', 'overlay', 'package.json', 'pipeline', 'pnpm-lock.yaml', 'releases', 'reports', 'scripts', 'tools', 'tsconfig.json', 'vitest.config.ts'];
export const PRIVATE_PATHS: readonly string[] = ['.github', 'ops'];

/** 내보낼지 정하지 않은 최상위 경로(새 경로가 생기면 시험이 결정을 요구한다) */
export function unclassifiedPaths(tracked: readonly string[]): string[] {
  const top = new Set(tracked.map((path) => path.replaceAll('\\', '/').split('/')[0] ?? ''));

  return [...top].filter((name) => name !== '' && !EXPORT_PATHS.includes(name) && !PRIVATE_PATHS.includes(name)).sort();
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
  readonly path: string;
}

function run(repo: string, args: readonly string[], input?: string): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], { windowsHide: true, timeout: 120_000, maxBuffer: 512 * 1024 * 1024, ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? ''} 실패: ${result.stderr.toString('utf8').trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  }

  return result.stdout;
}

function treeEntries(repo: string, commit: string): TreeEntry[] {
  return run(repo, ['ls-tree', '-r', '-z', commit, '--', ...EXPORT_PATHS])
    .toString('utf8')
    .split('\0')
    .filter((row) => row !== '')
    .map((row) => {
      const match = /^(\d{6}) (\w+) ([0-9a-f]{40,64})\t(.+)$/s.exec(row);
      if (match === null) {
        throw new Error(`git ls-tree 줄을 읽지 못했습니다: ${row.slice(0, 80)}`);
      }

      return { mode: match[1] ?? '', oid: match[3] ?? '', path: match[4] ?? '' };
    });
}

/** git cat-file --batch로 blob을 한 번에 읽는다(파일마다 git을 띄우지 않게) */
function blobs(repo: string, oids: readonly string[]): Map<string, Buffer> {
  const out = run(repo, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  const found = new Map<string, Buffer>();
  let position = 0;
  while (position < out.length) {
    const end = out.indexOf(0x0a, position);
    const header = out.subarray(position, end).toString('utf8');
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (end < 0 || match === null) {
      throw new Error(`git cat-file 출력을 읽지 못했습니다: ${header.slice(0, 80)}`);
    }
    const size = Number(match[2]);
    found.set(match[1] ?? '', out.subarray(end + 1, end + 1 + size));
    position = end + 1 + size + 1;
  }

  return found;
}

// 발행 전에 채워야 하는 것(조각으로 이어 붙인다: 이 줄이 검사에 걸리지 않게)
const BLOCKERS: readonly (readonly [string, string])[] = [
  ['REPLACE_AT_' + 'PUBLISH', '공개 시 채울 자리표시자'],
  ['<공개 시 ' + '채움>', '공개 시 채울 자리표시자'],
  ['6u5ttjNpr_' + 'sVpZEwjOd2-HIxfE3Tw03BsP0ecZysLeY', '확장 원격 사전의 시험 공개 키'],
];

/** 공개 발행을 막는 것(자리표시자, 확장의 시험 서명 키) */
export function publishBlockers(files: readonly { readonly path: string; readonly data: Buffer }[]): string[] {
  return files.flatMap((file) => {
    const text = file.data.toString('utf8');

    return BLOCKERS.filter(([needle]) => text.includes(needle)).map(([, reason]) => `${file.path}: ${reason}`);
  });
}

export function exportSource(options: { readonly repo: string; readonly commit: string; readonly to: string; readonly ready?: boolean; readonly internalNames: readonly string[] }): { readonly files: number } {
  const names = options.internalNames;
  const entries = treeEntries(options.repo, options.commit);
  // 링크·하위 모듈은 내보내지 않는다(일반 파일 100644·100755만)
  const odd = entries.filter((entry) => entry.mode !== '100644' && entry.mode !== '100755');
  if (odd.length > 0) {
    throw new Error(`일반 파일이 아닌 항목이 있습니다: ${odd.map((entry) => entry.path).join(', ').slice(0, 200)}`);
  }
  const content = blobs(options.repo, entries.map((entry) => entry.oid));
  const issues = findForbiddenTrackedPaths(entries.map((entry) => entry.path)).map((path) => `${path}: 넣으면 안 되는 경로`);
  for (const entry of entries) {
    const data = content.get(entry.oid);
    if (data === undefined) {
      throw new Error(`blob을 읽지 못했습니다: ${entry.path}`);
    }
    // 경로 이름도 본다. NUL이 든 파일(UTF-16 글·바이너리)은 NUL을 뺀 바이트와 UTF-16 해석으로도 본다(보안 검토 2026-10-19)
    const texts = data.includes(0) ? [data.toString('latin1').replaceAll('\0', ''), data.toString('utf16le')] : [data.toString('utf8')];
    if (hasInternalName(entry.path, names) || texts.some((text) => hasInternalName(text, names))) {
      issues.push(`${entry.path}: 내부 이름`);
    }
  }
  if (issues.length > 0) {
    throw new Error(`공개 소스로 내보낼 수 없습니다: ${issues.slice(0, 10).join(' / ')}`);
  }
  // 발행용 내보내기(기본)는 자리표시자·시험 키가 남아 있으면 멈춘다. 초안 확인은 ready:false
  if (options.ready !== false) {
    const blockers = publishBlockers(entries.map((entry) => ({ path: entry.path, data: content.get(entry.oid) ?? Buffer.alloc(0) })));
    if (blockers.length > 0) {
      throw new Error(`아직 발행 준비가 안 됐습니다: ${blockers.join(' / ')}`);
    }
  }

  const staging = mkdtempSync(join(tmpdir(), 'coolify-ko-export-'));
  try {
    for (const entry of entries) {
      const path = join(staging, ...entry.path.split('/'));
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content.get(entry.oid) ?? Buffer.alloc(0));
    }
    mkdirSync(options.to, { recursive: true });
    for (const name of readdirSync(options.to)) {
      if (name !== '.git') {
        rmSync(join(options.to, name), { recursive: true, force: true });
      }
    }
    for (const name of readdirSync(staging)) {
      cpSync(join(staging, name), join(options.to, name), { recursive: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }

  return { files: entries.length };
}
