import type { DraftStore } from '../i18n/drafts.ts';
import { translationIssues } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { placeholderNames } from '../translate/masking.ts';
import type { ReviewedOutput } from '../weblate/bridge.ts';

export interface SelectCounts {
  readonly approved: number;
  readonly pending: number;
  readonly drafts: number;
  readonly english: number;
}

export interface Selection {
  readonly ko: Record<string, string>;
  readonly counts: SelectCounts;
}

// 화면에 넣지 않을 글자: 제어 문자(줄바꿈 10·탭 9는 허용)
const isControl = (code: number): boolean => (code < 32 && code !== 9 && code !== 10) || code === 127;

const usable = (value: string): boolean => {
  if (value === '' || !value.isWellFormed()) {
    return false;
  }
  for (let index = 0; index < value.length; index++) {
    if (isControl(value.charCodeAt(index))) {
      return false;
    }
  }

  return true;
};

/**
 * PaaS에 올릴 ko.json을 고른다(4단계 설계 5.1). 키마다 Weblate 승인 > Weblate 번역됨(사람이 고쳤지만 미승인) > 레포 기계 초안,
 * 어느 것도 하드 검사를 통과하지 못하면 넣지 않는다(영어). 승인을 내리면 다음 순위로 내려가고 레포의 옛 검수 값으로 돌아가지 않는다.
 * 키 범위는 카탈로그 ∪ 최신 카탈로그에서 빠졌지만 초안이 남은 키(removedIn): 옛 버전으로 도는 서버도 한국어로 남는다.
 * Weblate를 읽지 못했으면(weblate 없음) null: 부르는 쪽이 직전 파일을 그대로 둔다
 */
export function selectKo(input: {
  readonly catalog: CatalogLite;
  readonly store: Pick<DraftStore, 'drafts' | 'meta'>;
  readonly exclusions: ReadonlyMap<string, string>;
  readonly verbatim: readonly string[];
  readonly weblate: Pick<ReviewedOutput, 'reviewed' | 'pending'> | undefined;
}): Selection | null {
  if (input.weblate === undefined) {
    return null;
  }
  const { reviewed, pending } = input.weblate;
  const removed = Object.entries(input.store.meta).flatMap(([key, info]) => (info.removedIn !== undefined && !(key in input.catalog.keys) ? [key] : []));
  const ko: Record<string, string> = {};
  const counts = { approved: 0, pending: 0, drafts: 0, english: 0 };
  for (const key of [...Object.keys(input.catalog.keys), ...removed].sort()) {
    if (input.exclusions.has(key)) {
      continue;
    }
    // 빠진 키는 카탈로그 항목이 없어 키(영어 문장)로 검사 항목을 다시 만든다
    const entry = input.catalog.keys[key] ?? { english: key, kinds: ['text'], placeholders: placeholderNames(key, []) };
    const ok = (value: string | undefined): value is string => value !== undefined && usable(value) && translationIssues(entry, value, input.verbatim).length === 0;
    const candidates: [keyof typeof counts, string | undefined][] = [
      ['approved', reviewed[key]],
      ['pending', pending[key]],
      ['drafts', input.store.drafts[key]],
    ];
    const chosen = candidates.find(([, value]) => ok(value));
    if (chosen === undefined) {
      counts.english++;
      continue;
    }
    ko[key] = chosen[1] ?? '';
    counts[chosen[0]]++;
  }

  return { ko, counts };
}
