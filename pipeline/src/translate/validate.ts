import { termsIn, type Glossary } from './glossary.ts';
import { placeholderNames, scanPlaceholders, withoutPlaceholders } from './masking.ts';

/** 번역할 항목 중 검증에 필요한 것. */
export interface CheckItem {
  readonly source: string;
  readonly kind: string;
  /** 이 키가 쓰이는 모든 kind. 하나라도 메시지면 메시지 규칙을 쓴다 */
  readonly kinds?: readonly string[];
  readonly placeholders: readonly string[];
}

/**
 * 하드 검사: 런타임을 깨거나 위험해지는 것. 걸리면 그 항목만 다시 요청하고, 그래도 실패하면 영어로 폴백한다.
 * - 번호 태그는 PHP 헬퍼(__h, coolify_ko_message)와 같은 규칙: 번호마다 한 번, 짝·빈 요소 종류 일치, 중첩 교차 금지.
 * - 원문에 없던 태그 시작열·엔티티, 늘어난 &lt;는 번역문이 HTML을 새로 만드는 것으로 본다.
 * - 알림·검증 문구는 줄바꿈 수와 앞뒤 공백을 원문과 같게 둔다(알림 본문은 pre-wrap).
 * - 원문에 원시 HTML 태그가 있으면(업스트림 점 키) 속성까지 포함한 태그 묶음이 원문과 똑같아야 한다.
 */
export type HardIssue = 'empty' | 'leftover-token' | 'placeholder-mismatch' | 'tag-structure' | 'new-markup' | 'raw-html-shape' | 'plural-shape' | 'control-char' | 'whitespace-shape';

export interface SoftReport {
  readonly glossaryMissing: readonly string[];
  readonly englishResidue: readonly string[];
  readonly tooLong: boolean;
  /** 문장일 때만: 합니다체로 끝났는지 */
  readonly formalEnding?: boolean;
  /** 짧은 라벨일 때만: 명사형으로 끝났는지 */
  readonly nounLabel?: boolean;
}

const MESSAGE_KINDS = new Set(['toast', 'toast-html', 'validation', 'validation-html']);

/** 알림·검증 문구로 쓰이는 키인지(첫 출현만이 아니라 모든 kind를 본다) */
export function isMessage(item: { readonly kind: string; readonly kinds?: readonly string[] }): boolean {
  return [item.kind, ...(item.kinds ?? [])].some((kind) => MESSAGE_KINDS.has(kind));
}
const NUMBERED = /<(\/?)(\d+)(\/?)>/g;
const BRACES = /\{\{[^{}]*\}\}/g;
const FULL_RAW_TAG = /<\/?[A-Za-z][^<>]*>/g;
const RAW_TAG = /<\/?[A-Za-z!?][^\s>/]*/g;
const ENTITY = /&(?:[A-Za-z][A-Za-z0-9]*|#\d+|#x[0-9a-fA-F]+);/g;
/** C0 제어문자(탭·줄바꿈·CR 제외)·DEL·제로폭·양방향 제어·BOM */
const CONTROL_RANGES: readonly (readonly [number, number])[] = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x7f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x2064], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'via', 'are', 'was', 'not', 'you', 'your', 'this', 'that', 'from', 'into', 'will', 'can', 'all', 'any', 'has', 'have', 'its', 'our', 'but']);

export function hardIssues(item: CheckItem, translation: string): HardIssue[] {
  const issues: HardIssue[] = [];
  if (translation.trim() === '') {
    issues.push('empty');
  }
  // 원문에 글자 그대로 있던 `{{…}}`는 남아야 맞다. 그보다 많거나 새로 생긴 것만 가리기 토큰이 남은 것이다
  const allowed = counts(item.source, BRACES);
  if ([...counts(translation, BRACES)].some(([token, n]) => n > (allowed.get(token) ?? 0))) {
    issues.push('leftover-token');
  }
  const names = placeholderNames(item.source, item.placeholders);
  const sourcePlaceholders = scanPlaceholders(item.source, names);
  const translationPlaceholders = scanPlaceholders(translation, names);
  if ([item.kind, ...(item.kinds ?? [])].includes('plural')) {
    // 한국어는 복수형이 없어 구간을 하나로 합쳐도 된다. 합치면 :count가 한 번만 남으므로 종류만 비교한다
    const forms = translation.split('|').length;
    if (forms !== 1 && forms !== item.source.split('|').length) {
      issues.push('plural-shape');
    }
    if (!sameMultiset([...new Set(sourcePlaceholders)], [...new Set(translationPlaceholders)])) {
      issues.push('placeholder-mismatch');
    }
  } else if (!sameMultiset(sourcePlaceholders, translationPlaceholders)) {
    issues.push('placeholder-mismatch');
  }
  if (!tagsMatch(item.source, translation)) {
    issues.push('tag-structure');
  }
  if (addsMarkup(item.source, translation)) {
    issues.push('new-markup');
  }
  const rawTags = item.source.match(FULL_RAW_TAG) ?? [];
  if (rawTags.length > 0 && !sameMultiset(rawTags, translation.match(FULL_RAW_TAG) ?? [])) {
    issues.push('raw-html-shape');
  }
  if (hasControl(translation)) {
    issues.push('control-char');
  }
  if (isMessage(item) && !sameShape(item.source, translation)) {
    issues.push('whitespace-shape');
  }

  return issues;
}

export function softReport(item: CheckItem, translation: string, glossary: Glossary): SoftReport {
  const words = item.source.trim().split(/\s+/).filter((w) => w !== '');
  const isLabel = words.length <= 3 && !/[.!?]$/.test(item.source.trim()) && !isMessage(item);
  const names = placeholderNames(item.source, item.placeholders);
  const report: { -readonly [K in keyof SoftReport]: SoftReport[K] } = {
    glossaryMissing: termsIn(withoutPlaceholders(item.source, names), glossary).filter((term) => !translation.includes(term.ko)).map((term) => term.en),
    englishResidue: englishResidue(item.source, withoutPlaceholders(translation, names), glossary),
    tooLong: isLabel && Array.from(translation).length > Math.max(2 * item.source.length, item.source.length + 8),
  };
  const end = translation.trim();
  if (isLabel) {
    report.nounLabel = !/(?:다|요|까|시오)[.!?]?$/.test(end);
  } else if (words.length >= 4 || /[.!?]$/.test(item.source.trim())) {
    report.formalEnding = /(?:니다|니까|시오|세요)[.!?]?$/.test(end);
  }

  return report;
}

function hasControl(text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (CONTROL_RANGES.some(([low, high]) => code >= low && code <= high)) {
      return true;
    }
  }

  return false;
}

function sameMultiset(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

/** 원문의 번호 태그 종류(짝/빈 요소)를 번역문이 같은 수·같은 종류·바른 중첩으로 쓰는지. */
function tagsMatch(source: string, translation: string): boolean {
  const expected = new Map<string, 'pair' | 'void'>();
  for (const [, closing, n, slash] of source.matchAll(NUMBERED)) {
    if (closing === '' && n !== undefined) {
      expected.set(n, slash === '/' ? 'void' : 'pair');
    }
  }
  const used = new Set<string>();
  const stack: string[] = [];
  for (const [, closing, n = '', slash] of translation.matchAll(NUMBERED)) {
    const kind = expected.get(n);
    if (kind === undefined || (closing === '/' && slash === '/')) {
      return false;
    }
    if (slash === '/') {
      if (kind !== 'void' || used.has(n)) {
        return false;
      }
      used.add(n);
    } else if (closing === '/') {
      if (kind !== 'pair' || stack.pop() !== n) {
        return false;
      }
    } else {
      if (kind !== 'pair' || used.has(n)) {
        return false;
      }
      used.add(n);
      stack.push(n);
    }
  }

  return stack.length === 0 && used.size === expected.size;
}

function counts(text: string, pattern: RegExp): Map<string, number> {
  const out = new Map<string, number>();
  for (const [match] of text.matchAll(pattern)) {
    const key = match.toLowerCase();
    out.set(key, (out.get(key) ?? 0) + 1);
  }

  return out;
}

/** 번역문이 원문에 없던 태그 시작열·엔티티를 쓰거나 같은 것을 원문보다 많이 쓰는지. */
function addsMarkup(source: string, translation: string): boolean {
  for (const pattern of [RAW_TAG, ENTITY]) {
    const allowed = counts(source, pattern);
    for (const [key, n] of counts(translation, pattern)) {
      if (n > (allowed.get(key) ?? 0)) {
        return true;
      }
    }
  }

  return false;
}

function sameShape(source: string, translation: string): boolean {
  const lines = (text: string): number => text.split('\n').length;
  const lead = (text: string): string => /^\s*/.exec(text)?.[0] ?? '';
  const trail = (text: string): string => /\s*$/.exec(text)?.[0] ?? '';

  return lines(source) === lines(translation) && lead(source) === lead(translation) && trail(source) === trail(translation);
}

/** 원문의 일반 영어 단어가 번역문에 그대로 남은 것. 브랜드·약어·숫자·점·슬래시가 든 토큰·URL·짧은 기능어는 뺀다. */
function englishResidue(source: string, translation: string, glossary: Glossary): string[] {
  const brandWords = new Set(glossary.brands.flatMap((brand) => brand.toLowerCase().split(/\s+/)));
  const out: string[] = [];
  for (const raw of source.split(/\s+/)) {
    const token = raw.replace(/^[("'[{]+|[)"'\]},.;:!?]+$/g, '');
    if (!/^[A-Za-z][A-Za-z'-]*$/.test(token) || token.length < 3 || /^[A-Z0-9]{2,}$/.test(token)) {
      continue;
    }
    const word = token.toLowerCase();
    if (STOPWORDS.has(word) || brandWords.has(word) || out.includes(word)) {
      continue;
    }
    if (new RegExp(`(?<![A-Za-z])${word}(?![A-Za-z])`, 'i').test(translation)) {
      out.push(word);
    }
  }

  return out;
}
