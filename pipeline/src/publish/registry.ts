import type { Fetcher } from '../sync/upstream.ts';

/**
 * 공개 레지스트리에서 버전 태그가 지금 가리키는 index 다이제스트를 익명으로 읽는다(로그인 없음).
 * 미러 잡이 발행 기록과 대조한다: GHCR 쓰기 자격이 새어 태그가 바뀌면 알아채려는 것이다(2026-10-22 보안 점검 3)
 */
const REPO = /^ghcr\.io\/([a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+)$/;
const TAG = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TIMEOUT_MS = 20_000;
const ACCEPT = ['application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json', 'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].join(', ');

/** 태그가 없으면 undefined. 익명으로 읽을 수 없거나 응답이 이상하면 던진다(확인 못 함은 일치로 치지 않는다) */
export async function registryDigest(repo: string, tag: string, fetcher: Fetcher): Promise<string | undefined> {
  const path = REPO.exec(repo)?.[1];
  if (path === undefined) {
    throw new Error(`GHCR 저장소 형식이 아닙니다: ${repo.slice(0, 80)}`);
  }
  if (!TAG.test(tag)) {
    throw new Error(`버전 태그 형식이 아닙니다: ${tag.slice(0, 40)}`);
  }
  const init = { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error', headers: { 'user-agent': 'coolify-ko-mirror' } } as const;
  const tokenResponse = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${path}:pull`, init);
  if (!tokenResponse.ok) {
    throw new Error(`GHCR 익명 토큰을 받지 못했습니다(HTTP ${String(tokenResponse.status)}).`);
  }
  const token = ((await tokenResponse.json()) as { token?: unknown }).token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('GHCR 응답에 익명 토큰이 없습니다.');
  }
  const response = await fetcher(`https://ghcr.io/v2/${path}/manifests/${tag}`, {
    ...init,
    method: 'HEAD',
    headers: { ...init.headers, authorization: `Bearer ${token}`, accept: ACCEPT },
  });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`GHCR가 ${tag} 태그를 알려 주지 않았습니다(HTTP ${String(response.status)}).`);
  }
  const digest = response.headers.get('docker-content-digest') ?? '';
  if (!DIGEST.test(digest)) {
    throw new Error(`GHCR가 준 ${tag}의 다이제스트 형식이 맞지 않습니다.`);
  }

  return digest;
}
