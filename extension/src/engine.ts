/**
 * coolify-ko 확장 번역 엔진(방법 C). 화면 글자만 사전으로 바꾸는 순수 함수 묶음이다.
 * import 없는 단일 모듈로 둔다: 팩이 export를 지우고 content·background 앞에 그대로 붙인다.
 * DOM은 nodeType·nodeValue·localName·parentElement·childNodes·getAttribute·hasAttribute만 쓴다.
 */

export interface DictionaryPattern {
  readonly source: string;
  readonly names: readonly string[];
  readonly value: string;
}

export interface ExtensionDictionary {
  readonly schema: 1;
  readonly code: string;
  readonly version: string;
  readonly exact: Readonly<Record<string, string>>;
  readonly patterns: readonly DictionaryPattern[];
  readonly tagged: Readonly<Record<string, string>>;
  readonly verbatim: readonly string[];
}

interface CompiledPattern {
  readonly regex: RegExp;
  readonly names: readonly string[];
  readonly value: string;
  readonly literalLength: number;
}

interface Buckets {
  // 리터럴 접두어(없으면 접미어) 앞 K자(K ≤ 12) → 후보. 조회는 K마다 Map 한 번
  readonly prefix: Map<number, Map<string, CompiledPattern[]>>;
  readonly suffix: Map<number, Map<string, CompiledPattern[]>>;
  readonly rest: CompiledPattern[];
}

export interface Compiled {
  readonly exact: ReadonlyMap<string, string>;
  readonly tagged: ReadonlyMap<string, string>;
  readonly plain: Buckets;
  readonly tags: Buckets;
  readonly verbatim: ReadonlySet<string>;
  readonly protectedTags: ReadonlySet<string>;
  readonly cache: Map<string, string | null>;
}

// 이보다 긴 글은 화면 문구가 아니라 로그·데이터로 본다(카탈로그 최장 키 613자)
const MAX_TEXT = 2000;
const CACHE_LIMIT = 20000;
const HANGUL = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// 사전 버전: 점으로 나눈 숫자(예: 4.4.6.202610182215 = 상류 버전 + 커밋 시각)
const VERSION = /^\d{1,12}(?:\.\d{1,12}){0,5}$/;
const CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const TAG = /<(\/?)(\d+)(\/?)>/g;
// 골격에 들어가는 인라인 요소. 그 밖의 요소는 글이 없을 때만 <n/>로 쓴다
export const INLINE_TAGS: ReadonlySet<string> = new Set(['a', 'strong', 'em', 'code', 'span', 'b', 'i']);
const PROTECTED_TAGS = ['script', 'style', 'textarea', 'code', 'pre', 'kbd', 'svg'];

/** 사전 키 정규화: 공백 묶음(줄바꿈·탭·no-break space 포함)을 한 칸으로, 앞뒤를 자른다 */
export function normalizeKey(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** 점으로 나눈 숫자 버전 비교(빈 자리는 0) */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isStringMap = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === 'string');

const isPattern = (value: unknown): value is DictionaryPattern =>
  isRecord(value) &&
  typeof value['source'] === 'string' &&
  typeof value['value'] === 'string' &&
  Array.isArray(value['names']) &&
  value['names'].length > 0 &&
  value['names'].every((name) => typeof name === 'string' && NAME.test(name));

/** 저장소·원격에서 읽은 값이 사전 모양인지(스키마 1) */
export function isDictionary(value: unknown): value is ExtensionDictionary {
  return (
    isRecord(value) &&
    value['schema'] === 1 &&
    typeof value['code'] === 'string' &&
    CODE.test(value['code']) &&
    typeof value['version'] === 'string' &&
    VERSION.test(value['version']) &&
    isStringMap(value['exact']) &&
    isStringMap(value['tagged']) &&
    Array.isArray(value['patterns']) &&
    value['patterns'].every(isPattern) &&
    Array.isArray(value['verbatim']) &&
    value['verbatim'].every((item) => typeof item === 'string')
  );
}

type Part = { readonly literal: string } | { readonly name: string };

/** 원문을 글자 조각과 자리표시자로 나눈다. 아는 이름만, 긴 이름부터 본다(`:mod_key_labelK`는 mod_key_label + K) */
function splitNames(source: string, names: readonly string[]): Part[] {
  const sorted = [...names].sort((a, b) => b.length - a.length);
  const parts: Part[] = [];
  let literal = '';
  for (let index = 0; index < source.length; ) {
    const name = source[index] === ':' ? sorted.find((candidate) => source.startsWith(candidate, index + 1)) : undefined;
    if (name === undefined) {
      literal += source[index] ?? '';
      index++;
      continue;
    }
    if (literal !== '') {
      parts.push({ literal });
      literal = '';
    }
    parts.push({ name });
    index += name.length + 1;
  }
  if (literal !== '') {
    parts.push({ literal });
  }

  return parts;
}

/** 원문에 나오는 자리표시자 이름을 처음 나온 순서로(사전 생성과 컴파일이 같은 규칙으로 나눈다) */
export function namesInOrder(source: string, names: readonly string[]): string[] {
  const order: string[] = [];
  for (const part of splitNames(source, names)) {
    if ('name' in part && !order.includes(part.name)) {
      order.push(part.name);
    }
  }

  return order;
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compilePattern(pattern: DictionaryPattern, tagged: boolean): { compiled: CompiledPattern; prefix: string; suffix: string } | null {
  const parts = splitNames(normalizeKey(pattern.source), pattern.names);
  const seen: string[] = [];
  let body = '';
  for (const part of parts) {
    if ('literal' in part) {
      body += escapeRegex(part.literal);
      continue;
    }
    const at = seen.indexOf(part.name);
    if (at >= 0) {
      body += `\\${String(at + 1)}`;
    } else {
      seen.push(part.name);
      body += tagged ? '([^<>]+?)' : '(.+?)';
    }
  }
  if (seen.length === 0) {
    return null;
  }
  const first = parts[0];
  const last = parts[parts.length - 1];
  const literalLength = parts.reduce((sum, part) => sum + ('literal' in part ? part.literal.length : 0), 0);

  return {
    compiled: { regex: new RegExp(`^${body}$`, 'u'), names: seen, value: pattern.value, literalLength },
    prefix: first !== undefined && 'literal' in first ? first.literal : '',
    suffix: last !== undefined && 'literal' in last ? last.literal : '',
  };
}

const BUCKET_CHARS = 12;

function push(level: Map<number, Map<string, CompiledPattern[]>>, key: string, pattern: CompiledPattern): void {
  let map = level.get(key.length);
  if (map === undefined) {
    map = new Map();
    level.set(key.length, map);
  }
  const list = map.get(key);
  if (list === undefined) {
    map.set(key, [pattern]);
  } else {
    list.push(pattern);
  }
}

function emptyBuckets(): Buckets {
  return { prefix: new Map(), suffix: new Map(), rest: [] };
}

/** 리터럴 접두어 앞 12자(짧으면 그 길이), 접두어가 없으면 접미어 끝 12자로 나눠, 조회 때 그 칸 후보만 정규식으로 본다 */
function addToBuckets(buckets: Buckets, pattern: CompiledPattern, prefix: string, suffix: string): void {
  if (prefix !== '') {
    push(buckets.prefix, prefix.slice(0, BUCKET_CHARS), pattern);
  } else if (suffix !== '') {
    push(buckets.suffix, suffix.slice(-BUCKET_CHARS), pattern);
  } else {
    buckets.rest.push(pattern);
  }
}

/** 사전을 조회용으로 바꾼다(정확 일치 Map + 자리표시자 정규식 버킷) */
export function compile(dict: ExtensionDictionary): Compiled {
  const exact = new Map<string, string>();
  for (const [key, value] of Object.entries(dict.exact)) {
    exact.set(normalizeKey(key), value);
  }
  const tagged = new Map<string, string>();
  for (const [key, value] of Object.entries(dict.tagged)) {
    tagged.set(normalizeKey(key), value);
  }
  const plain = emptyBuckets();
  const tags = emptyBuckets();
  for (const pattern of dict.patterns) {
    const isTagged = /<\/?\d+\/?>/.test(pattern.source);
    const built = compilePattern(pattern, isTagged);
    if (built !== null) {
      addToBuckets(isTagged ? tags : plain, built.compiled, built.prefix, built.suffix);
    }
  }

  return {
    exact,
    tagged,
    plain,
    tags,
    verbatim: new Set(dict.verbatim.map(normalizeKey)),
    protectedTags: new Set(PROTECTED_TAGS),
    cache: new Map(),
  };
}

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** 번역값의 :name(·:Name·:NAME)을 잡은 값으로 채운다. 모르는 이름은 그대로 둔다 */
function fill(value: string, names: readonly string[], captured: readonly string[]): string {
  const variants: [string, string][] = [];
  names.forEach((name, index) => {
    const got = captured[index] ?? '';
    variants.push([name, got], [upperFirst(name), upperFirst(got)], [name.toUpperCase(), got.toUpperCase()]);
  });
  const sorted = variants.sort((a, b) => b[0].length - a[0].length);
  let out = '';
  for (let index = 0; index < value.length; ) {
    const hit = value[index] === ':' ? sorted.find(([name]) => value.startsWith(name, index + 1)) : undefined;
    if (hit === undefined) {
      out += value[index] ?? '';
      index++;
    } else {
      out += hit[1];
      index += hit[0].length + 1;
    }
  }

  return out;
}

function candidates(buckets: Buckets, key: string): CompiledPattern[][] {
  const found: CompiledPattern[][] = [];
  for (const [length, map] of buckets.prefix) {
    const list = length <= key.length ? map.get(key.slice(0, length)) : undefined;
    if (list !== undefined) {
      found.push(list);
    }
  }
  for (const [length, map] of buckets.suffix) {
    const list = length <= key.length ? map.get(key.slice(-length)) : undefined;
    if (list !== undefined) {
      found.push(list);
    }
  }
  found.push(buckets.rest);

  return found;
}

function matchBuckets(buckets: Buckets, key: string): string | null {
  for (const list of candidates(buckets, key)) {
    for (const pattern of list) {
      if (pattern.literalLength >= key.length) {
        continue;
      }
      const match = pattern.regex.exec(key);
      if (match !== null) {
        return fill(pattern.value, pattern.names, match.slice(1));
      }
    }
  }

  return null;
}

function remember(compiled: Compiled, key: string, value: string | null): string | null {
  if (compiled.cache.size >= CACHE_LIMIT) {
    compiled.cache.clear();
  }
  compiled.cache.set(key, value);

  return value;
}

function lookup(compiled: Compiled, key: string): string | null {
  const cached = compiled.cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  return remember(compiled, key, compiled.exact.get(key) ?? matchBuckets(compiled.plain, key));
}

/** 화면 글 하나를 번역한다. 앞뒤 공백은 그대로 두고, 한글이 이미 있거나 확인 문구이거나 모르는 글이면 null */
export function translateText(compiled: Compiled, text: string): string | null {
  if (text.length > MAX_TEXT || HANGUL.test(text)) {
    return null;
  }
  const key = normalizeKey(text);
  if (key === '' || compiled.verbatim.has(key)) {
    return null;
  }
  const value = lookup(compiled, key);
  if (value === null) {
    return null;
  }
  const lead = /^\s*/.exec(text)?.[0] ?? '';
  const trail = /\s*$/.exec(text)?.[0] ?? '';

  return `${lead}${value}${trail}`;
}

/** 골격 키(`Click <0>here</0> …`)를 번역한다. 정확 일치 다음 태그 패턴(잡는 값은 한 태그 안) */
export function translateSkeleton(compiled: Compiled, skeleton: string): string | null {
  if (skeleton.length > MAX_TEXT || HANGUL.test(skeleton)) {
    return null;
  }
  const key = normalizeKey(skeleton);
  if (compiled.verbatim.has(key)) {
    return null;
  }

  return compiled.tagged.get(key) ?? matchBuckets(compiled.tags, key);
}

/** 이 요소(또는 조상)가 번역하면 안 되는 곳인지: 코드·입력·SVG·편집 영역·translate=no·.notranslate·로그 줄, value 없는 option */
export function isProtected(el: Element, compiled: Compiled): boolean {
  if (el.localName === 'option' && !el.hasAttribute('value')) {
    return true;
  }
  for (let current: Element | null = el; current !== null; current = current.parentElement) {
    if (compiled.protectedTags.has(current.localName)) {
      return true;
    }
    const editable = current.getAttribute('contenteditable');
    if (editable !== null && editable !== 'false') {
      return true;
    }
    if (current.getAttribute('translate') === 'no' || (current.getAttribute('class') ?? '').split(/\s+/).includes('notranslate')) {
      return true;
    }
    // 배포·런타임 로그 줄(Coolify의 data-log-line): 사용자 출력이라 번역하지 않고, 토큰이 찍힐 수 있어 누락 목록에도 모으지 않는다
    if (current.hasAttribute('data-log-line')) {
      return true;
    }
  }

  return false;
}

type TextOf = (node: Text) => string;

const ownText: TextOf = (node) => node.nodeValue ?? '';

type Token = { readonly kind: 'text'; readonly node: Text } | { readonly kind: 'tag'; readonly tag: string };

/** 요소 아래를 골격 토큰으로 편다. 인라인이 아닌 요소에 글이 있으면 null */
function tokenize(el: Element): Token[] | null {
  const tokens: Token[] = [];
  let counter = 0;
  const hasText = (node: Node): boolean => Array.from(node.childNodes).some((child) => (child.nodeType === 3 ? (child.nodeValue ?? '').trim() !== '' : child.nodeType === 1 && hasText(child)));
  const walk = (parent: Node): boolean => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 3) {
        tokens.push({ kind: 'text', node: child as Text });
        continue;
      }
      if (child.nodeType !== 1) {
        continue;
      }
      const element = child as Element;
      const number = String(counter++);
      if (!hasText(element)) {
        tokens.push({ kind: 'tag', tag: `<${number}/>` });
      } else if (INLINE_TAGS.has(element.localName)) {
        tokens.push({ kind: 'tag', tag: `<${number}>` });
        if (!walk(element)) {
          return false;
        }
        tokens.push({ kind: 'tag', tag: `</${number}>` });
      } else {
        return false;
      }
    }

    return true;
  };

  return walk(el) && counter > 0 ? tokens : null;
}

/** 자식이 글과 인라인 요소(a·strong·em·code·span·b·i)뿐이면 `<0>…</0>` 골격 키. textOf로 이미 바꾼 글의 원문을 읽는다 */
export function skeletonKey(el: Element, textOf: TextOf = ownText): string | null {
  const tokens = tokenize(el);
  if (tokens === null) {
    return null;
  }
  const key = normalizeKey(tokens.map((token) => (token.kind === 'tag' ? token.tag : textOf(token.node))).join(''));

  return /\p{L}/u.test(key.replace(TAG, '')) ? key : null;
}

/** 번역값을 태그와 글 조각으로 나눈다: 글 칸 수 = 태그 수 + 1 */
function splitValue(value: string): { tags: string[]; texts: string[] } {
  const tags: string[] = [];
  const texts: string[] = [];
  let last = 0;
  for (const match of value.matchAll(TAG)) {
    texts.push(value.slice(last, match.index));
    tags.push(match[0]);
    last = match.index + match[0].length;
  }
  texts.push(value.slice(last));

  return { tags, texts };
}

/**
 * 번역된 골격 값을 글 노드별 새 값으로 나눈다(요소는 만들지도 옮기지도 않는다). 태그 순서가 다르거나,
 * 번역 글이 들어갈 노드가 없거나, 보호 요소 안 글이 바뀌면 null
 */
export function planSkeleton(el: Element, value: string, compiled: Compiled, textOf: TextOf = ownText): [Text, string][] | null {
  const tokens = tokenize(el);
  if (tokens === null) {
    return null;
  }
  const slots: Text[][] = [[]];
  const domTags: string[] = [];
  for (const token of tokens) {
    if (token.kind === 'tag') {
      domTags.push(token.tag);
      slots.push([]);
    } else {
      slots[slots.length - 1]?.push(token.node);
    }
  }
  const { tags, texts } = splitValue(value);
  if (tags.join('') !== domTags.join('')) {
    return null;
  }
  const whole = tokens.flatMap((token) => (token.kind === 'text' ? [textOf(token.node)] : [])).join('');
  const lead = /^\s*/.exec(whole)?.[0] ?? '';
  const trail = /\s*$/.exec(whole)?.[0] ?? '';
  const plan: [Text, string][] = [];
  for (let index = 0; index < slots.length; index++) {
    const nodes = slots[index] ?? [];
    let next = texts[index] ?? '';
    if (index === 0) {
      next = lead + next;
    }
    if (index === slots.length - 1) {
      next += trail;
    }
    const [first, ...others] = nodes;
    if (first === undefined) {
      if (next.trim() !== '') {
        return null;
      }
      continue;
    }
    const before = nodes.map(textOf).join('');
    const owner = first.parentElement;
    if (owner !== null && isProtected(owner, compiled) && normalizeKey(before) !== normalizeKey(next)) {
      return null;
    }
    if (next.trim() === '' && before.trim() === '') {
      continue;
    }
    plan.push([first, next]);
    for (const other of others) {
      plan.push([other, '']);
    }
  }

  return plan;
}

// 누락으로 모으지 않을 글: 주소·경로·메일·버전·숫자
const DATA_LIKE = [/^https?:\/\//, /^\//, /^[\w.+-]+@[\w-]+\./, /^v?\d+(?:[.:]\d+)+/, /^[\d\s.,:%+-]+$/];
const MISSED_MAX = 200;

/** 사전에 없던 화면 글 중 영어 문구로 보이는 것만 누락 후보로 본다(밖으로 보내지 않고 로컬에만 둔다) */
export function isMissedCandidate(text: string): boolean {
  const value = normalizeKey(text);

  return value.length <= MISSED_MAX && /[A-Za-z]{3,}/.test(value) && !HANGUL.test(value) && !DATA_LIKE.some((pattern) => pattern.test(value));
}

/** 저장된 누락 목록에 새 글을 더한다(정규화, 중복 없이, 먼저 모은 것부터 limit개까지) */
export function mergeMissed(existing: unknown, added: Iterable<string>, limit: number): string[] {
  const out = new Set<string>();
  for (const item of Array.isArray(existing) ? (existing as unknown[]) : []) {
    if (typeof item === 'string' && out.size < limit) {
      out.add(normalizeKey(item));
    }
  }
  for (const item of added) {
    if (out.size >= limit) {
      break;
    }
    out.add(normalizeKey(item));
  }

  return [...out];
}
