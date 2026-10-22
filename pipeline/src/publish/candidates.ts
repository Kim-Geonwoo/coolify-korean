import type { PublishedLedger } from './ledger.ts';

/**
 * 밤 작업이 정하는 공개판 발행 후보(5단계). 후보는 사람이 PC에서 빌드·검증·승인해야 발행된다.
 * 상류 새 버전을 처음 본 뒤 2일 안에 한국어판이 준비되지 않으면 공식 이미지를 그대로 우리 이름으로 내는 통과 태그가 후보가 된다:
 * 우리 태그가 없으면 사용자 업데이트가 막혀 보안 패치가 늦어진다(사용자 결정 2, 11장 지연 상한)
 */
export const PUBLISH_LAG_MS = 2 * 24 * 60 * 60_000;

export type Candidate =
  | { readonly kind: 'none'; readonly reason: 'published' | 'hooks' | 'waiting' | 'gates' }
  | { readonly kind: 'ko'; readonly version: string; readonly commit: string }
  | { readonly kind: 'passthrough'; readonly version: string };

export function decideCandidate(input: {
  readonly upstream: { readonly version: string; readonly seenAt: string };
  readonly dev: { readonly version: string; readonly commit: string; readonly gates: 'passed' | 'failed' | 'unknown' };
  readonly hooksOk: boolean;
  readonly published: PublishedLedger;
  readonly now: Date;
  readonly lagMs?: number;
}): Candidate {
  const { version } = input.upstream;
  if (version in input.published.versions) {
    return { kind: 'none', reason: 'published' };
  }
  // 설치 후크가 바뀌었으면 우리 판이든 통과 태그든 사용자 업데이트를 깰 수 있어 사람이 볼 때까지 멈춘다
  if (!input.hooksOk) {
    return { kind: 'none', reason: 'hooks' };
  }
  const ready = input.dev.version === version;
  if (ready && input.dev.gates === 'passed') {
    return { kind: 'ko', version, commit: input.dev.commit };
  }
  const seen = Date.parse(input.upstream.seenAt);
  if (Number.isNaN(seen)) {
    throw new Error('상류 버전을 처음 본 시각을 읽지 못했습니다.');
  }
  if (input.now.getTime() - seen >= (input.lagMs ?? PUBLISH_LAG_MS)) {
    return { kind: 'passthrough', version };
  }

  return { kind: 'none', reason: ready && input.dev.gates === 'failed' ? 'gates' : 'waiting' };
}
