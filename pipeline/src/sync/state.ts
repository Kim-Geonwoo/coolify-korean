import { readFileSync } from 'node:fs';

/** 업스트림 버전의 단일 원천(`i18n/state.json`). 추출·게이트·봇이 모두 여기서 버전과 이미지를 읽는다 */
export interface SyncState {
  readonly upstream: {
    /** 안정판만(예: 4.4.6). 사전 배포판은 받지 않는다 */
    readonly version: string;
    readonly image: string;
    /** 같은 태그가 다시 쓰여도 바뀌지 않게 다이제스트로 고정한다 */
    readonly digest: string;
  };
}

const VERSION = /^\d+\.\d+\.\d+$/;
const IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function field(value: unknown, pattern: RegExp, name: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) {
    throw new Error(`state.json의 ${name} 값이 형식에 맞지 않습니다.`);
  }

  return value;
}

export function parseState(data: unknown): SyncState {
  const upstream: unknown = (data as { upstream?: unknown } | null)?.upstream;
  if (typeof upstream !== 'object' || upstream === null) {
    throw new Error('state.json에 upstream이 없습니다.');
  }
  const values = upstream as Record<string, unknown>;

  return {
    upstream: {
      version: field(values['version'], VERSION, 'upstream.version'),
      image: field(values['image'], IMAGE, 'upstream.image'),
      digest: field(values['digest'], DIGEST, 'upstream.digest'),
    },
  };
}

export function loadState(path: string): SyncState {
  return parseState(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

export function imageRef(state: SyncState): string {
  return `${state.upstream.image}:${state.upstream.version}@${state.upstream.digest}`;
}

/** 산출 카탈로그가 state의 버전에서 나왔는지 본다. 다르면 다른 버전 이름을 붙인 산출물이다 */
export function assertCatalogVersion(catalog: unknown, state: SyncState): void {
  const version = (catalog as { version?: unknown } | null)?.version;
  if (version !== state.upstream.version) {
    throw new Error(`카탈로그 버전(${String(version)})이 state.json의 ${state.upstream.version}와 다릅니다.`);
  }
}

/** Dockerfile 기본값에 기대지 않고 늘 state의 버전으로 빌드한다 */
export function buildArgs(state: SyncState): string[] {
  return ['--build-arg', `COOLIFY_IMAGE=${imageRef(state)}`, '--build-arg', `COOLIFY_VERSION=${state.upstream.version}`];
}
