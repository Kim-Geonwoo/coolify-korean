/**
 * 번역문의 결정적 후처리. 모든 수정을 기록해 정밀도를 잴 수 있게 한다.
 * - imperative: 문장 끝 요청 "…십시오"를 "…세요"로(사용자 결정: 요청은 하세요). 따옴표 안·뒤에 낱말이 이어지는 것은 그대로.
 * - particle: 실행 때 값이 바뀌는 자리(자리표시자, 라틴·숫자로 끝나는 태그 내용) 뒤의 한쪽 조사를 병기로.
 *   태그 안이 한글로 끝나면 받침으로 바른 조사를 고른다. 빈 태그 뒤는 다음 문장의 첫 낱말일 수 있어 경고만 단다.
 */

export type NormalizeRule = 'imperative' | 'particle' | 'plural-single';

export interface NormalizeEdit {
  readonly rule: NormalizeRule;
  readonly before: string;
  readonly after: string;
  /** 수정한 곳 앞뒤 글자(사람이 맞는지 보려고) */
  readonly context: string;
}

export interface NormalizeResult {
  readonly text: string;
  readonly edits: readonly NormalizeEdit[];
  readonly warnings: readonly string[];
}

interface Particle {
  /** [받침 뒤, 모음 뒤] */
  readonly forms: readonly [string, string];
  readonly paired: string;
  /** ㄹ 받침 뒤에 모음 뒤 꼴을 쓰는가((으)로) */
  readonly rieul?: boolean;
  /** 뒤에 어미가 이어 붙는가(이었/였 + 지만·습니다) */
  readonly continues?: boolean;
}

// 긴 꼴을 먼저 맞춘다(이라는 → 이, 으로부터 → 으로)
const PARTICLES: readonly Particle[] = [
  { forms: ['으로부터', '로부터'], paired: '(으)로부터', rieul: true },
  { forms: ['으로서', '로서'], paired: '(으)로서', rieul: true },
  { forms: ['으로써', '로써'], paired: '(으)로써', rieul: true },
  { forms: ['으로', '로'], paired: '(으)로', rieul: true },
  { forms: ['이라는', '라는'], paired: '(이)라는' },
  { forms: ['이라고', '라고'], paired: '(이)라고' },
  { forms: ['이지만', '지만'], paired: '(이)지만' },
  { forms: ['이었', '였'], paired: '(이)었', continues: true },
  { forms: ['이며', '며'], paired: '(이)며' },
  { forms: ['이나', '나'], paired: '(이)나' },
  { forms: ['이고', '고'], paired: '(이)고' },
  { forms: ['이든', '든'], paired: '(이)든' },
  { forms: ['이면', '면'], paired: '(이)면' },
  { forms: ['을', '를'], paired: '을(를)' },
  { forms: ['이', '가'], paired: '이(가)' },
  { forms: ['은', '는'], paired: '은(는)' },
  { forms: ['과', '와'], paired: '와(과)' },
];

/** 이미 병기했지만 순서가 표준과 다른 꼴 */
const CANONICAL: readonly (readonly [string, string])[] = [
  ['(이)가', '이(가)'],
  ['가(이)', '이(가)'],
  ['를(을)', '을(를)'],
  ['는(은)', '은(는)'],
  ['과(와)', '와(과)'],
];

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const RIEUL = 8;

function isHangul(char: string | undefined): boolean {
  const code = char?.codePointAt(0) ?? 0;

  return code >= HANGUL_FIRST && code <= HANGUL_LAST;
}

/** 한글 음절의 받침 번호(0이면 받침 없음, 8이면 ㄹ) */
function finalConsonant(char: string): number {
  return ((char.codePointAt(0) ?? HANGUL_FIRST) - HANGUL_FIRST) % 28;
}

function contextOf(text: string, start: number, end: number): string {
  return text.slice(Math.max(0, start - 12), Math.min(text.length, end + 12));
}

type Anchor = { readonly end: number; readonly kind: 'pair' } | { readonly end: number; readonly kind: 'hangul'; readonly last: string } | { readonly end: number; readonly kind: 'void' | 'unknown' };

/** 조사가 붙을 수 있는 자리: 자리표시자 끝, 닫는 번호 태그 끝, 빈 번호 태그 끝 */
function anchors(text: string, names: readonly string[]): Anchor[] {
  const variants = [...new Set(names.flatMap((n) => [n, n.charAt(0).toUpperCase() + n.slice(1), n.toUpperCase()]))].sort((a, b) => b.length - a.length);
  const endsWithPlaceholder = (piece: string): boolean => variants.some((v) => piece.endsWith(`:${v}`));
  const out: Anchor[] = [];
  for (let i = 0; i < text.length; i++) {
    const variant = text.charAt(i) === ':' ? variants.find((v) => text.startsWith(v, i + 1)) : undefined;
    if (variant !== undefined) {
      out.push({ end: i + 1 + variant.length, kind: 'pair' });
      i += variant.length;
    }
  }
  for (const match of text.matchAll(/<(\/?)(\d+)(\/?)>/g)) {
    const end = match.index + match[0].length;
    if (match[3] === '/') {
      out.push({ end, kind: 'void' });
    } else if (match[1] === '/') {
      const open = text.lastIndexOf(`<${match[2] ?? ''}>`, match.index);
      const inner = (open < 0 ? '' : text.slice(open, match.index)).replace(/<\/?\d+\/?>/g, '').trimEnd();
      const last = Array.from(inner).at(-1);
      if (endsWithPlaceholder(inner) || (last !== undefined && /[A-Za-z0-9]/.test(last))) {
        out.push({ end, kind: 'pair' });
      } else if (last !== undefined && isHangul(last)) {
        out.push({ end, kind: 'hangul', last });
      } else {
        out.push({ end, kind: 'unknown' });
      }
    }
  }

  return out.sort((a, b) => a.end - b.end);
}

function boundary(text: string, at: number, continues: boolean): boolean {
  return continues ? isHangul(text.charAt(at)) : at >= text.length || !isHangul(text.charAt(at));
}

function particles(text: string, names: readonly string[], edits: NormalizeEdit[], warnings: Set<string>): string {
  const replacements: { start: number; end: number; after: string }[] = [];
  for (const anchor of anchors(text, names)) {
    const rest = text.slice(anchor.end);
    const canonical = CANONICAL.find(([odd]) => rest.startsWith(odd));
    if (canonical !== undefined && anchor.kind === 'pair') {
      replacements.push({ start: anchor.end, end: anchor.end + canonical[0].length, after: canonical[1] });
      continue;
    }
    if (/^(?:[을를이가은는와과]\([을를이가은는와과]\)|\((?:이|으)\))/.test(rest)) {
      continue;
    }
    let found: { particle: Particle; form: string } | undefined;
    for (const particle of PARTICLES) {
      const form = particle.forms.find((f) => rest.startsWith(f) && boundary(text, anchor.end + f.length, particle.continues === true));
      if (form !== undefined) {
        found = { particle, form };
        break;
      }
    }
    if (found === undefined) {
      continue;
    }
    const { particle, form } = found;
    if (anchor.kind === 'void' || anchor.kind === 'unknown') {
      warnings.add(anchor.kind === 'void' ? 'void-tag-particle' : 'tag-particle-unknown');
      continue;
    }
    let after = particle.paired;
    if (anchor.kind === 'hangul') {
      const final = finalConsonant(anchor.last);
      const vowelForm = final === 0 || (particle.rieul === true && final === RIEUL);
      after = vowelForm ? particle.forms[1] : particle.forms[0];
    }
    if (after !== form) {
      replacements.push({ start: anchor.end, end: anchor.end + form.length, after });
    }
  }
  let out = text;
  for (const r of [...replacements].sort((a, b) => b.start - a.start)) {
    edits.unshift({ rule: 'particle', before: out.slice(r.start, r.end), after: r.after, context: contextOf(out, r.start, r.end) });
    out = out.slice(0, r.start) + r.after + out.slice(r.end);
  }

  return out;
}

/** 따옴표로 감싼 구간([시작, 끝)) */
function quotedSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  const pairs: readonly (readonly [string, string])[] = [['‘', '’'], ['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]];
  for (const [open, close] of pairs) {
    for (let i = text.indexOf(open); i >= 0; ) {
      const j = text.indexOf(close, i + 1);
      if (j < 0) {
        break;
      }
      spans.push([i, j + 1]);
      i = text.indexOf(open, j + 1);
    }
  }

  return spans;
}

function imperatives(text: string, edits: NormalizeEdit[]): string {
  const spans = quotedSpans(text);
  let out = '';
  let last = 0;
  for (const match of text.matchAll(/십시오/g)) {
    const at = match.index;
    const quoted = spans.some(([s, e]) => at > s && at < e);
    if (quoted || isHangul(text.charAt(at + match[0].length))) {
      continue;
    }
    edits.push({ rule: 'imperative', before: '십시오', after: '세요', context: contextOf(text, at, at + 3) });
    out += `${text.slice(last, at)}세요`;
    last = at + match[0].length;
  }

  return out + text.slice(last);
}

/**
 * 복수형 키(카탈로그 kind plural)는 한국어에서 개수에 따라 낱말이 바뀌지 않으므로 첫 구간 하나만 남긴다.
 * Laravel trans_choice는 구간이 하나면 모든 개수에 그것을 쓰고, 하드 검사도 한 구간을 받는다(엔진이 둘째 구간에 "들"을 붙였다)
 */
function singlePlural(text: string, edits: NormalizeEdit[]): string {
  const bar = text.indexOf('|');
  if (bar < 0) {
    return text;
  }
  const first = text.slice(0, bar).trim();
  edits.push({ rule: 'plural-single', before: text, after: first, context: contextOf(text, 0, text.length) });

  return first;
}

export function normalize(translation: string, names: readonly string[], options: { readonly plural?: boolean } = {}): NormalizeResult {
  const edits: NormalizeEdit[] = [];
  const warnings = new Set<string>();
  // 복수형은 한 구간으로 먼저 줄이고, 조사를 고친 뒤 요청 끝말을 고친다(기록도 이 순서)
  const single = options.plural === true ? singlePlural(translation, edits) : translation;
  const text = imperatives(particles(single, names, edits, warnings), edits);

  return { text, edits, warnings: [...warnings] };
}
