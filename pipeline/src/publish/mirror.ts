import { canonicalJson } from '../i18n/integrity.ts';
import { compare, parseStableVersion } from '../sync/upstream.ts';
import { latestPublished, type PublishedLedger } from './ledger.ts';

/**
 * 다른 사용자의 Coolify가 `.env`의 VERSIONS_URL로 매시 읽는 versions.json 미러(5단계 설계 3장·검토 중대 4).
 * 상류 파일을 키 순서까지 그대로 복사하고 `coolify.v4.version`만 우리가 발행한 최신으로 바꾼다.
 * helper·sentinel·traefik은 상류 값을 그대로 따라야 패치가 늦지 않는다. 미러가 멈췄는지 화면 배너가 알 수 있게
 * 끝에 `coolify-ko` 기록(상류 버전·처음 본 시각·갱신 시각)을 더한다(Coolify는 응답 전체를 저장한다)
 */
export interface MirrorInfo {
  readonly schema: 1;
  readonly upstream: string;
  readonly upstreamSeenAt: string;
  readonly refreshedAt: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const KEY = 'coolify-ko';

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** coolify.v4.version만 바꾼 깊은 복사(키 순서 유지) */
function withCoolifyVersion(cdn: Record<string, unknown>, version: string): Record<string, unknown> {
  const copy = structuredClone(cdn);
  const v4 = (copy['coolify'] as Record<string, unknown> | undefined)?.['v4'];
  if (!isObject(v4)) {
    throw new Error('versions.json에 coolify.v4가 없습니다.');
  }
  v4['version'] = version;

  return copy;
}

export function buildMirror(input: { readonly cdn: unknown; readonly published: PublishedLedger; readonly upstreamSeenAt: string; readonly now: Date }): Record<string, unknown> {
  if (!isObject(input.cdn)) {
    throw new Error('versions.json이 객체가 아닙니다.');
  }
  const upstream = parseStableVersion(input.cdn);
  const ours = latestPublished(input.published);
  if (ours === undefined) {
    throw new Error('발행한 버전이 없어 미러를 만들지 않습니다.');
  }
  if (compare(upstream, ours) < 0) {
    throw new Error(`상류 versions.json(${upstream})이 우리 최신 발행(${ours})보다 낮습니다(역행). 미러를 쓰지 않습니다.`);
  }
  if (Number.isNaN(Date.parse(input.upstreamSeenAt))) {
    throw new Error('상류 버전을 처음 본 시각이 날짜가 아닙니다.');
  }
  const info: MirrorInfo = { schema: 1, upstream, upstreamSeenAt: input.upstreamSeenAt, refreshedAt: input.now.toISOString() };

  return { ...withCoolifyVersion(input.cdn, ours), [KEY]: info };
}

/**
 * 상류 값이 셸에 들어가도 안전한 꼴인지. 상류 Coolify는 helper·sentinel 버전을 이스케이프 없이 docker 명령에 넣으므로
 * 상류 파일이 오염돼도 퍼뜨리지 않는다(보안 점검 2026-10-22). 새 꼴의 값이 생기면 미러가 멈추고 알린다(실패 쪽으로 닫힘)
 */
const SAFE_KEY = /^[A-Za-z0-9._-]{1,40}$/;
const SAFE_VALUE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function unsafeValues(value: unknown, path: string): string[] {
  if (isObject(value)) {
    return Object.entries(value).flatMap(([key, child]) => (SAFE_KEY.test(key) ? unsafeValues(child, `${path}.${key}`) : [`안전하지 않은 값: ${path} 아래 키`]));
  }
  if (typeof value === 'string' && (path.endsWith('.digest') ? DIGEST.test(value) : SAFE_VALUE.test(value))) {
    return [];
  }

  return [`안전하지 않은 값: ${path}`];
}

/** 게시 전 마지막 검사. 문제가 없으면 빈 배열 */
export function mirrorIssues(mirror: unknown, cdn: unknown, published: PublishedLedger): string[] {
  if (!isObject(mirror) || !isObject(cdn)) {
    return ['미러나 상류 versions.json이 객체가 아님'];
  }
  const issues: string[] = [];
  const version = ((mirror['coolify'] as Record<string, unknown> | undefined)?.['v4'] as { version?: unknown } | undefined)?.version;
  let upstream: string;
  try {
    upstream = parseStableVersion(cdn);
  } catch {
    return ['상류 versions.json의 버전을 읽지 못함'];
  }
  if (typeof version !== 'string' || !VERSION.test(version)) {
    return ['미러의 coolify.v4.version이 x.y.z가 아님'];
  }
  if (compare(version, upstream) > 0) {
    issues.push(`상류(${upstream})보다 높은 버전 ${version}을 알림`);
  }
  if (!(version in published.versions)) {
    issues.push(`발행하지 않은 버전 ${version}을 알림`);
  }
  const { [KEY]: info, ...rest } = mirror;
  if (canonicalJson(withCoolifyVersion(rest, upstream)) !== canonicalJson(cdn)) {
    issues.push('coolify 버전 밖의 값이 상류와 다름');
  }
  issues.push(...unsafeValues(rest, 'versions'));
  const record = isObject(info) ? info : undefined;
  if (record?.['schema'] !== 1 || typeof record['upstream'] !== 'string' || !VERSION.test(record['upstream']) || typeof record['refreshedAt'] !== 'string' || Number.isNaN(Date.parse(record['refreshedAt'])) || typeof record['upstreamSeenAt'] !== 'string' || Number.isNaN(Date.parse(record['upstreamSeenAt']))) {
    issues.push(`${KEY} 기록이 없거나 형식이 틀림`);
  }

  return issues;
}
