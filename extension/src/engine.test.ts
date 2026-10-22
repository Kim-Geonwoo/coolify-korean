import { describe, expect, it } from 'vitest';
import { compareVersions, compile, isDictionary, isMissedCandidate, isProtected, mergeMissed, normalizeKey, planSkeleton, skeletonKey, translateSkeleton, translateText, type ExtensionDictionary } from './engine.ts';

const dictionary = (patch: Partial<ExtensionDictionary> = {}): ExtensionDictionary => ({
  schema: 1,
  code: 'ko',
  version: '4.4.6.1',
  exact: { Save: '저장', 'Confirm Deletion': '삭제 확인', 'Shared variables': '공유 변수' },
  patterns: [
    { source: 'Deploy :name', names: ['name'], value: ':name 배포' },
    { source: ':count of :total done', names: ['count', 'total'], value: ':total개 중 :count개 완료' },
    { source: 'Press :mod_key_labelK', names: ['mod_key_label'], value: ':mod_key_labelK 누르기' },
    { source: '<0>:name</0> is used by', names: ['name'], value: '<0>:name</0>을(를) 쓰는 곳' },
  ],
  tagged: { 'Click <0>here</0> to continue': '계속하려면 <0>여기</0>를 누르세요' },
  verbatim: ['Confirm Deletion'],
  ...patch,
});

// 엔진이 쓰는 DOM 표면만 흉내 낸 작은 가짜 노드(vitest에 DOM 환경이 없고 새 의존성을 넣지 않는다)
interface FakeNode {
  nodeType: number;
  nodeValue: string | null;
  parentElement: FakeElement | null;
  childNodes: FakeNode[];
}
interface FakeElement extends FakeNode {
  localName: string;
  getAttribute: (name: string) => string | null;
  hasAttribute: (name: string) => boolean;
}

function text(value: string): FakeNode {
  return { nodeType: 3, nodeValue: value, parentElement: null, childNodes: [] };
}

function el(localName: string, attributes: Record<string, string>, ...children: FakeNode[]): FakeElement {
  const element: FakeElement = {
    nodeType: 1,
    nodeValue: null,
    localName,
    parentElement: null,
    childNodes: children,
    getAttribute: (name) => attributes[name] ?? null,
    hasAttribute: (name) => name in attributes,
  };
  for (const child of children) {
    child.parentElement = element;
  }

  return element;
}

const asElement = (node: FakeElement): Element => node as unknown as Element;

describe('normalizeKey', () => {
  it('folds runs of whitespace, including no-break spaces, into one space and trims', () => {
    expect(normalizeKey('\n   Shared   variables\t ')).toBe('Shared variables');
  });
});

describe('translateText', () => {
  it('keeps the leading and trailing whitespace of the original', () => {
    expect(translateText(compile(dictionary()), '  Save  ')).toBe('  저장  ');
  });

  it('matches Blade-indented text through the normalized key', () => {
    expect(translateText(compile(dictionary()), '\n      Shared\n      variables\n')).toBe('\n      공유 변수\n');
  });

  it('fills a pattern with the captured value unchanged', () => {
    expect(translateText(compile(dictionary()), 'Deploy my-app')).toBe('my-app 배포');
    expect(translateText(compile(dictionary()), '3 of 10 done')).toBe('10개 중 3개 완료');
  });

  it('splits on the known placeholder name, not on the longest identifier', () => {
    expect(translateText(compile(dictionary()), 'Press CtrlK')).toBe('CtrlK 누르기');
  });

  it('returns null for verbatim confirmation text even if the dictionary has it', () => {
    expect(translateText(compile(dictionary()), 'Confirm Deletion')).toBeNull();
    expect(translateText(compile(dictionary()), ' Confirm  Deletion ')).toBeNull();
  });

  it('returns null for text that already has Hangul', () => {
    expect(translateText(compile(dictionary()), '저장')).toBeNull();
    expect(translateText(compile(dictionary()), 'Save 저장')).toBeNull();
  });

  it('returns null for unknown or blank text', () => {
    expect(translateText(compile(dictionary()), 'Unknown words')).toBeNull();
    expect(translateText(compile(dictionary()), '   ')).toBeNull();
  });

  it('looks up 1000 texts among 4000 patterns within 50ms', () => {
    const words = ['Server', 'Backup', 'Domain', 'Volume', 'Proxy', 'Token', 'Team', 'Webhook', 'Deployment', 'Network'];
    const verbs = ['was updated', 'is ready', 'failed', 'will restart', 'has been removed', 'is unreachable', 'needs attention', 'was created'];
    const patterns = Array.from({ length: 4000 }, (_, index) => {
      const word = words[index % words.length] ?? '';
      const verb = verbs[Math.floor(index / words.length) % verbs.length] ?? '';
      const source = index % 3 === 0 ? `:name ${word} ${verb} #${String(index)}` : `${word} ${String(index)} :name ${verb}`;

      return { source, names: ['name'], value: `:name ${String(index)}` };
    });
    const compiled = compile(dictionary({ patterns }));
    const texts = Array.from({ length: 1000 }, (_, index) => (index % 2 === 0 ? `Backup ${String(index * 3 + 1)} item-${String(index)} is ready` : `no such text ${String(index)}`));
    const started = performance.now();
    for (const value of texts) {
      translateText(compiled, value);
    }
    const elapsed = performance.now() - started;

    expect(translateText(compiled, 'Backup 11 item-x is ready')).toBe('item-x 11');
    expect(elapsed).toBeLessThan(50);
  });
});

describe('isProtected', () => {
  it('protects code, pre, textarea, svg, editable and no-translate areas and their descendants', () => {
    const compiled = compile(dictionary());
    const inCode = el('span', {});
    el('div', {}, el('code', {}, inCode));
    const editable = el('p', {});
    el('div', { contenteditable: 'true' }, editable);
    const marked = el('span', {});
    el('div', { translate: 'no' }, marked);
    const classed = el('span', {});
    el('div', { class: 'card notranslate' }, classed);

    expect(isProtected(asElement(inCode), compiled)).toBe(true);
    expect(isProtected(asElement(editable), compiled)).toBe(true);
    expect(isProtected(asElement(marked), compiled)).toBe(true);
    expect(isProtected(asElement(classed), compiled)).toBe(true);
    for (const tag of ['script', 'style', 'textarea', 'pre', 'kbd', 'svg']) {
      expect(isProtected(asElement(el(tag, {})), compiled)).toBe(true);
    }
  });

  // 2026-10-22 보안 점검: 배포·런타임 로그 줄(토큰이 찍힐 수 있다)은 번역하지도 누락 목록에 모으지도 않는다
  it('protects deployment and runtime log lines', () => {
    const compiled = compile(dictionary());
    const text = el('span', { 'data-line-text': 'TOKEN=abc' });
    el('div', { 'data-log-line': '', class: 'log-line logs-viewer-line' }, text);

    expect(isProtected(asElement(text), compiled)).toBe(true);
  });

  it('protects an option without a value attribute, whose text is the submitted value', () => {
    const compiled = compile(dictionary());

    expect(isProtected(asElement(el('option', {})), compiled)).toBe(true);
    expect(isProtected(asElement(el('option', { value: 'save' })), compiled)).toBe(false);
  });

  it('leaves ordinary elements alone', () => {
    const compiled = compile(dictionary());
    const label = el('span', {});
    el('div', { class: 'card', contenteditable: 'false' }, el('p', {}, label));

    expect(isProtected(asElement(label), compiled)).toBe(false);
  });
});

describe('skeletonKey', () => {
  it('numbers inline children in document order around the text', () => {
    const paragraph = el('p', {}, text('\n  Click '), el('a', { href: '#' }, text('here')), text(' to continue\n'));

    expect(skeletonKey(asElement(paragraph))).toBe('Click <0>here</0> to continue');
  });

  it('writes empty elements as self-closing tags and nests inline elements', () => {
    const block = el('div', {}, el('strong', {}, text('Note:'), el('em', {}, text('read'))), text(' this '), el('br', {}));

    expect(skeletonKey(asElement(block))).toBe('<0>Note:<1>read</1></0> this <2/>');
  });

  it('returns null without element children or with a non-inline child that has text', () => {
    expect(skeletonKey(asElement(el('p', {}, text('Save'))))).toBeNull();
    expect(skeletonKey(asElement(el('div', {}, text('Hi '), el('div', {}, text('block')))))).toBeNull();
  });

  it('reads text through the given accessor so a partly translated container still gives the English key', () => {
    const link = text('여기');
    const paragraph = el('p', {}, text('Click '), el('a', {}, link), text(' to continue'));
    const original = (node: Text): string => (node === (link as unknown as Text) ? 'here' : (node.nodeValue ?? ''));

    expect(skeletonKey(asElement(paragraph), original)).toBe('Click <0>here</0> to continue');
  });
});

describe('translateSkeleton and planSkeleton', () => {
  it('translates a tagged key exactly and plans one new value per text node', () => {
    const compiled = compile(dictionary());
    const first = text('\n  Click ');
    const inner = text('here');
    const last = text(' to continue\n');
    const paragraph = el('p', {}, first, el('a', { href: '#' }, inner), last);
    const key = skeletonKey(asElement(paragraph)) ?? '';
    const value = translateSkeleton(compiled, key);

    expect(value).toBe('계속하려면 <0>여기</0>를 누르세요');
    expect(planSkeleton(asElement(paragraph), value ?? '', compiled)).toEqual([
      [first, '\n  계속하려면 '],
      [inner, '여기'],
      [last, '를 누르세요\n'],
    ]);
  });

  it('fills tagged patterns with captured values that stay inside one tag', () => {
    const compiled = compile(dictionary());

    expect(translateSkeleton(compiled, '<0>demo-data</0> is used by')).toBe('<0>demo-data</0>을(를) 쓰는 곳');
    expect(translateSkeleton(compiled, '<0>a</0> b <1>c</1> is used by')).toBeNull();
  });

  it('refuses a plan when tag order differs or text has no node to go into', () => {
    const compiled = compile(dictionary());
    const paragraph = el('p', {}, el('a', {}, text('here')), el('b', {}, text('now')));

    expect(planSkeleton(asElement(paragraph), '<1>지금</1><0>여기</0>', compiled)).toBeNull();
    expect(planSkeleton(asElement(paragraph), '<0>여기</0> 그리고 <1>지금</1>', compiled)).toBeNull();
  });

  it('refuses a plan that would change text inside a protected element', () => {
    const compiled = compile(dictionary());
    const paragraph = el('p', {}, text('Run '), el('code', {}, text('ls')), text(' now'));

    expect(planSkeleton(asElement(paragraph), '<0>dir</0> 실행', compiled)).toBeNull();
    expect(planSkeleton(asElement(paragraph), '지금 <0>ls</0> 실행', compiled)).not.toBeNull();
  });
});

describe('isDictionary and compareVersions', () => {
  it('accepts a well-formed dictionary and rejects broken shapes', () => {
    expect(isDictionary(dictionary())).toBe(true);
    expect(isDictionary({ ...dictionary(), schema: 2 })).toBe(false);
    expect(isDictionary({ ...dictionary(), exact: { Save: 1 } })).toBe(false);
    expect(isDictionary({ ...dictionary(), patterns: [{ source: 'Deploy :name', names: ['bad name'], value: 'x' }] })).toBe(false);
    expect(isDictionary({ ...dictionary(), version: 'latest' })).toBe(false);
    expect(isDictionary(null)).toBe(false);
  });

  it('compares dotted numeric versions segment by segment', () => {
    expect(compareVersions('4.4.6.10', '4.4.6.9')).toBeGreaterThan(0);
    expect(compareVersions('4.4.6', '4.4.6.0')).toBe(0);
    expect(compareVersions('4.4.5.99', '4.4.6.1')).toBeLessThan(0);
  });
});

describe('missed text collection', () => {
  it('keeps English UI-looking text and skips data, Hangul, and long blobs', () => {
    expect(isMissedCandidate('  Brand new button label ')).toBe(true);
    expect(isMissedCandidate('Untranslated')).toBe(true);
    expect(isMissedCandidate('저장')).toBe(false);
    expect(isMissedCandidate('https://example.com/a')).toBe(false);
    expect(isMissedCandidate('/data/coolify')).toBe(false);
    expect(isMissedCandidate('v4.4.6')).toBe(false);
    expect(isMissedCandidate('ok')).toBe(false);
    expect(isMissedCandidate('x'.repeat(201))).toBe(false);
  });

  it('merges new texts into the stored list without duplicates, oldest first, up to the limit', () => {
    expect(mergeMissed(['A one', 'B two'], ['B two', 'C three'], 10)).toEqual(['A one', 'B two', 'C three']);
    expect(mergeMissed(['A one', 'B two'], ['C three'], 2)).toEqual(['A one', 'B two']);
    expect(mergeMissed('broken', ['A one'], 2)).toEqual(['A one']);
    expect(mergeMissed([1, 'A one'], ['  A   one '], 5)).toEqual(['A one']);
  });
});
