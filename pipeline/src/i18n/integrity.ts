import { createHash } from 'node:crypto';
import { hardIssues } from '../translate/validate.ts';
import { verbatimMissing } from './verbatim.ts';

export interface IntegrityInput {
  readonly catalog: {
    readonly version: string;
    readonly keys: Readonly<Record<string, { readonly english: string; readonly kinds: readonly string[]; readonly placeholders: readonly string[] }>>;
  };
  readonly stateVersion: string;
  readonly exclusions: ReadonlyMap<string, string>;
  /** `i18n/drafts/ko.json`(없으면 초안 검사는 건너뛴다) */
  readonly drafts?: Readonly<Record<string, string>>;
  readonly meta?: Readonly<Record<string, { readonly run: string; readonly sourceHash: string; readonly removedIn?: string }>>;
  readonly runs?: Readonly<Record<string, unknown>>;
  /** 사용자가 글자 그대로 쳐야 하는 확인 문구(i18n/verbatim.json) */
  readonly verbatim?: readonly string[];
  /** Weblate에서 승인된 번역(i18n/reviewed/ko.json)과 그 메타 */
  readonly reviewed?: Readonly<Record<string, string>>;
  readonly reviewedMeta?: Readonly<Record<string, { readonly sourceHash: string }>>;
  /** 승인 전 사람 번역(i18n/pending/ko.json) */
  readonly pending?: Readonly<Record<string, string>>;
  /** 노출 스위치(i18n/release.json) */
  readonly release?: unknown;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 번역 하나의 하드 문제(하드 검사 + 확인 문구 원문 유지) */
export function translationIssues(entry: { readonly english: string; readonly kinds: readonly string[]; readonly placeholders: readonly string[] }, value: string, verbatim: readonly string[]): string[] {
  const issues: string[] = hardIssues({ source: entry.english, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, placeholders: entry.placeholders }, value);
  if (verbatimMissing(entry.english, value, verbatim).length > 0) {
    issues.push('verbatim');
  }

  return issues;
}

/** 검수 번역·승인 전 번역·노출 스위치. 초안과 따로 본다 */
function checkWeblateOutputs(input: IntegrityInput): string[] {
  const problems: string[] = [];
  const { catalog } = input;
  const verbatim = input.verbatim ?? [];
  if (input.reviewed !== undefined) {
    const keys = Object.keys(input.reviewed).sort(byCodeUnit);
    const meta = input.reviewedMeta ?? {};
    problems.push(...keys.filter((key) => !(key in catalog.keys)).map((key) => `검수 번역 키가 카탈로그에 없습니다: ${key}`));
    problems.push(...keys.filter((key) => input.exclusions.has(key)).map((key) => `번역 제외 키에 검수 번역이 있습니다: ${key}`));
    for (const key of keys.filter((k) => !input.exclusions.has(k))) {
      const entry = catalog.keys[key];
      const value = input.reviewed[key];
      if (entry === undefined || value === undefined) {
        continue;
      }
      const issues = translationIssues(entry, value, verbatim);
      if (issues.length > 0) {
        problems.push(`검수 번역이 하드 검사에 걸립니다: ${key} (${issues.join(', ')})`);
      }
    }
    for (const key of keys) {
      const entry = catalog.keys[key];
      const info = meta[key];
      if (entry !== undefined && info !== undefined && info.sourceHash !== sourceHash(entry.english)) {
        problems.push(`검수 뒤 원문이 바뀐 번역: ${key}`);
      }
    }
    problems.push(...keys.filter((key) => meta[key] === undefined).map((key) => `메타가 없는 검수 번역: ${key}`));
  }
  if (input.pending !== undefined) {
    const keys = Object.keys(input.pending).sort(byCodeUnit);
    problems.push(...keys.filter((key) => !(key in catalog.keys)).map((key) => `승인 전 번역 키가 카탈로그에 없습니다: ${key}`));
    for (const key of keys.filter((k) => !input.exclusions.has(k))) {
      const entry = catalog.keys[key];
      const value = input.pending[key];
      if (entry === undefined || value === undefined) {
        continue;
      }
      const issues = translationIssues(entry, value, verbatim);
      if (issues.length > 0) {
        problems.push(`승인 전 번역이 하드 검사에 걸립니다: ${key} (${issues.join(', ')})`);
      }
    }
  }
  if (input.release !== undefined) {
    const mode = typeof input.release === 'object' && input.release !== null && 'mode' in input.release ? input.release.mode : undefined;
    if (mode !== 'reviewed' && mode !== 'drafts') {
      problems.push('release.json mode는 reviewed 또는 drafts여야 합니다.');
    }
  }

  return problems;
}

/** 초안이 만들어진 영어 원문의 지문. 영어가 바뀌었는데(업스트림 점 키) 초안이 그대로면 낡은 것이다 */
export function sourceHash(english: string): string {
  return createHash('sha256').update(english).digest('hex').slice(0, 16);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    return Object.fromEntries(entries.map(([k, v]) => [k, sortValue(v)]));
  }

  return value;
}

/** 봇·사람 누가 써도 같은 바이트가 나오게: 키 정렬, 들여쓰기 2칸, 끝 줄바꿈 */
export function canonicalJson(value: unknown): string {
  return `${JSON.stringify(sortValue(value), null, 2)}\n`;
}

/** i18n 데이터끼리 어긋난 곳을 사람이 읽을 문장으로 모은다(없으면 빈 목록) */
export function checkIntegrity(input: IntegrityInput): string[] {
  const problems: string[] = [];
  const { catalog, drafts, meta = {}, runs = {} } = input;
  if (input.stateVersion !== catalog.version) {
    problems.push(`state.json 버전 ${input.stateVersion}이 카탈로그 버전 ${catalog.version}과 다릅니다.`);
  }
  if (drafts === undefined) {
    return [...problems, ...checkWeblateOutputs(input)];
  }
  const keys = Object.keys(drafts).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const known = keys.filter((key) => key in catalog.keys);
  for (const key of keys) {
    if (!(key in catalog.keys) && meta[key]?.removedIn === undefined) {
      problems.push(`초안 키가 카탈로그에 없습니다: ${key}`);
    }
  }
  for (const key of keys.filter((k) => input.exclusions.has(k))) {
    problems.push(`번역 제외 키에 초안이 있습니다: ${key}`);
  }
  for (const key of known.filter((k) => !input.exclusions.has(k))) {
    const entry = catalog.keys[key];
    const value = drafts[key];
    if (entry === undefined || value === undefined) {
      continue;
    }
    const issues = hardIssues({ source: entry.english, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, placeholders: entry.placeholders }, value);
    if (issues.length > 0) {
      problems.push(`초안이 하드 검사에 걸립니다: ${key} (${issues.join(', ')})`);
    }
    const dropped = verbatimMissing(entry.english, value, input.verbatim ?? []);
    if (dropped.length > 0) {
      problems.push(`확인 문구를 그대로 두지 않은 초안: ${key} (${dropped.join(', ')})`);
    }
  }
  for (const key of known) {
    const entry = catalog.keys[key];
    const info = meta[key];
    if (entry !== undefined && info !== undefined && info.sourceHash !== sourceHash(entry.english)) {
      problems.push(`원문이 바뀐 뒤 그대로인 초안: ${key}`);
    }
  }
  for (const key of keys) {
    const info = meta[key];
    if (info === undefined) {
      problems.push(`메타가 없는 초안: ${key}`);
    } else if (!(info.run in runs)) {
      problems.push(`메타의 실행 기록이 없습니다: ${key} (${info.run})`);
    }
  }

  return [...problems, ...checkWeblateOutputs(input)];
}
