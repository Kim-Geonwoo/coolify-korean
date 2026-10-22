import { compare } from '../sync/upstream.ts';

/**
 * 공개 발행 기록(`releases/published.json`, 공개 기록). 발행 명령이 사람 승인 뒤 한 줄씩 더한다.
 * 미러는 여기 있는 버전만 알린다(태그 없는 버전을 알리면 사용자 업데이트가 매시 실패한다, 검토 치명 1)
 */
export interface PublishedEntry {
  readonly kind: 'ko' | 'passthrough';
  /** 레지스트리에 올린 이미지 index 다이제스트 */
  readonly index: string;
  /** 한국어판을 만든 dev 커밋(통과 태그면 null) */
  readonly commit: string | null;
  readonly publishedAt: string;
}

export interface PublishedLedger {
  readonly schema: 1;
  readonly versions: Readonly<Record<string, PublishedEntry>>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const GIT_ID = /^[0-9a-f]{40}$/;

function entry(version: string, value: unknown): PublishedEntry {
  const { kind, index, commit, publishedAt } = (value ?? {}) as Record<string, unknown>;
  const fail = (field: string): never => {
    throw new Error(`published.json ${version}의 ${field} 값이 맞지 않습니다.`);
  };
  if (kind !== 'ko' && kind !== 'passthrough') {
    return fail('kind');
  }
  if (typeof index !== 'string' || !DIGEST.test(index)) {
    return fail('index');
  }
  if (kind === 'ko' ? typeof commit !== 'string' || !GIT_ID.test(commit) : commit !== null) {
    return fail('commit');
  }
  if (typeof publishedAt !== 'string' || Number.isNaN(Date.parse(publishedAt))) {
    return fail('publishedAt');
  }

  return { kind, index, commit: commit as string | null, publishedAt };
}

export function parsePublished(data: unknown): PublishedLedger {
  const { schema, versions } = (data ?? {}) as Record<string, unknown>;
  if (schema !== 1 || typeof versions !== 'object' || versions === null || Array.isArray(versions)) {
    throw new Error('published.json 형식이 맞지 않습니다.');
  }
  const out: Record<string, PublishedEntry> = {};
  for (const [version, value] of Object.entries(versions)) {
    if (!VERSION.test(version)) {
      throw new Error(`published.json의 버전이 x.y.z가 아닙니다: ${version.slice(0, 20)}`);
    }
    out[version] = entry(version, value);
  }

  return { schema: 1, versions: out };
}

export function latestPublished(ledger: PublishedLedger): string | undefined {
  return Object.keys(ledger.versions).sort(compare).at(-1);
}
