import type { ReviewResult } from '../translate/review.ts';
import type { DraftMeta, DraftStore } from './drafts.ts';

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 아직 검토하지 않은 초안. 이번 버전의 새 키가 먼저고, 없어진 키는 검토하지 않는다 */
export function reviewQueue(store: DraftStore, options: { readonly newest: readonly string[]; readonly limit: number }): string[] {
  const waiting = (key: string): boolean => {
    const info = store.meta[key];

    return key in store.drafts && info !== undefined && info.review === undefined && info.removedIn === undefined;
  };
  const first = [...options.newest].filter(waiting).sort(byCodeUnit);
  const rest = Object.keys(store.drafts).filter((key) => waiting(key) && !first.includes(key)).sort(byCodeUnit);

  return [...first, ...rest].slice(0, options.limit);
}

/** 판정을 메타에 남긴다. 초안 값은 바꾸지 않는다(고친 번역은 제안으로만 둔다) */
export function applyReviews(store: DraftStore, results: readonly ReviewResult[], options: { readonly run: string; readonly gatePassed: boolean }): DraftStore {
  const meta = new Map<string, DraftMeta>(Object.entries(store.meta));
  for (const result of results) {
    const info = meta.get(result.id);
    if (info === undefined || !(result.id in store.drafts)) {
      continue;
    }
    meta.set(result.id, {
      ...info,
      review: {
        verdict: result.verdict,
        reason: result.reason,
        ...(result.fix === undefined ? {} : { fix: result.fix }),
        run: options.run,
        ...(options.gatePassed && result.verdict === 'major' ? { needsReview: true as const } : {}),
      },
    });
  }

  return { ...store, meta: Object.fromEntries(meta) };
}

/** 서버 캐시(reviews.jsonl)의 한 줄. 검토한 원문 지문과 초안을 함께 남겨, 바뀐 뒤에는 다시 얹지 않는다 */
export interface CachedReview extends ReviewResult {
  readonly key: string;
  readonly sourceHash: string;
  readonly draft: string;
  readonly run: string;
}

/** 작업 사본은 매일 origin/dev로 돌아가므로, 캐시에 쌓인 판정을 원문·초안이 그대로인 키에만 다시 얹는다 */
export function applyCachedReviews(store: DraftStore, cached: readonly CachedReview[], options: { readonly gatePassed: boolean }): DraftStore {
  let out = store;
  for (const review of cached) {
    const info = store.meta[review.key];
    if (info?.sourceHash === review.sourceHash && store.drafts[review.key] === review.draft) {
      out = applyReviews(out, [{ ...review, id: review.key }], { run: review.run, gatePassed: options.gatePassed });
    }
  }

  return out;
}
