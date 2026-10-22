/**
 * Laravel 자리표시자(:name)를 번역하는 동안 이름 토큰 {{name}}으로 가리고 되돌린다.
 * Laravel(makeReplacements → strtr)과 같게 :Name·:NAME 변형도 바꾸고, 긴 이름부터 단어 경계 없이 바꾼다.
 */

export interface Masked {
  readonly text: string;
  /** 원문 순서대로 나온 토큰(같은 것이 여러 번이면 여러 번) */
  readonly tokens: readonly string[];
  /** 원문에 글자 그대로 있던 `{{…}}`. `{{KEEP_n}}`(n은 1부터)로 가렸다가 그대로 되돌린다 */
  readonly literals: readonly string[];
}

export interface Unmasked {
  readonly text: string;
  readonly missing: readonly string[];
  readonly extra: readonly string[];
}

const DETECT = /(?<![\w/]):([A-Za-z_][A-Za-z0-9_]*)/g;
const TOKEN = /\{\{[^{}]*\}\}/g;

/** 카탈로그가 아는 이름 ∪ 문장에서 Laravel 자리표시자로 보이는 이름(업스트림 키처럼 목록이 없을 때). */
export function placeholderNames(source: string, listed: readonly string[]): string[] {
  const names = new Set(listed);
  for (const match of source.matchAll(DETECT)) {
    names.add(match[1] ?? '');
  }
  names.delete('');

  return [...names];
}

function variants(names: readonly string[]): string[] {
  const out = new Set<string>();
  for (const name of names) {
    out.add(name);
    out.add(name.charAt(0).toUpperCase() + name.slice(1));
    out.add(name.toUpperCase());
  }

  return [...out].sort((a, b) => b.length - a.length);
}

/** strtr처럼 왼쪽부터, 각 위치에서 가장 긴 자리표시자를 찾는다. */
function scan(text: string, names: readonly string[], onMatch: (variant: string) => string): string {
  const keys = variants(names).map((variant) => [`:${variant}`, variant] as const);
  let out = '';
  for (let i = 0; i < text.length;) {
    const hit = keys.find(([key]) => text.startsWith(key, i));
    if (hit === undefined) {
      out += text.charAt(i);
      i++;
      continue;
    }
    out += onMatch(hit[1]);
    i += hit[0].length;
  }

  return out;
}

/** 문장에 나온 자리표시자(:name, :Name, :NAME)를 순서대로. */
export function scanPlaceholders(text: string, names: readonly string[]): string[] {
  const found: string[] = [];
  scan(text, names, (variant) => {
    found.push(`:${variant}`);

    return '';
  });

  return found;
}

/** 자리표시자를 공백으로 지운다. 이름 속 영어 단어(:fields_list의 fields)를 용어·잔존으로 세지 않으려고. */
export function withoutPlaceholders(text: string, names: readonly string[]): string {
  return scan(text, names, () => ' ');
}

export function mask(source: string, names: readonly string[]): Masked {
  const tokens: string[] = [];
  const literals: string[] = [];
  const maskPart = (part: string): string => {
    if (part.includes('{{') || part.includes('}}')) {
      throw new Error('원문에 짝이 맞지 않는 {{ 또는 }}가 있어 자리표시자를 가릴 수 없습니다.');
    }

    return scan(part, names, (variant) => {
      const token = `{{${variant}}}`;
      tokens.push(token);

      return token;
    });
  };
  let text = '';
  let last = 0;
  for (const match of source.matchAll(TOKEN)) {
    // 리터럴 안의 자리표시자(`{{vault.:key}}`의 :key)는 리터럴째 보존된다
    text += maskPart(source.slice(last, match.index));
    literals.push(match[0]);
    text += `{{KEEP_${String(literals.length)}}}`;
    last = match.index + match[0].length;
  }
  text += maskPart(source.slice(last));

  return { text, tokens, literals };
}

export function unmask(translation: string, masked: Masked): Unmasked {
  const keep = new Map(masked.literals.map((literal, index) => [`{{KEEP_${String(index + 1)}}}`, literal]));
  const expected = new Map<string, number>();
  for (const token of [...masked.tokens, ...keep.keys()]) {
    expected.set(token, (expected.get(token) ?? 0) + 1);
  }
  const found = translation.match(TOKEN) ?? [];
  const remaining = new Map(expected);
  const extra: string[] = [];
  for (const token of found) {
    const left = remaining.get(token) ?? 0;
    if (left > 0) {
      remaining.set(token, left - 1);
    } else {
      extra.push(token);
    }
  }
  const missing: string[] = [];
  for (const [token, left] of remaining) {
    for (let k = 0; k < left; k++) {
      missing.push(token);
    }
  }
  const text = translation.replace(TOKEN, (token) => keep.get(token) ?? (expected.has(token) ? `:${token.slice(2, -2)}` : token));

  return { text, missing, extra };
}
