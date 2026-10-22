import {
  compareVersions,
  compile,
  INLINE_TAGS,
  isDictionary,
  isMissedCandidate,
  isProtected,
  mergeMissed,
  planSkeleton,
  skeletonKey,
  translateSkeleton,
  translateText,
  type Compiled,
  type ExtensionDictionary,
} from './engine.ts';

/**
 * content script: 사용자가 켠 Coolify 주소에서만 화면 글자를 제자리에서 바꾼다.
 * Livewire morph가 글을 영어로 되돌리면 관찰자가 다시 바꾼다. 요소는 만들거나 옮기지 않고 nodeValue·속성만 바꾼다.
 */
const api = typeof browser === 'undefined' ? chrome : browser;
const ATTRIBUTES = ['title', 'placeholder', 'aria-label', 'alt'];
const BUTTON_TYPES = ['submit', 'button', 'reset'];
const MISSED_LIMIT = 2000;
const MISSED_FLUSH_MS = 5000;

interface Applied {
  readonly original: string;
  readonly applied: string;
}

/** 묶음 사전과 (background가 검증해 둔) 원격 사전 중 같은 언어의 새 것 */
function pickDictionary(stored: Record<string, unknown>): ExtensionDictionary | null {
  const bundled = isDictionary(stored['bundled']) ? stored['bundled'] : null;
  const remote = isDictionary(stored['remote']) ? stored['remote'] : null;
  if (remote !== null && bundled !== null && remote.code === bundled.code && compareVersions(remote.version, bundled.version) > 0) {
    return remote;
  }

  return bundled ?? remote;
}

function startTranslating(compiled: Compiled): void {
  const texts = new WeakMap<Text, Applied>();
  const attributes = new WeakMap<Element, Map<string, Applied>>();
  const missed = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  // 이미 바꾼 글이면 원문(영어)을, 아니면 지금 글을 읽는다(골격 키를 다시 만들 때)
  const textOf = (node: Text): string => {
    const record = texts.get(node);
    const now = node.nodeValue ?? '';

    return record !== undefined && record.applied === now ? record.original : now;
  };

  const setText = (node: Text, next: string): void => {
    const original = textOf(node);
    if (node.nodeValue !== next) {
      node.nodeValue = next;
    }
    texts.set(node, { original, applied: next });
  };

  const flush = (): void => {
    flushTimer = undefined;
    const batch = [...missed];
    missed.clear();
    api.storage.local
      .get(['missed'])
      .then((stored) => api.storage.local.set({ missed: mergeMissed(stored['missed'], batch, MISSED_LIMIT) }))
      .catch(() => undefined);
  };

  const noteMissed = (text: string): void => {
    if (isMissedCandidate(text)) {
      missed.add(text);
      flushTimer ??= setTimeout(flush, MISSED_FLUSH_MS);
    }
  };

  const translateTextNode = (node: Text): void => {
    const parent = node.parentElement;
    const now = node.nodeValue ?? '';
    const record = texts.get(node);
    if (parent === null || (record !== undefined && record.applied === now) || isProtected(parent, compiled)) {
      return;
    }
    const out = translateText(compiled, now);
    if (out === null) {
      texts.delete(node);
      noteMissed(now);
      return;
    }
    setText(node, out);
  };

  const translateAttributes = (el: Element): void => {
    // textarea·input 자신은 보호 태그지만 placeholder 같은 속성은 화면 문구다
    const owner = el.localName === 'textarea' || el.localName === 'input' ? el.parentElement : el;
    if (owner !== null && isProtected(owner, compiled)) {
      return;
    }
    // input의 value는 이름 없는 submit·button만(이름이 있으면 제출 값이다)
    const button = el.localName === 'input' && BUTTON_TYPES.includes((el.getAttribute('type') ?? '').toLowerCase()) && !el.hasAttribute('name');
    for (const name of button ? [...ATTRIBUTES, 'value'] : ATTRIBUTES) {
      const now = el.getAttribute(name);
      const known = attributes.get(el);
      if (now === null || now.trim() === '' || known?.get(name)?.applied === now) {
        continue;
      }
      const out = translateText(compiled, now);
      if (out === null || out === now) {
        continue;
      }
      el.setAttribute(name, out);
      const map = known ?? new Map<string, Applied>();
      map.set(name, { original: now, applied: out });
      attributes.set(el, map);
    }
  };

  // 골격 시도 전 빠른 거르기: 요소 자식이 있고, 모두 인라인이거나 글이 없다
  const eligible = (el: Element): boolean => {
    let hasElement = false;
    for (const child of Array.from(el.children)) {
      hasElement = true;
      if (!INLINE_TAGS.has(child.localName) && child.textContent.trim() !== '') {
        return false;
      }
    }

    return hasElement;
  };

  const trySkeleton = (el: Element): boolean => {
    const key = skeletonKey(el, textOf);
    const value = key === null ? null : translateSkeleton(compiled, key);
    const plan = value === null ? null : planSkeleton(el, value, compiled, textOf);
    if (plan === null) {
      return false;
    }
    for (const [node, next] of plan) {
      setText(node, next);
    }

    return true;
  };

  const walk = (root: Node): void => {
    const stack: Node[] = [root];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.nodeType === Node.TEXT_NODE) {
        translateTextNode(node as Text);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }
      const el = node as Element;
      if (isProtected(el, compiled)) {
        continue;
      }
      translateAttributes(el);
      if (eligible(el) && trySkeleton(el)) {
        // 글은 골격으로 끝났다. 자손 요소의 속성만 본다
        for (const inner of Array.from(el.querySelectorAll('*'))) {
          translateAttributes(inner);
        }
        continue;
      }
      const children = el.childNodes;
      for (let index = children.length - 1; index >= 0; index--) {
        const child = children[index];
        if (child !== undefined) {
          stack.push(child);
        }
      }
    }
  };

  // 바뀐 글이 인라인 요소 안이면 문장 전체(골격)를 다시 볼 수 있게 인라인이 아닌 조상까지 올라간다
  const containerOf = (node: Node): Node => {
    let current: Element | null = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    if (current === null) {
      return node;
    }
    for (let depth = 0; depth < 4 && current.parentElement !== null && INLINE_TAGS.has(current.localName); depth++) {
      current = current.parentElement;
    }

    return current;
  };

  const observer = new MutationObserver((records) => {
    const roots = new Set<Node>();
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target.nodeType === Node.ELEMENT_NODE) {
          translateAttributes(record.target as Element);
        }
      } else if (record.type === 'characterData') {
        roots.add(containerOf(record.target));
      } else {
        for (const added of Array.from(record.addedNodes)) {
          roots.add(containerOf(added));
        }
      }
    }
    for (const root of roots) {
      if (root.isConnected) {
        walk(root);
      }
    }
    // 이 콜백에서 바꾼 것이 만든 기록은 버린다(자기 변경 무시)
    observer.takeRecords();
  });

  walk(document.documentElement);
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...ATTRIBUTES, 'value'],
  });
}

async function main(): Promise<void> {
  const stored = await api.storage.local.get(['origins', 'bundled', 'remote']);
  const origins = Array.isArray(stored['origins']) ? (stored['origins'] as unknown[]) : [];
  // Firefox는 패턴에 포트가 없어 같은 호스트의 다른 포트에도 주입된다. 저장된 origin(포트 포함)과 다시 대조한다
  if (!origins.includes(location.origin)) {
    return;
  }
  let dictionary = pickDictionary(stored);
  if (dictionary === null) {
    const answer = await api.runtime.sendMessage({ type: 'dictionary' });
    dictionary = isDictionary(answer) ? answer : null;
  }
  if (dictionary !== null) {
    startTranslating(compile(dictionary));
  }
}

main().catch(() => undefined);
