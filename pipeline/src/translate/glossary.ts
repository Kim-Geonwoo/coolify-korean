import { readFileSync } from 'node:fs';

/** 영어 용어 → 늘 같은 한국어. forms는 복수형·활용형처럼 같은 용어로 볼 다른 꼴이다. */
export interface GlossaryTerm {
  readonly en: string;
  readonly ko: string;
  readonly forms?: readonly string[];
  readonly note?: string;
}

/** brands는 번역하지 않고 영어 그대로 두는 이름이다(codemod/rules/coolify.php의 brands를 포함한다). */
export interface Glossary {
  readonly terms: readonly GlossaryTerm[];
  readonly brands: readonly string[];
}

function nonEmpty(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`용어집 ${what}이(가) 비어 있거나 문자열이 아닙니다.`);
  }

  return value;
}

export function parseGlossary(data: unknown): Glossary {
  if (typeof data !== 'object' || data === null || !Array.isArray((data as { terms?: unknown }).terms) || !Array.isArray((data as { brands?: unknown }).brands)) {
    throw new Error('용어집은 { terms: [...], brands: [...] } 형식이어야 합니다.');
  }
  const raw = data as { terms: unknown[]; brands: unknown[] };
  const seen = new Set<string>();
  const terms = raw.terms.map((entry, index): GlossaryTerm => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`용어집 ${String(index)}번째 항목이 객체가 아닙니다.`);
    }
    const { en, ko, forms, note } = entry as Record<string, unknown>;
    const term: { en: string; ko: string; forms?: readonly string[]; note?: string } = { en: nonEmpty(en, 'en'), ko: nonEmpty(ko, 'ko') };
    if (forms !== undefined) {
      if (!Array.isArray(forms)) {
        throw new Error(`용어집 ${term.en}의 forms는 목록이어야 합니다.`);
      }
      term.forms = forms.map((form) => nonEmpty(form, `${term.en}.forms`));
    }
    if (note !== undefined) {
      term.note = nonEmpty(note, `${term.en}.note`);
    }
    const key = term.en.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`용어집에 같은 용어가 중복돼 있습니다: ${term.en}`);
    }
    seen.add(key);

    return term;
  });
  const brands = raw.brands.map((brand) => nonEmpty(brand, 'brands'));

  return { terms, brands };
}

export function loadGlossary(path: string): Glossary {
  return parseGlossary(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}

function plural(word: string): string {
  if (/[^aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }

  return /(?:s|x|ch|sh)$/i.test(word) ? `${word}es` : `${word}s`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 문장에 나온 용어. 긴 꼴부터 맞추고 겹치는 짧은 꼴은 버리며, 처음 나온 순서로 한 번씩 돌려준다. */
export function termsIn(text: string, glossary: Glossary): GlossaryTerm[] {
  const candidates = glossary.terms
    .flatMap((term) => [term.en, plural(term.en), ...(term.forms ?? [])].map((form) => ({ term, form })))
    .sort((a, b) => b.form.length - a.form.length);
  const claimed: { start: number; end: number; term: GlossaryTerm }[] = [];
  for (const { term, form } of candidates) {
    const pattern = new RegExp(`(?<![A-Za-z])${escapeRegExp(form).replace(/ /g, '\\s+')}(?![A-Za-z])`, 'gi');
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (!claimed.some((c) => start < c.end && end > c.start)) {
        claimed.push({ start, end, term });
      }
    }
  }
  const ordered = claimed.sort((a, b) => a.start - b.start).map((c) => c.term);

  return ordered.filter((term, index) => ordered.indexOf(term) === index);
}
