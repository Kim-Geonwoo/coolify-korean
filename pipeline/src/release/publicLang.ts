import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { DraftMeta } from '../i18n/drafts.ts';
import { langPaths } from '../i18n/languages.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { serializeKo } from './handoff.ts';
import { selectKo, type SelectCounts, type Selection } from './select.ts';

/**
 * 다른 사용자용 공개판 이미지에 넣을 기본 언어 파일(5단계 설계 11장). 레포의 검수본(reviewed) > 기계 초안 순으로 고르고,
 * 승인 전 사람 번역(pending)은 넣지 않는다(검토 11: Weblate를 연 사람이 검수 없이 경고 문구를 바꿀 수 있다)
 */
export function selectPublic(input: {
  readonly catalog: CatalogLite;
  readonly reviewed: Readonly<Record<string, string>>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, DraftMeta>>;
  readonly exclusions: ReadonlyMap<string, string>;
  readonly verbatim: readonly string[];
}): Selection {
  const selection = selectKo({ catalog: input.catalog, store: { drafts: input.drafts, meta: input.meta }, exclusions: input.exclusions, verbatim: input.verbatim, weblate: { reviewed: input.reviewed, pending: {} } });
  if (selection === null) {
    throw new Error('공개판 언어 파일을 고르지 못했습니다.');
  }

  return selection;
}

/** 그 커밋의 레포 파일로 공개판 언어 파일을 만든다(작업 사본이 아니라 커밋을 읽어, 빌드한 커밋과 내용이 어긋나지 않게) */
export function publicLangFile(repo: string, commit: string, code: string): { readonly text: string; readonly sha256: string; readonly counts: SelectCounts } {
  const show = (path: string): string | undefined => {
    const result = spawnSync('git', ['-C', repo, 'show', `${commit}:${path}`], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });

    return result.status === 0 ? result.stdout : undefined;
  };
  const json = <T>(path: string, fallback?: T): T => {
    const text = show(path);
    if (text === undefined) {
      if (fallback === undefined) {
        throw new Error(`${commit.slice(0, 7)}에 ${path}가 없습니다.`);
      }

      return fallback;
    }

    return JSON.parse(text) as T;
  };
  const paths = langPaths(code);
  const selection = selectPublic({
    catalog: json<CatalogLite>('i18n/catalog.json'),
    reviewed: json<Record<string, string>>(paths.reviewed, {}),
    drafts: json<Record<string, string>>(paths.drafts),
    meta: json<Record<string, DraftMeta>>(paths.draftsMeta),
    exclusions: new Map(Object.entries(json<{ keys: Record<string, string> }>('i18n/exclude.json').keys)),
    verbatim: json<{ literals: string[] }>('i18n/verbatim.json').literals,
  });
  const text = serializeKo(selection.ko);

  return { text, sha256: createHash('sha256').update(text).digest('hex'), counts: selection.counts };
}
