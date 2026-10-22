import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { hardIssues } from '../translate/validate.ts';
import { canonicalJson, sourceHash } from './integrity.ts';
import { langPaths } from './languages.ts';
import { diffCatalogs, type CatalogLite, type PlanEntry, type PlanKind } from './memory.ts';
import { verbatimMissing } from './verbatim.ts';

export interface DraftEdit {
  readonly rule: string;
  readonly before: string;
  readonly after: string;
}

/** Flash 검토자 판정(2b). 검토 게이트를 통과했을 때만 major에 needsReview를 단다 */
export interface DraftReview {
  readonly verdict: 'ok' | 'minor' | 'major';
  readonly reason: string;
  /** 하드 검사를 통과한 고친 번역(제안) */
  readonly fix?: string;
  readonly run: string;
  readonly needsReview?: true;
}

export interface DraftMeta {
  readonly run: string;
  readonly sourceHash: string;
  readonly via: PlanKind;
  readonly from?: string;
  readonly edits?: readonly DraftEdit[];
  readonly warnings?: readonly string[];
  readonly removedIn?: string;
  readonly review?: DraftReview;
}

export interface RunInfo {
  readonly engine: string;
  readonly prompt: string;
  readonly glossary: string;
  readonly [detail: string]: unknown;
}

export interface DraftStore {
  readonly drafts: Readonly<Record<string, string>>;
  readonly meta: Readonly<Record<string, DraftMeta>>;
  readonly runs: Readonly<Record<string, RunInfo>>;
}

export interface DraftResult {
  readonly text: string;
  readonly run: string;
  readonly via: PlanKind;
  readonly from?: string;
  readonly edits?: readonly DraftEdit[];
  readonly warnings?: readonly string[];
}

export interface Translated {
  readonly text: string;
  readonly run: string;
  readonly edits?: readonly DraftEdit[];
  readonly warnings?: readonly string[];
}

export interface Increment {
  readonly version: string;
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly drafted: number;
}

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function details(source: Translated): Pick<DraftResult, 'edits' | 'warnings'> {
  return { ...(source.edits === undefined ? {} : { edits: source.edits }), ...(source.warnings === undefined ? {} : { warnings: source.warnings }) };
}

/** 번역 계획과 엔진 결과를 키별 결과로 합친다. 엔진이 못 낸 키(와 그 키를 나눠 받을 키)는 빠진다 */
export function resultsFromPlan(plan: readonly PlanEntry[], translated: ReadonlyMap<string, Translated>, memoryRun: string): Map<string, DraftResult> {
  const out = new Map<string, DraftResult>();
  for (const entry of plan) {
    if (entry.kind === 'mt') {
      const found = translated.get(entry.key);
      if (found !== undefined) {
        out.set(entry.key, { text: found.text, run: found.run, via: 'mt', ...details(found) });
      }
    } else if (entry.kind === 'shared') {
      const found = entry.from === undefined ? undefined : translated.get(entry.from);
      if (found !== undefined && entry.from !== undefined) {
        out.set(entry.key, { text: found.text, run: found.run, via: 'shared', from: entry.from, ...details(found) });
      }
    } else if (entry.text !== undefined && entry.from !== undefined) {
      out.set(entry.key, { text: entry.text, run: memoryRun, via: entry.kind, from: entry.from });
    }
  }

  return out;
}

export interface ApplyInput {
  readonly store: DraftStore;
  readonly previous: CatalogLite;
  readonly next: CatalogLite;
  readonly results: ReadonlyMap<string, DraftResult>;
  readonly runs: Readonly<Record<string, RunInfo>>;
  /** 처리한 버전들(오래된 것부터, 이번 버전 포함) */
  readonly history: readonly string[];
  /** 없어진 키를 몇 개 버전 동안 남길지 */
  readonly keepVersions: number;
  readonly exclusions: ReadonlyMap<string, string>;
  /** 이미 값이 있어도 바꿀 키(더 강한 엔진의 결과를 들여올 때만) */
  readonly replace?: ReadonlySet<string>;
  /** 사용자가 글자 그대로 쳐야 하는 확인 문구(i18n/verbatim.json) */
  readonly verbatim?: readonly string[];
}

export interface ApplyOutput {
  readonly store: DraftStore;
  readonly rejected: readonly { readonly key: string; readonly issues: readonly string[] }[];
  readonly increment: Increment;
}

/** 봇은 새 키와 영어가 바뀐 키만 쓴다. 이미 있는 값은 바꾸지 않는다(사람 수정은 overrides에서) */
export function applyDrafts(input: ApplyInput): ApplyOutput {
  const { next } = input;
  const diff = diffCatalogs(input.previous, next);
  const changed = new Set(diff.changed);
  const drafts = new Map(Object.entries(input.store.drafts));
  const meta = new Map(Object.entries(input.store.meta));
  const rejected: { key: string; issues: string[] }[] = [];
  const at = (version: string): number => input.history.indexOf(version);
  const now = at(next.version);

  for (const key of [...drafts.keys()]) {
    const info = meta.get(key);
    const entry = next.keys[key];
    if (entry === undefined) {
      if (info?.removedIn === undefined) {
        meta.set(key, { ...(info ?? { run: '', sourceHash: '', via: 'mt' }), removedIn: next.version });
      } else if (now >= 0 && at(info.removedIn) >= 0 && now - at(info.removedIn) >= input.keepVersions) {
        drafts.delete(key);
        meta.delete(key);
      }
    } else if (info === undefined || info.sourceHash !== sourceHash(entry.english)) {
      drafts.delete(key);
      meta.delete(key);
    }
  }

  let drafted = 0;
  for (const key of [...input.results.keys()].sort(byCodeUnit)) {
    const result = input.results.get(key);
    const entry = next.keys[key];
    if (result === undefined) {
      continue;
    }
    if (entry === undefined) {
      rejected.push({ key, issues: ['unknown-key'] });
      continue;
    }
    if (input.exclusions.has(key)) {
      rejected.push({ key, issues: ['excluded'] });
      continue;
    }
    if (drafts.has(key) && !changed.has(key) && input.replace?.has(key) !== true) {
      continue;
    }
    const issues: string[] = hardIssues({ source: entry.english, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, placeholders: entry.placeholders }, result.text);
    if (verbatimMissing(entry.english, result.text, input.verbatim ?? []).length > 0) {
      issues.push('verbatim');
    }
    if (issues.length > 0) {
      rejected.push({ key, issues });
      continue;
    }
    drafts.set(key, result.text);
    meta.set(key, {
      run: result.run,
      sourceHash: sourceHash(entry.english),
      via: result.via,
      ...(result.from === undefined ? {} : { from: result.from }),
      ...(result.edits === undefined || result.edits.length === 0 ? {} : { edits: result.edits }),
      ...(result.warnings === undefined || result.warnings.length === 0 ? {} : { warnings: result.warnings }),
    });
    drafted++;
  }

  const known: Record<string, RunInfo> = { ...input.store.runs, ...input.runs };
  const used = new Set([...meta.values()].map((info) => info.run));
  const runs = Object.fromEntries(Object.entries(known).filter(([id]) => used.has(id)));

  return {
    store: { drafts: Object.fromEntries(drafts), meta: Object.fromEntries(meta), runs },
    rejected,
    increment: { version: next.version, added: diff.added, changed: diff.changed, removed: diff.removed, drafted },
  };
}

/** 아직 초안이 없거나 영어가 바뀐 뒤 그대로인 키(번역 제외 키는 뺀다) */
export function pendingKeys(catalog: CatalogLite, store: DraftStore, exclusions: ReadonlyMap<string, string>): string[] {
  return Object.keys(catalog.keys)
    .filter((key) => !exclusions.has(key))
    .filter((key) => {
      const entry = catalog.keys[key];
      const info = store.meta[key];

      return !(key in store.drafts) || entry === undefined || info === undefined || info.sourceHash !== sourceHash(entry.english);
    })
    .sort(byCodeUnit);
}

const RUNS = 'runs.json';

/** 언어별 초안 파일 이름(i18n/languages.json의 code) */
const files = (code: string): { readonly drafts: string; readonly meta: string } => ({ drafts: posix.basename(langPaths(code).drafts), meta: posix.basename(langPaths(code).draftsMeta) });

function readJson(path: string): Record<string, never> {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Record<string, never>) : {};
}

/** `i18n/drafts/` 폴더에서 그 언어의 초안을 읽는다. 아직 없으면 빈 저장소 */
export function readStore(dir: string, code: string): DraftStore {
  return { drafts: readJson(join(dir, files(code).drafts)), meta: readJson(join(dir, files(code).meta)), runs: readJson(join(dir, RUNS)) };
}

function writeAtomic(path: string, value: unknown): void {
  const temp = `${path}.tmp`;
  writeFileSync(temp, canonicalJson(value));
  renameSync(temp, path);
}

/** 정해진 직렬화로 쓴다. 파일마다 임시 파일에 쓴 뒤 이름을 바꿔, 중간에 죽어도 반쯤 쓴 JSON이 남지 않게 한다 */
export function writeStore(dir: string, code: string, store: DraftStore, increment?: Increment): void {
  mkdirSync(join(dir, 'increments'), { recursive: true });
  if (increment !== undefined) {
    writeAtomic(join(dir, 'increments', `${increment.version}.json`), increment);
  }
  writeAtomic(join(dir, RUNS), store.runs);
  writeAtomic(join(dir, files(code).meta), store.meta);
  writeAtomic(join(dir, files(code).drafts), store.drafts);
}
