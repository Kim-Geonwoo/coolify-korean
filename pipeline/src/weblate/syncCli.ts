import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readStore } from '../i18n/drafts.ts';
import { loadExclusions } from '../i18n/exclusions.ts';
import { langPaths } from '../i18n/languages.ts';
import { canonicalJson, checkIntegrity } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { assertCatalogVersion, loadState } from '../sync/state.ts';
import { compare } from '../sync/upstream.ts';
import { loadGlossary, parseGlossary } from '../translate/glossary.ts';
import { adoptUploaded, explanationFor, glossaryFromUnits, pendingSuggestions, planUploads, reviewedFromUnits, weblateSource } from './bridge.ts';
import { createClient } from './client.ts';
import { WEBLATE } from './config.ts';

export interface SyncReport {
  readonly sourceUploaded: boolean;
  readonly draftsUploaded: number;
  readonly suggestionsUploaded: number;
  readonly reviewed: number;
  readonly pending: number;
  /** 승인됐지만 레포 하드 검사에 걸려 뺀 번역(알림 대상) */
  readonly rejected: readonly { readonly key: string; readonly issues: readonly string[] }[];
  readonly glossaryChanged: boolean;
  /** 레포 파일(reviewed·pending·용어집)이 바뀌었는가(밤 작업이 커밋할지) */
  readonly changed: boolean;
  /** 이번에 바꾼 원문 단위 설명란 수 */
  readonly explanations: number;
  /** 설명란을 바꾸다 멈춘 이유(꾸밈 정보라 나머지 결과는 그대로다) */
  readonly explanationsError?: string;
  /** Weblate에 올리지 않은 키(앞 점 키 등). 이 키들은 검수 밖에서 초안으로만 남는다 */
  readonly skippedKeys: readonly string[];
}

/** 카탈로그 항목에서 설명란에 쓰는 부분(occurrences는 옛 카탈로그에 없을 수 있다) */
type CatalogWithPlaces = CatalogLite & { readonly keys: Readonly<Record<string, { readonly occurrences?: readonly { readonly file: string; readonly line: number }[] }>> };

export interface SyncOptions {
  readonly root: string;
  readonly baseUrl: string;
  /** weblate-bridge.token·weblate-flash.token이 있는 폴더(systemd LoadCredential) */
  readonly tokenDir: string;
  readonly cacheDir: string;
  readonly timeoutMs?: number;
  /** 승인 번역이 크게 줄어도 쓴다(사람이 확인한 뒤 한 번만) */
  readonly allowShrink?: boolean;
}

/**
 * 승인 번역이 갑자기 크게 줄었는가(10개 이상에서 20% 넘게). 컴포넌트를 다시 만들었거나 옛 백업을 복원하면 Weblate 승인이 사라지는데,
 * 그때 레포가 승인의 유일한 사본이라 덮어쓰지 않고 멈춘다(검토 2026-10-18 Important 5)
 */
export function reviewedShrinksTooMuch(before: number, after: number): boolean {
  return before >= 10 && after < before * 0.8;
}

const CACHE = { uploaded: 'weblate-uploaded.json', suggested: 'weblate-suggested.json', source: 'weblate-source.sha', version: 'weblate-source.version' } as const;
// 원문 교체(4천 키)는 클라이언트 기본 20초보다 오래 걸릴 수 있다
const TIMEOUT_MS = 120_000;
const READ_ONLY = 100;
const USAGE = '사용법: cli.ts weblate sync [--base-url http://127.0.0.1:8792] [--token-dir D(기본 $CREDENTIALS_DIRECTORY)] [--cache-dir D] [--report 파일] [--allow-shrink]';

function readJsonOr<T>(path: string, fallback: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback;
}

/** 임시 파일에 쓴 뒤 이름을 바꿔, 중간에 죽어도 반쯤 쓴 파일이 남지 않게 한다 */
function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** 바뀐 파일만 쓴다. 비어 있고 아직 없는 파일은 만들지 않는다. 썼으면 true */
export function writeIfChanged(path: string, text: string, empty: boolean): boolean {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
  if (before === text || (before === undefined && empty)) {
    return false;
  }
  writeAtomic(path, text);

  return true;
}

function token(dir: string, name: string): string {
  const value = readFileSync(join(dir, name), 'utf8').trim();
  if (value === '') {
    throw new Error(`Weblate 토큰 파일이 비어 있습니다: ${name}`);
  }

  return value;
}

function jsonObject(text: string): Record<string, unknown> {
  try {
    const data = JSON.parse(text) as unknown;

    return typeof data === 'object' && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * 지난번 검수 결과: 마지막 커밋(그날 밤 정리 전)과 작업 파일을 합친다. 추출 뒤 정리 단계(prune)가 작업 파일에서 뺀
 * 낡은 승인도 "옛 영어에 대한 승인"으로 알아보게 한다. git 사본이 아니면 작업 파일만 본다
 */
export function previousReviewed(root: string): { reviewed: Record<string, string>; meta: Record<string, { sourceHash: string }> } {
  const fromGit = (path: string): Record<string, unknown> => {
    const result = spawnSync('git', ['show', `HEAD:${path}`], { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30_000 });

    return result.status === 0 ? jsonObject(result.stdout) : {};
  };
  const fromFile = (path: string): Record<string, unknown> => (existsSync(join(root, path)) ? jsonObject(readFileSync(join(root, path), 'utf8')) : {});
  const both = (path: string): Record<string, unknown> => ({ ...fromGit(path), ...fromFile(path) });

  return {
    reviewed: Object.fromEntries(Object.entries(both(langPaths(WEBLATE.lang).reviewed)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
    meta: Object.fromEntries(
      Object.entries(both(langPaths(WEBLATE.lang).reviewedMeta)).flatMap(([key, value]) => {
        const hash = (value as { sourceHash?: unknown } | null)?.sourceHash;

        return typeof hash === 'string' ? [[key, { sourceHash: hash }]] : [];
      }),
    ),
  };
}

/**
 * 밤 작업의 Weblate 단계. 순서: 원문(바뀌었을 때만 교체) → 사람이 건드리지 않은 초안 → Flash 제안(한 번만)
 * → 승인(30)은 reviewed, 번역됨(20)은 pending → 용어집(Weblate가 편집 원본) → 무결성 검사를 통과해야 레포 파일을 쓴다.
 * 무엇을 올렸는지는 캐시에 남겨, 사람이 고친 것과 우리가 올린 것을 가른다.
 */
export async function weblateSync(options: SyncOptions): Promise<SyncReport> {
  const { project, component, glossary, lang } = WEBLATE;
  const i18n = join(options.root, 'i18n');
  const state = loadState(join(i18n, 'state.json'));
  const catalog = JSON.parse(readFileSync(join(i18n, 'catalog.json'), 'utf8')) as CatalogWithPlaces;
  assertCatalogVersion(catalog, state);
  const exclusions = loadExclusions(join(i18n, 'exclude.json'));
  const verbatim = readJsonOr<{ literals: string[] }>(join(i18n, 'verbatim.json'), { literals: [] }).literals;
  const en = JSON.parse(readFileSync(join(i18n, 'en.json'), 'utf8')) as Record<string, string>;
  const paths = langPaths(lang);
  const store = readStore(join(i18n, 'drafts'), lang);
  const glossaryPath = join(options.root, paths.glossary);
  const currentGlossary = loadGlossary(glossaryPath);
  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const bridge = createClient({ baseUrl: options.baseUrl, token: token(options.tokenDir, 'weblate-bridge.token'), timeoutMs });
  const flash = createClient({ baseUrl: options.baseUrl, token: token(options.tokenDir, 'weblate-flash.token'), timeoutMs });
  const cache = (name: string): string => join(options.cacheDir, name);

  const { source, skipped } = weblateSource(en);
  const hash = createHash('sha256').update(canonicalJson(source)).digest('hex');
  const sourceUploaded = (existsSync(cache(CACHE.source)) ? readFileSync(cache(CACHE.source), 'utf8').trim() : '') !== hash;
  if (sourceUploaded) {
    // 단일어 JSON의 원문 갱신은 replace다(source는 거부, PoC 4). 지운 키는 Weblate에서 그 사람 번역과 함께 사라진다.
    // 그래서 옛 버전 원문(리허설 브랜치·옛 사본에서 수동 실행)으로는 바꾸지 않는다
    const last = existsSync(cache(CACHE.version)) ? readFileSync(cache(CACHE.version), 'utf8').trim() : '';
    if (last !== '' && compare(catalog.version, last) < 0) {
      throw new Error(`원문 ${catalog.version}이 지난번 Weblate에 올린 ${last}보다 낮아 멈춥니다(새 문자열과 그 번역이 지워진다).`);
    }
    await bridge.uploadFile(project, component, 'en', source, { method: 'replace' });
    writeAtomic(cache(CACHE.source), `${hash}\n`);
    writeAtomic(cache(CACHE.version), `${catalog.version}\n`);
  }

  const units = await bridge.units(project, component, lang);
  if (units.length === 0) {
    // 컴포넌트를 잃었거나 다시 만든 직후다. 빈 결과로 레포의 검수 번역을 지우지 않는다
    throw new Error(`Weblate ${component}/${lang}에 단위가 없습니다(weblate setup을 먼저).`);
  }
  // 기록을 잃은 업로드(Weblate에 지금 초안 그대로 남은 수정 필요 단위)를 되찾는다
  const { uploaded, adopted } = adoptUploaded({ units, drafts: store.drafts, uploaded: readJsonOr<Record<string, string>>(cache(CACHE.uploaded), {}) });
  if (adopted.length > 0) {
    writeAtomic(cache(CACHE.uploaded), canonicalJson(uploaded));
  }
  const plan = planUploads({ units, drafts: store.drafts, uploaded, exclusions });
  const draftsUploaded = Object.keys(plan.drafts).length;
  if (draftsUploaded > 0) {
    // PoC 3 조합: 수정 필요(fuzzy)로, 충돌 기본값. 사람 번역은 planUploads가 이미 걸렀다
    await bridge.uploadFile(project, component, lang, plan.drafts, { method: 'fuzzy' });
    writeAtomic(cache(CACHE.uploaded), canonicalJson({ ...uploaded, ...plan.drafts }));
  }

  // 보낸 제안 기록: 키 → 보낸 값. 예전 기록(키 목록)은 지금 값으로 이미 보낸 것으로 본다(같은 제안을 두 번 보내지 않게)
  const sentRaw = readJsonOr<unknown>(cache(CACHE.suggested), {});
  const sent: Record<string, string> = Array.isArray(sentRaw)
    ? Object.fromEntries((sentRaw as unknown[]).flatMap((key) => (typeof key === 'string' ? [[key, store.meta[key]?.review?.fix ?? '']] : [])))
    : Object.fromEntries(Object.entries(sentRaw as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  const open = new Map(units.filter((unit) => unit.state !== READ_ONLY && !exclusions.has(unit.key)).map((unit) => [unit.key, unit.target]));
  const suggestions = Object.fromEntries(Object.entries(pendingSuggestions(store, sent)).filter(([key, fix]) => open.has(key) && open.get(key) !== fix));
  const suggestionsUploaded = Object.keys(suggestions).length;
  if (suggestionsUploaded > 0) {
    await flash.uploadFile(project, component, lang, suggestions, { method: 'suggest' });
    writeAtomic(cache(CACHE.suggested), canonicalJson({ ...sent, ...suggestions }));
  }

  const out = reviewedFromUnits({ units, catalog, exclusions, verbatim, previous: previousReviewed(options.root) });
  const nextGlossary = parseGlossary(glossaryFromUnits(currentGlossary, await bridge.units(project, glossary, lang)));
  const problems = checkIntegrity({ catalog, stateVersion: state.upstream.version, exclusions, verbatim, reviewed: out.reviewed, reviewedMeta: out.meta, pending: out.pending });
  if (problems.length > 0) {
    throw new Error(`Weblate 결과 무결성 문제 ${String(problems.length)}건(쓰지 않음): ${problems.slice(0, 5).join(' / ')}`);
  }
  const reviewedBefore = Object.keys(readJsonOr<Record<string, string>>(join(options.root, paths.reviewed), {})).length;
  const reviewedAfter = Object.keys(out.reviewed).length;
  if (options.allowShrink !== true && reviewedShrinksTooMuch(reviewedBefore, reviewedAfter)) {
    throw new Error(`승인 번역이 ${String(reviewedBefore)}개에서 ${String(reviewedAfter)}개로 크게 줄어 쓰지 않습니다(컴포넌트 재생성·옛 백업 복원인지 확인, 맞으면 --allow-shrink로 한 번 돌린다).`);
  }
  const empty = (value: object): boolean => Object.keys(value).length === 0;
  const wrote = [
    writeIfChanged(join(options.root, paths.reviewed), canonicalJson(out.reviewed), empty(out.reviewed)),
    writeIfChanged(join(options.root, paths.reviewedMeta), canonicalJson(out.meta), empty(out.meta)),
    writeIfChanged(join(options.root, paths.pending), canonicalJson(out.pending), empty(out.pending)),
  ];
  // 용어집은 사람이 쓰는 파일이라 키 순서를 지키는 직렬화(들여쓰기 2칸)를 쓴다
  const glossaryChanged = writeIfChanged(glossaryPath, `${JSON.stringify(nextGlossary, null, 2)}\n`, false);

  // 원문 단위 설명란(쓰인 곳·종류·번역 제외 이유). 바뀐 것만 고친다. 꾸밈 정보라 실패해도 위 결과는 그대로 둔다
  let explanations = 0;
  let explanationsError: string | undefined;
  try {
    for (const unit of await bridge.units(project, component, 'en')) {
      const entry = catalog.keys[unit.key];
      if (entry === undefined) {
        continue;
      }
      const exclusion = exclusions.get(unit.key);
      const text = explanationFor({ entry: { kinds: entry.kinds, occurrences: entry.occurrences ?? [] }, ...(exclusion === undefined ? {} : { exclusion }), version: catalog.version });
      if ((unit.explanation ?? '') !== text) {
        await bridge.patchUnit(unit.id, { explanation: text });
        explanations++;
      }
    }
  } catch (error: unknown) {
    explanationsError = error instanceof Error ? error.message : String(error);
  }

  return {
    sourceUploaded,
    draftsUploaded,
    suggestionsUploaded,
    reviewed: Object.keys(out.reviewed).length,
    pending: Object.keys(out.pending).length,
    rejected: out.rejected,
    glossaryChanged,
    changed: wrote.some(Boolean) || glossaryChanged,
    explanations,
    skippedKeys: skipped,
    ...(explanationsError === undefined ? {} : { explanationsError }),
  };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

export async function weblateSyncCommand(argv: readonly string[], root: string): Promise<void> {
  const tokenDir = option(argv, 'token-dir') ?? process.env['CREDENTIALS_DIRECTORY'];
  if (tokenDir === undefined) {
    throw new Error(USAGE);
  }
  const report = await weblateSync({
    root,
    baseUrl: option(argv, 'base-url') ?? process.env['COOLIFY_KO_WEBLATE_URL'] ?? 'http://127.0.0.1:8792',
    tokenDir,
    cacheDir: option(argv, 'cache-dir') ?? join(root, '.work', 'weblate'),
    allowShrink: argv.includes('--allow-shrink'),
  });
  const reportPath = option(argv, 'report');
  if (reportPath !== undefined) {
    writeAtomic(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(
    `Weblate: 원문 ${report.sourceUploaded ? '올림' : '그대로'} · 초안 ${String(report.draftsUploaded)} · 제안 ${String(report.suggestionsUploaded)} · 검수 ${String(report.reviewed)} · 승인 전 ${String(report.pending)} · 검사에 걸린 승인 ${String(report.rejected.length)} · 용어집 ${report.glossaryChanged ? '바뀜' : '그대로'} · 올리지 않은 키 ${String(report.skippedKeys.length)} · 설명 ${String(report.explanations)}${report.explanationsError === undefined ? '' : `(멈춤: ${report.explanationsError})`}`,
  );
}
