import type { DraftStore } from '../i18n/drafts.ts';
import { sourceHash, translationIssues } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import type { Glossary, GlossaryTerm } from '../translate/glossary.ts';
import type { WeblateUnit } from './client.ts';

const EMPTY = 0;
const NEEDS_EDITING = 10;
const TRANSLATED = 20;
const APPROVED = 30;
const READ_ONLY = 100;

const byKey = (a: WeblateUnit, b: WeblateUnit): number => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Weblate에 올릴 기계 초안. 사람이 건드리지 않은 문자열에만 올린다:
 * 빈칸이거나, 수정 필요 상태인데 대상이 지난번 올린 초안 그대로인 것(그리고 초안이 바뀐 것).
 * 번역됨·승인·읽기 전용, 사람이 고친 수정 필요는 건드리지 않는다.
 */
export function planUploads(input: {
  readonly units: readonly WeblateUnit[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly uploaded: Readonly<Record<string, string>>;
  readonly exclusions: ReadonlyMap<string, string>;
}): { drafts: Record<string, string> } {
  const out: Record<string, string> = {};
  for (const unit of [...input.units].sort(byKey)) {
    const draft = input.drafts[unit.key];
    if (draft === undefined || input.exclusions.has(unit.key)) {
      continue;
    }
    const untouched = unit.state === EMPTY || (unit.state === NEEDS_EDITING && unit.target === input.uploaded[unit.key]);
    if (untouched && draft !== unit.target) {
      out[unit.key] = draft;
    }
  }

  return { drafts: out };
}

export interface ReviewedOutput {
  readonly reviewed: Record<string, string>;
  readonly pending: Record<string, string>;
  readonly meta: Record<string, { readonly sourceHash: string }>;
  /** 승인됐지만 레포 하드 검사에 걸려 뺀 번역(알림 대상) */
  readonly rejected: { readonly key: string; readonly issues: readonly string[] }[];
}

/**
 * Weblate 단위에서 레포로 돌아갈 번역을 고른다. 승인(30)은 reviewed, 번역됨(20)은 pending.
 * 원문이 지금 카탈로그 영어와 다르면(업스트림이 바꿈) 다시 검수할 때까지 뺀다. 카탈로그 밖·번역 제외 키도 뺀다.
 */
export function reviewedFromUnits(input: {
  readonly units: readonly WeblateUnit[];
  readonly catalog: CatalogLite;
  readonly exclusions: ReadonlyMap<string, string>;
  readonly verbatim: readonly string[];
  /** 지난번 레포의 검수 결과. 영어가 바뀌었는데 한국어가 그대로인 승인은 Weblate가 승인을 내리지 않았어도 뺀다 */
  readonly previous?: { readonly reviewed: Readonly<Record<string, string>>; readonly meta: Readonly<Record<string, { readonly sourceHash: string }>> };
}): ReviewedOutput {
  const out: ReviewedOutput = { reviewed: {}, pending: {}, meta: {}, rejected: [] };
  for (const unit of [...input.units].sort(byKey)) {
    const entry = input.catalog.keys[unit.key];
    if (entry === undefined || input.exclusions.has(unit.key) || unit.state === READ_ONLY || unit.source !== entry.english) {
      continue;
    }
    const issues = translationIssues(entry, unit.target, input.verbatim);
    if (unit.state >= APPROVED) {
      const before = input.previous?.meta[unit.key];
      if (before !== undefined && before.sourceHash !== sourceHash(entry.english) && input.previous?.reviewed[unit.key] === unit.target) {
        // 옛 영어에 대한 승인이다(검토 2026-10-18 Important 3). 사람이 새 영어로 다시 볼 때까지 뺀다
        continue;
      }
      if (issues.length > 0) {
        out.rejected.push({ key: unit.key, issues });
      } else {
        out.reviewed[unit.key] = unit.target;
        out.meta[unit.key] = { sourceHash: sourceHash(entry.english) };
      }
    } else if (unit.state === TRANSLATED && issues.length === 0) {
      out.pending[unit.key] = unit.target;
    }
  }

  return out;
}

/** 아직 Weblate 제안으로 보내지 않은 Flash 검토자의 고친 번역(지금 초안이 있는 키만). 보낸 뒤 고친 번역이 바뀌면 다시 보낸다 */
export function pendingSuggestions(store: DraftStore, sent: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(store.meta).sort()) {
    const fix = store.meta[key]?.review?.fix;
    if (fix !== undefined && key in store.drafts && sent[key] !== fix) {
      out[key] = fix;
    }
  }

  return out;
}

/**
 * Weblate에 올릴 원문. Weblate JSON 형식은 키 앞의 점 하나를 지운다(". Email is managed…" → " Email is managed…", 2026-10-17 PoC).
 * 그런 키는 올리지 않는다: 돌아온 키가 카탈로그와 맞지 않아 검수해도 쓸 수 없다. 이 키들은 초안(기계 번역)으로만 남는다
 */
export function weblateSource(en: Readonly<Record<string, string>>): { source: Record<string, string>; skipped: string[] } {
  const source: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(en)) {
    if (key.startsWith('.')) {
      skipped.push(key);
    } else {
      source[key] = value;
    }
  }

  return { source, skipped };
}

// codemod가 카탈로그에 다는 종류. 뜻이 코드로 분명한 것만 한국어로 풀고 원래 이름을 괄호에 둔다
const KIND_NAMES: Readonly<Record<string, string>> = {
  text: '화면 글',
  rich: '태그가 든 글',
  plural: '복수형',
  display: '표시용 라벨 값',
  existing: '업스트림이 이미 번역 함수로 감싼 글',
  'upstream-lang': '업스트림 lang 파일 글',
  'prop-text': '컴포넌트 속성 글',
  'prop-html': '컴포넌트 속성 글(HTML)',
  'prop-default': '컴포넌트 기본값',
  'prop-literal': '컴포넌트 속성 값',
  'html-attribute': 'HTML 속성 글',
  'echo-literal': '출력식 안의 글',
  'alpine-literal': 'Alpine 스크립트 안의 글',
  'script-literal': '스크립트 안의 글',
  toast: '알림(토스트)',
  'toast-html': '알림(토스트, HTML)',
  validation: '입력 검증 메시지',
};
const PLACES = 5;

/**
 * 번역자가 원문의 쓰임을 알 수 있게 Weblate 원문 단위 설명란(Markdown)에 넣을 글. AI 없이 카탈로그만으로 만든다:
 * 번역 제외 이유, 종류, 업스트림에서 쓰인 곳(그 버전 GitHub 줄 링크, 최대 5곳)
 */
export function explanationFor(input: {
  readonly entry: { readonly kinds: readonly string[]; readonly occurrences: readonly { readonly file: string; readonly line: number }[] };
  readonly exclusion?: string;
  readonly version: string;
}): string {
  const blocks: string[] = [];
  if (input.exclusion !== undefined) {
    blocks.push(`**번역 제외**: ${input.exclusion}`);
  }
  blocks.push(`**종류**: ${input.entry.kinds.map((kind) => (KIND_NAMES[kind] === undefined ? kind : `${KIND_NAMES[kind]}(${kind})`)).join(' · ')}`);
  const places = input.entry.occurrences;
  if (places.length > 0) {
    blocks.push(`**쓰인 곳**(Coolify ${input.version}):`);
    blocks.push(
      [
        ...places.slice(0, PLACES).map((place) => `- [${place.file}:${String(place.line)}](https://github.com/coollabsio/coolify/blob/v${input.version}/${place.file}#L${String(place.line)})`),
        ...(places.length > PLACES ? [`- 외 ${String(places.length - PLACES)}곳`] : []),
      ].join('\n'),
    );
  }

  return blocks.join('\n\n');
}

const isUntranslatable = (unit: WeblateUnit): boolean => unit.state === READ_ONLY || (unit.extraFlags ?? '').split(',').some((flag) => flag.trim() === 'read-only');
const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const TERM_LIMIT = 100;
/** 용어 한 줄로 쓸 만한 글: 비어 있지 않고, 짧고, 줄바꿈·제어 문자가 없다 */
const plainTerm = (text: string): boolean => text.trim() !== '' && text.length <= TERM_LIMIT && !/\p{Cc}/u.test(text);

/**
 * Weblate 용어집(ko 단위)을 레포 용어집 형식으로 바꾼다. 처음 넣은 뒤로는 Weblate가 편집 원본이다:
 * 승인된 한국어 변경·지운 용어·승인된 새 용어를 따르되, 레포에만 있는 forms·note와 기존 순서는 지킨다. 새 항목은 뒤에 영어 순으로 붙인다.
 * 읽기 전용(번역 안 함)은 브랜드다. 한국어가 빈 용어, 대소문자만 다른 두 번째 표기, 100자 넘거나 제어 문자가 든 글은 건너뛴다.
 * Weblate가 용어를 하나도 주지 않으면(잃었거나 아직 설정 전) 레포 용어집을 그대로 둔다.
 */
export function glossaryFromUnits(current: Glossary, units: readonly WeblateUnit[]): Glossary {
  if (units.length === 0) {
    return current;
  }
  const terms = new Map<string, string>();
  const brands = new Set<string>();
  const seen = new Set<string>();
  const repoKo = new Map(current.terms.map((term) => [term.en, term.ko]));
  // 단위 id는 만든 순서다. 같은 낱말의 두 표기는 먼저 만든 쪽을 쓴다
  for (const unit of [...units].sort((a, b) => a.id - b.id)) {
    const lower = unit.source.toLowerCase();
    if (!plainTerm(unit.source) || seen.has(lower)) {
      continue;
    }
    if (isUntranslatable(unit)) {
      // 읽기 전용 플래그는 관리 권한이 있어야 건다(기여자는 못 건다)
      brands.add(unit.source);
      seen.add(lower);
    } else {
      // 용어집은 초안 엔진 프롬프트에 들어간다. 승인된 정상 값만 받고, 그 밖(승인 전 편집·비움·이상한 글)은 레포 값을 둔다.
      // 승인 전 새 용어는 받지 않는다. 승인 전 편집으로 용어가 지워지지도 않는다
      const ko = unit.state >= APPROVED && plainTerm(unit.target) ? unit.target : repoKo.get(unit.source);
      if (ko !== undefined) {
        terms.set(unit.source, ko);
        seen.add(lower);
      }
    }
  }
  const outTerms: GlossaryTerm[] = [];
  for (const term of current.terms) {
    const ko = terms.get(term.en);
    if (ko !== undefined) {
      outTerms.push({ ...term, ko });
      terms.delete(term.en);
    }
  }
  outTerms.push(...[...terms].sort(([a], [b]) => byText(a, b)).map(([en, ko]) => ({ en, ko })));
  const outBrands = current.brands.filter((brand) => brands.delete(brand));

  return { terms: outTerms, brands: [...outBrands, ...[...brands].sort(byText)] };
}

/**
 * 올린 초안 기록을 Weblate에서 되찾는다: 수정 필요(10)이고 대상이 지금 초안과 똑같은데 기록에 없거나 다르면, 우리가 올린 것으로 본다.
 * 업로드는 됐는데 기록 쓰기가 실패한 단위가 "사람이 고친 것"으로 굳어 다음 초안이 영영 안 올라가는 일을 막는다(검토 Minor)
 */
export function adoptUploaded(input: {
  readonly units: readonly WeblateUnit[];
  readonly drafts: Readonly<Record<string, string>>;
  readonly uploaded: Readonly<Record<string, string>>;
}): { uploaded: Record<string, string>; adopted: string[] } {
  const uploaded = { ...input.uploaded };
  const adopted: string[] = [];
  for (const unit of [...input.units].sort(byKey)) {
    if (unit.state === NEEDS_EDITING && unit.target !== '' && unit.target === input.drafts[unit.key] && uploaded[unit.key] !== unit.target) {
      uploaded[unit.key] = unit.target;
      adopted.push(unit.key);
    }
  }

  return { uploaded, adopted };
}
