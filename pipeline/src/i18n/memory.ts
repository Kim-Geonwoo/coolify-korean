import { mask, placeholderNames } from '../translate/masking.ts';

export interface CatalogLite {
  readonly version: string;
  readonly keys: Readonly<Record<string, { readonly english: string; readonly kinds: readonly string[]; readonly placeholders: readonly string[] }>>;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 두 카탈로그의 차이. 키가 영어 문장이라 영어가 바뀌면 보통 새 키다. 같은 키에서 영어가 바뀌는 것은 업스트림 점 키다 */
export function diffCatalogs(previous: CatalogLite, next: CatalogLite): { added: string[]; removed: string[]; changed: string[] } {
  const before = Object.keys(previous.keys);
  const after = Object.keys(next.keys);

  return {
    added: after.filter((key) => !(key in previous.keys)).sort(byCodeUnit),
    removed: before.filter((key) => !(key in next.keys)).sort(byCodeUnit),
    changed: after.filter((key) => key in previous.keys && previous.keys[key]?.english !== next.keys[key]?.english).sort(byCodeUnit),
  };
}

/**
 * mt: 기계 번역, tm-exact: 같은 영어의 초안 재사용, tm-rename: 자리표시자 이름만 다른 초안을 이름만 바꿔 옮김,
 * tm-near: 대소문자·끝 문장부호만 다른 초안(수정 필요), shared: 같은 영어의 다른 새 키와 한 번만 번역
 */
export type PlanKind = 'mt' | 'tm-exact' | 'tm-rename' | 'tm-near' | 'shared';

export interface PlanEntry {
  readonly key: string;
  readonly kind: PlanKind;
  /** 번역을 가져온 키 */
  readonly from?: string;
  readonly text?: string;
}

export interface PlanInput {
  readonly catalog: CatalogLite;
  /** 지금 초안(키 → 번역) */
  readonly drafts: Readonly<Record<string, string>>;
  readonly exclusions: ReadonlyMap<string, string>;
  /** 초안이 필요한 키(새 키, 영어가 바뀐 점 키). 이 키들의 지금 초안은 메모리로 쓰지 않는다 */
  readonly keys: readonly string[];
}

interface Shape {
  readonly shape: string;
  readonly tokens: readonly string[];
}

/** 자리표시자를 자리 표시로 바꾼 꼴과 그 순서. 리터럴 중괄호처럼 가릴 수 없으면 undefined */
function shapeOf(english: string, listed: readonly string[]): Shape | undefined {
  try {
    const masked = mask(english, placeholderNames(english, listed));
    if (masked.literals.length > 0) {
      return undefined;
    }

    return { shape: masked.text.replace(/\{\{[^{}]*\}\}/g, '{#}'), tokens: masked.tokens };
  } catch {
    return undefined;
  }
}

function near(english: string): string {
  return english.toLowerCase().replace(/[.!?:…]+$/, '').replace(/\s+/g, ' ').trim();
}

/** 옛 초안의 자리표시자를 위치별로 새 이름으로 바꾼다. 같은 옛 이름이 다른 새 이름으로 갈라지면 포기한다 */
function renamed(translation: string, from: Shape, fromNames: readonly string[], to: Shape): string | undefined {
  const map = new Map<string, string>();
  for (const [index, token] of from.tokens.entries()) {
    const target = to.tokens[index];
    if (target === undefined || (map.has(token) && map.get(token) !== target)) {
      return undefined;
    }
    map.set(token, target);
  }
  try {
    const masked = mask(translation, fromNames);

    return masked.text.replace(/\{\{[^{}]*\}\}/g, (token) => `:${(map.get(token) ?? token).slice(2, -2)}`);
  } catch {
    return undefined;
  }
}

export function planDrafts(input: PlanInput): PlanEntry[] {
  const { catalog, drafts } = input;
  const englishOf = (key: string): string => catalog.keys[key]?.english ?? key;
  const listedOf = (key: string): readonly string[] => catalog.keys[key]?.placeholders ?? [];
  const exact = new Map<string, string>();
  const shapes = new Map<string, string>();
  const nears = new Map<string, string>();
  // 다시 번역할 키(영어가 바뀐 점 키 포함)의 초안은 낡았으므로 메모리로 쓰지 않는다
  const requested = new Set(input.keys);
  for (const key of Object.keys(drafts).filter((k) => !requested.has(k)).sort(byCodeUnit)) {
    const english = englishOf(key);
    if (!exact.has(english)) {
      exact.set(english, key);
    }
    const shape = shapeOf(english, listedOf(key));
    if (shape !== undefined && shape.tokens.length > 0 && !shapes.has(shape.shape)) {
      shapes.set(shape.shape, key);
    }
    if (!nears.has(near(english))) {
      nears.set(near(english), key);
    }
  }
  const plan: PlanEntry[] = [];
  const planned = new Map<string, string>();
  for (const key of [...input.keys].sort(byCodeUnit)) {
    if (input.exclusions.has(key)) {
      continue;
    }
    const english = englishOf(key);
    const exactFrom = exact.get(english);
    if (exactFrom !== undefined) {
      plan.push({ key, kind: 'tm-exact', from: exactFrom, text: drafts[exactFrom] ?? '' });
      continue;
    }
    const shape = shapeOf(english, listedOf(key));
    const shapeFrom = shape === undefined || shape.tokens.length === 0 ? undefined : shapes.get(shape.shape);
    if (shape !== undefined && shapeFrom !== undefined) {
      const fromShape = shapeOf(englishOf(shapeFrom), listedOf(shapeFrom));
      const text = fromShape === undefined ? undefined : renamed(drafts[shapeFrom] ?? '', fromShape, placeholderNames(englishOf(shapeFrom), listedOf(shapeFrom)), shape);
      if (text !== undefined) {
        plan.push({ key, kind: 'tm-rename', from: shapeFrom, text });
        continue;
      }
    }
    const nearFrom = nears.get(near(english));
    if (nearFrom !== undefined) {
      plan.push({ key, kind: 'tm-near', from: nearFrom, text: drafts[nearFrom] ?? '' });
      continue;
    }
    const sharedFrom = planned.get(english);
    if (sharedFrom !== undefined) {
      plan.push({ key, kind: 'shared', from: sharedFrom });
      continue;
    }
    planned.set(english, key);
    plan.push({ key, kind: 'mt' });
  }

  return plan;
}
