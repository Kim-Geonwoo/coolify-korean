import type { Page } from 'playwright';
import type { Mark } from './tiles.ts';

/**
 * 보이는 글 노드·속성·입력값의 키 번호를 모으고, 화면 전체에서 표식을 지운다(찍기 전).
 * 표식을 지운 뒤(글 길이가 바뀌어 배치가 달라진다) 각 키가 보이는 자리와 문서 높이를 잰다.
 * within(CSS 선택자)을 주면 그중 보이는 마지막 요소 안의 키만 모은다(연 창). 보이는 것이 없으면 키 0개
 */
export async function collectAndStrip(page: Page, within?: string): Promise<{ marks: Mark[]; height: number; plain: string[] }> {
  return page.evaluate((selector) => {
    const root = selector === null ? null : (Array.from(document.querySelectorAll(selector)).filter((element) => element.checkVisibility()).pop() ?? undefined);
    const id = /([0-9a-z]+)/g;
    const any = /[0-9a-z]+|/g;
    const marked = /[]/;
    const found: [string, Node][] = [];
    // 표식 없이 보이는 글: 오버레이가 감싸지 못한 화면 글 후보(데이터인지는 Node 쪽이 거른다)
    const plain = new Set<string>();
    const inRoot = (where: Node): boolean => root !== undefined && (root === null || root.contains(where));
    const take = (text: string, visible: boolean, where: Node | null = null): string => {
      if (visible && where !== null && inRoot(where)) {
        for (const match of text.matchAll(id)) {
          found.push([match[1] ?? '', where]);
        }
      }

      return text.replace(any, '');
    };
    const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    // 묶음 문장(__h)은 여는 표식과 닫는 표식이 다른 글 노드에 있다. 그 사이 글은 번역된 문장의 일부라 미번역으로 세지 않는다
    const open = String.fromCodePoint(0xe000);
    const close = String.fromCodePoint(0xe002);
    let depth = 0;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = node.nodeValue ?? '';
      const covered = depth > 0;
      for (const char of text) {
        depth = char === open ? depth + 1 : char === close ? Math.max(0, depth - 1) : depth;
      }
      if (!marked.test(text)) {
        const parent = node.parentElement;
        if (!covered && text.trim() !== '' && parent !== null && !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(parent.tagName) && parent.checkVisibility() && inRoot(node)) {
          plain.add(text.replace(/\s+/g, ' ').trim().slice(0, 300));
        }
      } else {
        const parent = node.parentElement;
        node.nodeValue = take(text, parent !== null && !['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT'].includes(parent.tagName) && parent.checkVisibility(), node);
      }
    }
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
      const visible = element.checkVisibility();
      for (const name of ['placeholder', 'title', 'aria-label', 'alt', 'value']) {
        const value = element.getAttribute(name);
        if (value !== null && marked.test(value)) {
          element.setAttribute(name, take(value, visible, element));
        } else if (value !== null && value.trim() !== '' && name !== 'value' && visible && inRoot(element)) {
          plain.add(value.replace(/\s+/g, ' ').trim().slice(0, 300));
        }
      }
      if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && marked.test(element.value)) {
        element.value = take(element.value, visible, element);
      }
    }
    document.title = take(document.title, false);

    const range = document.createRange();
    const box = (where: Node): DOMRect => {
      if (where instanceof Element) {
        return where.getBoundingClientRect();
      }
      range.selectNodeContents(where);

      return range.getBoundingClientRect();
    };
    const marks = found.map(([key, where]) => {
      const rect = box(where);

      return { id: key, top: rect.top + window.scrollY, bottom: rect.bottom + window.scrollY };
    });

    return { marks, height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight), plain: [...plain] };
  }, within ?? null);
}

/** 쪽에서 창(Coolify modal-confirmation·modal-input)을 여는 단추. 순번은 같은 쪽을 다시 열었을 때 같은 단추를 고르는 데 쓴다 */
export const MODAL_TRIGGER = '[\\@click]';
// 창 내용은 x-teleport로 body 바로 아래에 붙는다
export const MODAL_ROOT = 'body > [x-show="modalOpen"]';

/** 보이는 창 단추와 그 이름(표식을 뺀 글, 공백 정리, 60자) */
export async function modalTriggers(page: Page): Promise<{ index: number; label: string }[]> {
  return page.evaluate((selector) => {
    const marker = new RegExp(`${String.fromCodePoint(0xe000)}[0-9a-z]+${String.fromCodePoint(0xe001)}|${String.fromCodePoint(0xe002)}`, 'g');
    const opens = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => /modalOpen\s*=\s*true/.test(element.getAttribute('@click') ?? ''));

    return opens.flatMap((element, index) => {
      const label = element.textContent.replace(marker, '').replace(/\s+/g, ' ').trim().slice(0, 60);

      return element.checkVisibility() && label !== '' ? [{ index, label }] : [];
    });
  }, MODAL_TRIGGER);
}

/** modalTriggers의 순번으로 단추를 누른다. 없으면 false */
export async function openModal(page: Page, index: number): Promise<boolean> {
  return page.evaluate(
    ([selector, at]) => {
      const opens = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => /modalOpen\s*=\s*true/.test(element.getAttribute('@click') ?? ''));
      const target = opens[at];
      target?.click();

      return target !== undefined;
    },
    [MODAL_TRIGGER, index] as const,
  );
}
