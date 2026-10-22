import { createHash } from 'node:crypto';
import { termsIn, type Glossary } from './glossary.ts';
import { placeholderNames, scanPlaceholders } from './masking.ts';

/** i18n/catalog.json의 키 항목 */
export interface CatalogEntry {
  readonly english: string;
  readonly markup: boolean;
  readonly kinds: readonly string[];
  readonly placeholders: readonly string[];
  readonly occurrences: readonly { readonly file: string; readonly line: number; readonly kind: string }[];
}

export type Stratum = 'representative' | 'label' | 'placeholder' | 'tag' | 'long' | 'edge' | 'directive';

export interface SampleOptions {
  /** 이미 다른 표본에 쓴 키(같은 표본으로 재면 효과가 부풀려진다) */
  readonly exclude?: ReadonlySet<string>;
  /** 층과 개수. 없으면 2a의 100개 구성 */
  readonly strata?: readonly (readonly [Stratum, number])[];
}

/** 동사로 시작하는 설정·도움말 문구. 설정이 하는 일을 설명하는지, 사용자에게 시키는지 갈리는 곳이다 */
const DIRECTIVE = /^(?:Notify|Notifies|Use|Uses|Drop|Drops|Keep|Keeps|Set|Sets|Show|Shows|Enable|Enables|Disable|Disables|Allow|Allows|Run|Runs|Send|Sends|Remove|Removes|Delete|Deletes|Restart|Restarts|Add|Adds|Create|Creates|Skip|Skips|Store|Stores|Limit|Limits|Force|Forces|Ignore|Ignores|Automatically)\b/;

export interface SampleItem {
  readonly id: string;
  readonly key: string;
  /** 번역할 영어. 업스트림 점 키는 키가 아니라 영어 값이다 */
  readonly source: string;
  readonly kind: string;
  /** 키가 쓰인 곳의 kind 전부. 하나라도 메시지면 문장 규칙을 쓴다 */
  readonly kinds?: readonly string[];
  readonly file: string;
  readonly placeholders: readonly string[];
  readonly markup: boolean;
  readonly stratum: Stratum;
}

interface Candidate {
  readonly key: string;
  readonly entry: CatalogEntry;
  readonly words: number;
  /** 키의 sha256으로 정한 [0, 1) 값. 다시 뽑아도 같은 순서가 나온다 */
  readonly u: number;
}

const STRATA: readonly [Stratum, number][] = [['tag', 15], ['placeholder', 20], ['label', 15], ['long', 5], ['edge', 5], ['representative', 40]];

function words(text: string): number {
  return text.replace(/<\/?\d+\/?>/g, ' ').split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

function uniform(key: string): number {
  return Number.parseInt(createHash('sha256').update(key).digest('hex').slice(0, 13), 16) / 16 ** 13;
}

/**
 * 층화 표본 100개. 대표 층 40은 단어 수에 비례해 뽑고(A-ES 가중 추출), 나머지는 해시 순서로 뽑는다.
 * 원문에 {{·}}가 든 키(가리기와 충돌)는 뺀다.
 */
export function drawSample(catalog: Readonly<Record<string, CatalogEntry>>, glossary: Glossary, options: SampleOptions = {}): SampleItem[] {
  const candidates: Candidate[] = Object.entries(catalog)
    .filter(([key, entry]) => options.exclude?.has(key) !== true && !entry.english.includes('{{') && !entry.english.includes('}}') && entry.english.trim() !== '')
    .map(([key, entry]) => ({ key, entry, words: words(entry.english), u: uniform(key) }))
    .sort((a, b) => a.u - b.u);
  const taken = new Set<string>();
  const out: SampleItem[] = [];
  const brandWords = new Set(glossary.brands.map((b) => b.toLowerCase()));
  const upstream = (c: Candidate): boolean => c.entry.kinds.includes('upstream-lang');
  const names = (c: Candidate): string[] => placeholderNames(c.entry.english, c.entry.placeholders);

  const pick = (stratum: Stratum, count: number, pool: Candidate[]): void => {
    for (const c of pool) {
      if (out.filter((i) => i.stratum === stratum).length >= count) {
        return;
      }
      if (taken.has(c.key)) {
        continue;
      }
      taken.add(c.key);
      const first = c.entry.occurrences[0];
      out.push({
        id: createHash('sha256').update(c.key).digest('hex').slice(0, 8),
        key: c.key,
        source: c.entry.english,
        kind: first?.kind ?? c.entry.kinds[0] ?? 'text',
        file: first?.file ?? 'lang/en.json',
        placeholders: names(c),
        markup: c.entry.markup,
        stratum,
      });
    }
  };

  for (const [stratum, count] of options.strata ?? STRATA) {
    switch (stratum) {
      case 'directive':
        pick(
          'directive',
          count,
          candidates.filter((c) => c.entry.kinds.some((k) => k === 'prop-html' || k === 'prop-text') && c.words >= 5 && !c.entry.markup && names(c).length === 0 && !upstream(c) && DIRECTIVE.test(c.entry.english)),
        );
        break;
      case 'edge': {
        const special = candidates.filter((c) => c.key === 'auth.throttle');
        const technical = candidates.filter((c) => /https?:\/\/|\d|\b[A-Z]{2,}\b/.test(c.entry.english) || [...brandWords].some((b) => c.entry.english.toLowerCase().includes(b)));
        pick('edge', count, [...special, ...technical]);
        break;
      }
      case 'tag':
        pick('tag', count, candidates.filter((c) => c.entry.markup && /<\d+\/?>/.test(c.entry.english) && !upstream(c)));
        break;
      case 'placeholder': {
        const pool = candidates.filter((c) => names(c).length > 0 && !c.entry.markup && !upstream(c));
        const varied = pool.filter((c) => scanPlaceholders(c.entry.english, names(c)).length >= 2 || /:[A-Z]/.test(c.entry.english));
        pick('placeholder', count, [...varied.slice(0, Math.min(8, varied.length)), ...pool]);
        break;
      }
      case 'label':
        pick('label', count, candidates.filter((c) => c.words <= 3 && !c.entry.markup && names(c).length === 0 && !upstream(c) && termsIn(c.entry.english, glossary).length > 0));
        break;
      case 'long':
        pick('long', count, candidates.filter((c) => c.words >= 15 && !c.entry.markup && names(c).length === 0 && !upstream(c)));
        break;
      case 'representative': {
        const pool = candidates
          .filter((c) => c.words >= 4 && c.words <= 20 && !c.entry.markup && !upstream(c))
          .map((c) => ({ c, priority: c.u ** (1 / c.words) }))
          .sort((a, b) => b.priority - a.priority)
          .map((x) => x.c);
        pick('representative', count, pool);
        break;
      }
    }
  }

  return out;
}
