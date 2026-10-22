import type { SyncState } from './state.ts';

/** 밤 작업이 업스트림을 보고 내리는 판단 */
export type UpstreamDecision =
  | { readonly action: 'same' }
  | { readonly action: 'wait'; readonly version: string; readonly reason: 'no-release' | 'no-image' }
  | { readonly action: 'stop'; readonly reason: 'regress' | 'digest-changed'; readonly detail: string }
  | { readonly action: 'new'; readonly version: string; readonly digest: string };

const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMEOUT_MS = 20_000;
const VERSIONS_URL = 'https://cdn.coollabs.io/coolify/versions.json';

/** 안정판 버전(x.y.z) 비교: 음수면 a가 낮다 */
export function compare(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }

  return 0;
}

/**
 * 안정판이 앞으로 갔으면 릴리스와 이미지가 모두 있어야 처리한다(없으면 기다린다).
 * 버전이 거꾸로 가거나 같은 태그의 이미지가 다시 만들어졌으면 멈추고 사람에게 알린다.
 */
export function decideUpstream(input: { readonly current: SyncState; readonly stable: string; readonly release: boolean; readonly digest: string | undefined }): UpstreamDecision {
  const { version, digest } = input.current.upstream;
  const order = compare(input.stable, version);
  if (order < 0) {
    return { action: 'stop', reason: 'regress', detail: `${version} → ${input.stable}` };
  }
  if (order === 0) {
    return input.digest === undefined || input.digest === digest ? { action: 'same' } : { action: 'stop', reason: 'digest-changed', detail: version };
  }
  if (!input.release) {
    return { action: 'wait', version: input.stable, reason: 'no-release' };
  }
  if (input.digest === undefined) {
    return { action: 'wait', version: input.stable, reason: 'no-image' };
  }

  return { action: 'new', version: input.stable, digest: input.digest };
}

export function parseStableVersion(data: unknown): string {
  const version = (data as { coolify?: { v4?: { version?: unknown } } } | null)?.coolify?.v4?.version;
  if (typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error(`versions.json의 안정판 버전이 x.y.z가 아닙니다: ${String(version)}`);
  }

  return version;
}

export function parseHubTag(data: unknown): string {
  const digest = (data as { digest?: unknown } | null)?.digest;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error('Docker Hub 태그의 다이제스트 형식이 맞지 않습니다.');
  }

  return digest;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

async function get(fetcher: Fetcher, url: string): Promise<Response> {
  return fetcher(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'coolify-ko-sync', accept: 'application/json' } });
}

/** 있으면 true, 404면 false, 그 밖의 응답은 오류(추측하지 않는다) */
async function exists(fetcher: Fetcher, url: string): Promise<Response | undefined> {
  const response = await get(fetcher, url);
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`${new URL(url).host}가 HTTP ${String(response.status)}를 돌려줬습니다.`);
  }

  return response;
}

export async function checkUpstream(current: SyncState, fetcher: Fetcher = fetch): Promise<UpstreamDecision> {
  const versions = await exists(fetcher, VERSIONS_URL);
  if (versions === undefined) {
    throw new Error('versions.json이 없습니다(404).');
  }
  const stable = parseStableVersion(await versions.json());
  if (compare(stable, current.upstream.version) <= 0) {
    // 같은 버전이면 태그가 다시 만들어졌는지만 본다
    const tag = compare(stable, current.upstream.version) === 0 ? await exists(fetcher, hubTagUrl(current, stable)) : undefined;

    return decideUpstream({ current, stable, release: true, digest: tag === undefined ? undefined : parseHubTag(await tag.json()) });
  }
  const release = (await exists(fetcher, `https://api.github.com/repos/coollabsio/coolify/releases/tags/v${stable}`)) !== undefined;
  const tag = release ? await exists(fetcher, hubTagUrl(current, stable)) : undefined;

  return decideUpstream({ current, stable, release, digest: tag === undefined ? undefined : parseHubTag(await tag.json()) });
}

function hubTagUrl(current: SyncState, version: string): string {
  const repository = current.upstream.image.replace(/^docker\.io\//, '');

  return `https://hub.docker.com/v2/repositories/${repository}/tags/${version}`;
}
