import { sourceHash, translationIssues } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 새 버전 추출 뒤, Weblate 없이 레포의 검수 결과에서 낡은 것을 뺀다: 카탈로그에서 사라진 키, 영어가 바뀐 키(검수 때 원문 해시와 다름),
 * 번역 제외 키, 하드 검사에 걸리는 번역. 그날 Weblate 단계가 실패·꺼짐이어도 무결성 검사가 verify(초안 푸시)를 막지 않게 한다.
 * Weblate 단계가 돌면 어차피 Weblate에서 다시 만든다(검토 2026-10-18 Critical 1)
 */
export function pruneWeblateOutputs(input: {
  readonly catalog: CatalogLite;
  readonly exclusions: ReadonlyMap<string, string>;
  readonly verbatim: readonly string[];
  readonly reviewed: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, { readonly sourceHash: string }>>;
  readonly pending: Readonly<Record<string, string>>;
}): { reviewed: Record<string, string>; meta: Record<string, { sourceHash: string }>; pending: Record<string, string>; removed: string[] } {
  const usable = (key: string, value: string): boolean => {
    const entry = input.catalog.keys[key];

    return entry !== undefined && !input.exclusions.has(key) && translationIssues(entry, value, input.verbatim).length === 0;
  };
  const out = { reviewed: {} as Record<string, string>, meta: {} as Record<string, { sourceHash: string }>, pending: {} as Record<string, string>, removed: [] as string[] };
  for (const key of Object.keys(input.reviewed).sort(byCodeUnit)) {
    const value = input.reviewed[key] ?? '';
    const entry = input.catalog.keys[key];
    const hash = input.meta[key]?.sourceHash;
    if (entry !== undefined && hash === sourceHash(entry.english) && usable(key, value)) {
      out.reviewed[key] = value;
      out.meta[key] = { sourceHash: hash };
    } else {
      out.removed.push(`reviewed:${key}`);
    }
  }
  for (const key of Object.keys(input.pending).sort(byCodeUnit)) {
    const value = input.pending[key] ?? '';
    if (usable(key, value)) {
      out.pending[key] = value;
    } else {
      out.removed.push(`pending:${key}`);
    }
  }

  return out;
}
