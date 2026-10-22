import { parsePublished, type PublishedLedger } from './ledger.ts';
import { platformManifests } from './verify.ts';

/**
 * 공개판 push(5단계 공개 계획 P6). 이 PC Docker(containerd 저장소)에서 `docker load` 다음 `docker push`가
 * 검증한 index 다이제스트를 그대로 지킨다(2026-10-20 로컬 레지스트리 실측). 발행한 버전 태그는 다른 내용으로 옮기지 않는다
 */
const DIGEST = /sha256:[0-9a-f]{64}/;

export function parseLoadedId(output: string): string {
  const digest = /Loaded image ID: (sha256:[0-9a-f]{64})/.exec(output)?.[1];
  if (digest === undefined) {
    throw new Error('docker load가 이미지 index 다이제스트를 알려 주지 않았습니다.');
  }

  return digest;
}

export function parsePushDigest(output: string): string {
  const line = output.split('\n').find((row) => /: digest: sha256:[0-9a-f]{64}/.test(row));
  const digest = line === undefined ? undefined : DIGEST.exec(line)?.[0];
  if (digest === undefined) {
    throw new Error('docker push가 다이제스트를 알려 주지 않았습니다.');
  }

  return digest;
}

/** 레지스트리에 그 버전 태그가 이미 있으면(existing) 같은 내용일 때만 넘어간다 */
export function pushDecision(existing: string | undefined, index: string): 'push' | 'already' | 'conflict' {
  if (existing === undefined) {
    return 'push';
  }

  return existing === index ? 'already' : 'conflict';
}

/** 레지스트리의 index가 검증한 플랫폼 manifest를 그대로 가리키는지 */
export function remoteIssues(remoteIndex: unknown, platforms: Readonly<Record<string, { readonly manifest: string }>>): string[] {
  const remote = new Map(platformManifests(remoteIndex).map((entry) => [entry.platform, entry.digest]));

  return Object.entries(platforms).flatMap(([platform, { manifest }]) => (remote.get(platform) === manifest ? [] : [`${platform}: 레지스트리 manifest가 검증한 것과 다름`]));
}

export function recordPublished(ledger: PublishedLedger, entry: { readonly version: string; readonly kind: 'ko' | 'passthrough'; readonly index: string; readonly commit: string | null; readonly at: Date }): PublishedLedger {
  if (entry.version in ledger.versions) {
    throw new Error(`${entry.version}은 이미 발행 기록에 있습니다(발행한 버전은 다시 쓰지 않습니다).`);
  }
  // 기록 형식 검사는 parsePublished가 한다(틀린 값이면 던진다)
  return parsePublished({ schema: 1, versions: { ...ledger.versions, [entry.version]: { kind: entry.kind, index: entry.index, commit: entry.commit, publishedAt: entry.at.toISOString() } } });
}
