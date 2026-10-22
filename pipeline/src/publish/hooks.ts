import { createHash } from 'node:crypto';
import type { Fetcher } from '../sync/upstream.ts';

/**
 * 상류 설치 후크 감시(5단계 검토 중대 8). 방법 A·B는 공식 코드가 이미 허용하는 두 후크에만 기댄다:
 * `.env`의 VERSIONS_URL(constants.php), upgrade.sh가 custom.yml을 compose에 넣고 LATEST_IMAGE를 넘기는 것.
 * 이것이 바뀌면 우리 판이든 통과 태그든 사용자 업데이트를 깰 수 있어 발행을 멈추고 사람이 본다.
 * upgrade.sh·compose는 업데이트 때마다 CDN 최신본을 받으므로 CDN 현재본을, constants.php는 그 버전 태그를 본다
 */
export interface HookFiles {
  readonly constants: string;
  readonly upgrade: string;
  readonly composeProd: string;
}

interface Check {
  readonly file: keyof HookFiles;
  readonly pattern: RegExp;
  /** 이 개수 이상의 줄(주석 제외)에 있어야 한다 */
  readonly min: number;
  readonly message: string;
}

const CHECKS: readonly Check[] = [
  { file: 'constants', pattern: /env\(\s*'VERSIONS_URL'/, min: 1, message: 'constants.php에 VERSIONS_URL 후크가 없음' },
  { file: 'upgrade', pattern: /COMPOSE_FILES.*-f \/data\/coolify\/source\/docker-compose\.custom\.yml/, min: 2, message: 'upgrade.sh가 이미지 받기·실행 두 곳에 custom.yml을 넣지 않음' },
  { file: 'upgrade', pattern: /^LATEST_IMAGE=\$\{1[:}]/, min: 1, message: 'upgrade.sh 첫 인자가 LATEST_IMAGE가 아님' },
  { file: 'upgrade', pattern: /LATEST_IMAGE=\\?\$\{LATEST_IMAGE\} docker compose/, min: 2, message: 'upgrade.sh가 LATEST_IMAGE를 docker compose에 넘기지 않음' },
  { file: 'upgrade', pattern: /set_env_var "LATEST_IMAGE"/, min: 1, message: 'upgrade.sh가 .env에 LATEST_IMAGE를 쓰지 않음' },
  { file: 'composeProd', pattern: /coollabsio\/coolify:\$\{LATEST_IMAGE/, min: 1, message: 'prod compose의 coolify 이미지 줄이 바뀜' },
];
const ENV_FILE = /env_file:\s*\n\s*-\s*\/data\/coolify\/source\/\.env/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 20_000;

const code = (text: string): string[] => text.split('\n').filter((line) => !line.trim().startsWith('#'));

function matches(files: HookFiles): { readonly lines: Map<Check, string[]>; readonly envFile: string | undefined } {
  const lines = new Map(CHECKS.map((check) => [check, code(files[check.file]).filter((line) => check.pattern.test(line)).map((line) => line.trim())]));

  return { lines, envFile: ENV_FILE.exec(code(files.composeProd).join('\n'))?.[0] };
}

export function hookIssues(files: HookFiles): string[] {
  const { lines, envFile } = matches(files);
  const issues = CHECKS.filter((check) => (lines.get(check)?.length ?? 0) < check.min).map((check) => check.message);
  if (envFile === undefined) {
    issues.push('prod compose가 /data/coolify/source/.env를 coolify에 넘기지 않음');
  }

  return issues;
}

/** 후크 줄들의 지문. 바뀌면 막지는 않고 "확인 필요"를 알린다(주석만 바뀐 것은 같다) */
export function hookFingerprint(files: HookFiles): string {
  const { lines, envFile } = matches(files);

  return createHash('sha256')
    .update([...CHECKS.flatMap((check) => lines.get(check) ?? []), envFile ?? ''].join('\n'))
    .digest('hex');
}

export async function fetchHookFiles(version: string, fetcher: Fetcher): Promise<HookFiles> {
  if (!VERSION.test(version)) {
    throw new Error(`버전 형식이 아닙니다: ${version.slice(0, 20)}`);
  }
  const get = async (url: string): Promise<string> => {
    const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'coolify-ko-sync' } });
    if (!response.ok) {
      throw new Error(`${new URL(url).host}가 HTTP ${String(response.status)}를 돌려줬습니다.`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BYTES) {
      throw new Error(`${new URL(url).pathname}가 1MB를 넘습니다.`);
    }

    return text;
  };

  return {
    constants: await get(`https://raw.githubusercontent.com/coollabsio/coolify/v${version}/config/constants.php`),
    upgrade: await get('https://cdn.coollabs.io/coolify/upgrade.sh'),
    composeProd: await get('https://cdn.coollabs.io/coolify/docker-compose.prod.yml'),
  };
}
