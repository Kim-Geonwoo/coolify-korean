import { namesInOrder, normalizeKey, type DictionaryPattern, type ExtensionDictionary } from '../../../extension/src/engine.ts';
import { translationIssues } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';

/**
 * 확장(방법 C) 사전 만들기. 레포의 번역 묶음(catalog·reviewed·drafts·exclude·verbatim)만 읽는다.
 * 키는 화면에 보이는 영어(카탈로그 english)이고, 값은 번역이다. 확인 문구(verbatim)는 사전에 넣지 않고 보호 목록으로 둔다.
 */

// 확인 모달(components/modal-confirmation.blade.php)의 기본 confirmationText. 카탈로그 키가 아니라 verbatim 스캔에 없다
const DEFAULT_CONFIRMATIONS = ['Confirm Deletion'];
// 번호 태그(<0>·</0>·<0/>)가 아닌 HTML 태그: 화면에선 요소로 그려져 글로 맞출 수 없다
const RAW_HTML = /<(?!\/?\d+\/?>)[A-Za-z!/][^>]*>/;
const NUMBERED_TAG = /<\/?\d+\/?>/;
// Laravel 복수형 구간 앞의 개수 조건({0} · [1,*])
const PLURAL_RANGE = /^\s*(?:\{\d+\}|\[[^\]]*\])\s*/;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// 화면에 넣지 않을 글자: 제어 문자(줄바꿈·탭은 허용). release/select.ts의 selectKo와 같은 규칙
const isControl = (code: number): boolean => (code < 32 && code !== 9 && code !== 10) || code === 127;
const usable = (value: string): boolean => value !== '' && value.isWellFormed() && !Array.from(value).some((char) => isControl(char.charCodeAt(0)));

/**
 * 키마다 검수 번역 > 기계 초안을 고른다. 하드 검사(자리표시자·태그·확인 문구)에 걸리면 다음 순위로, 둘 다 안 되면 뺀다.
 * 제외 키는 넣지 않는다. A2의 selectPublic과 같은 우선순위(같은 커밋에서 결과가 같아야 한다)
 */
export function mergeLang(input: {
  readonly catalog: CatalogLite;
  readonly reviewed: Readonly<Record<string, string>>;
  readonly drafts: Readonly<Record<string, string>>;
  readonly exclusions: ReadonlyMap<string, string>;
  readonly verbatim: readonly string[];
}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(input.catalog.keys).sort(byCodeUnit)) {
    const entry = input.catalog.keys[key];
    if (entry === undefined || input.exclusions.has(key)) {
      continue;
    }
    const chosen = [input.reviewed[key], input.drafts[key]].find((value): value is string => value !== undefined && usable(value) && translationIssues(entry, value, input.verbatim).length === 0);
    if (chosen !== undefined) {
      out[key] = chosen;
    }
  }

  return out;
}

/** 복수형 키는 구간마다 따로 맞춘다. 번역 구간 수가 같으면 짝지어, 아니면 번역 전체를 쓴다(한국어는 보통 한 구간) */
function forms(english: string, value: string, plural: boolean): [string, string][] {
  if (!plural || !english.includes('|')) {
    return [[english, value]];
  }
  const sources = english.split('|').map((form) => form.replace(PLURAL_RANGE, ''));
  const values = value.split('|').map((form) => form.replace(PLURAL_RANGE, ''));

  return sources.map((source, index) => [source, values.length === sources.length ? (values[index] ?? value) : value]);
}

/** 사전을 만든다. 같은 입력이면 같은 JSON 바이트가 나오게 모든 목록을 정렬한다 */
export function buildDictionary(input: {
  readonly catalog: CatalogLite;
  readonly lang: Readonly<Record<string, string>>;
  readonly verbatim: readonly string[];
  readonly code: string;
  readonly version: string;
}): ExtensionDictionary {
  const protectedTexts = new Set([...input.verbatim, ...DEFAULT_CONFIRMATIONS].map(normalizeKey));
  const exact = new Map<string, string>();
  const tagged = new Map<string, string>();
  const patterns = new Map<string, DictionaryPattern>();
  const keys = Object.keys(input.catalog.keys).sort(byCodeUnit);
  // 같은 영어가 두 키에 있으면(문장 키와 업스트림 점 키) 문장 키를 먼저 쓴다
  const ordered = [...keys.filter((key) => input.catalog.keys[key]?.english === key), ...keys.filter((key) => input.catalog.keys[key]?.english !== key)];
  for (const key of ordered) {
    const entry = input.catalog.keys[key];
    const translation = input.lang[key];
    if (entry === undefined || translation === undefined || RAW_HTML.test(entry.english)) {
      continue;
    }
    for (const [form, value] of forms(entry.english, translation, entry.kinds.includes('plural'))) {
      const source = normalizeKey(form);
      if (source === '' || source === normalizeKey(value) || protectedTexts.has(source)) {
        continue;
      }
      const names = namesInOrder(source, entry.placeholders);
      if (names.length > 0) {
        if (!patterns.has(source)) {
          patterns.set(source, { source, names, value });
        }
      } else if (NUMBERED_TAG.test(source)) {
        if (!tagged.has(source)) {
          tagged.set(source, value);
        }
      } else if (!exact.has(source)) {
        exact.set(source, value);
      }
    }
  }
  const sortedRecord = (map: ReadonlyMap<string, string>): Record<string, string> => Object.fromEntries([...map.entries()].sort(([a], [b]) => byCodeUnit(a, b)));

  return {
    schema: 1,
    code: input.code,
    version: input.version,
    exact: sortedRecord(exact),
    patterns: [...patterns.values()].sort((a, b) => byCodeUnit(a.source, b.source)),
    tagged: sortedRecord(tagged),
    verbatim: [...new Set([...input.verbatim, ...DEFAULT_CONFIRMATIONS])].sort(byCodeUnit),
  };
}
