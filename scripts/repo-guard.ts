import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FORBIDDEN_PREFIXES = [
  '.local/',
  '.work/',
  '.claude/',
  'memory/',
  'docs/design/',
  'docs/superpowers/',
  '.screenshots/',
] as const;

function isForbidden(path: string): boolean {
  const normalized = path.replaceAll('\\', '/');
  if (FORBIDDEN_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return true;
  const segments = normalized.split('/');
  if (segments.includes('.superpowers')) return true;
  const base = segments.at(-1) ?? '';
  if (base === 'CLAUDE.md') return true;
  return (base === '.env' || base.startsWith('.env.')) && base !== '.env.example';
}

export function findForbiddenTrackedPaths(paths: readonly string[]): string[] {
  return paths.filter(isForbidden);
}

/**
 * 공개 레포에 남기지 않을 내부 이름: 집 서버 이름, 서버의 로컬 사용자, 대외비 PaaS 프로젝트(5단계 공개, 사용자 결정 2026-10-19).
 * 이름은 조각 문자열로도, 해시로도 레포에 두지 않는다(2026-10-22 보안 점검: 조각은 읽으면 보이고, 솔트 없는 해시는 사전 대입으로 되돌린다).
 * 목록은 레포 밖 로컬 파일(한 줄에 하나, # 주석)에만 두고 부분 문자열로 찾는다. tailnet 주소는 이름 없는 일반 꼴로 늘 찾는다
 */
export const INTERNAL_NAMES_FILE = process.env['COOLIFY_KO_INTERNAL_NAMES'] ?? join(homedir(), '.coolify-ko', 'internal-names.txt');
const TAILNET = /tail[0-9a-f]{6}\.ts\.net/i;

export function parseInternalNames(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** 로컬 목록을 읽는다. 없으면 undefined(공개 내보내기는 이때 멈추고, 저장소 검사는 tailnet만 본다) */
export function loadInternalNames(path: string = INTERNAL_NAMES_FILE): string[] | undefined {
  try {
    return parseInternalNames(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 글에 내부 이름이 있는지: 목록의 이름이 대소문자 무시 부분 문자열로 들어 있거나 tailnet 주소가 있으면 */
export function hasInternalName(text: string, names: readonly string[]): boolean {
  if (TAILNET.test(text)) {
    return true;
  }
  const lower = text.toLowerCase();

  return names.some((name) => name.length >= 3 && lower.includes(name));
}

export function findInternalNames(lines: readonly { readonly path: string; readonly line: number; readonly text: string }[], names: readonly string[]): string[] {
  return lines.filter((item) => hasInternalName(item.text, names)).map((item) => `${item.path}:${String(item.line)}`);
}

/** 추적 중인 글 파일에서 내부 이름이 든 줄(NUL이 든 바이너리는 건너뛴다) */
function internalNameLines(names: readonly string[]): { path: string; line: number; text: string }[] {
  const found: { path: string; line: number; text: string }[] = [];
  for (const path of trackedPaths()) {
    let data: Buffer;
    try {
      data = readFileSync(path);
    } catch {
      continue;
    }
    if (data.includes(0)) {
      continue;
    }
    data
      .toString('utf8')
      .split('\n')
      .forEach((text, index) => {
        if (hasInternalName(text, names)) {
          found.push({ path, line: index + 1, text });
        }
      });
  }

  return found;
}

function trackedPaths(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--cached'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out.split('\0').filter((p) => p.length > 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bad = findForbiddenTrackedPaths(trackedPaths());
  if (bad.length > 0) {
    console.error('레포에 넣으면 안 되는 파일이 추적되고 있습니다:');
    for (const p of bad) console.error(`  ${p}`);
    process.exit(1);
  }
  const list = loadInternalNames();
  if (list === undefined) {
    console.log(`내부 이름 목록이 없어 tailnet 주소만 검사합니다(${INTERNAL_NAMES_FILE})`);
  }
  const names = findInternalNames(internalNameLines(list ?? []), list ?? []);
  if (names.length > 0) {
    console.error('공개 레포에 남기지 않을 내부 이름이 있습니다(중립 표기나 서버 설정으로 바꾼다):');
    for (const p of names) console.error(`  ${p}`);
    process.exit(1);
  }
  console.log('경로·내부 이름 검사 통과');
}
