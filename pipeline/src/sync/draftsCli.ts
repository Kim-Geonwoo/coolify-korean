import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyDrafts, pendingKeys, readStore, resultsFromPlan, writeStore, type DraftResult, type RunInfo, type Translated } from '../i18n/drafts.ts';
import { loadExclusions } from '../i18n/exclusions.ts';
import { langPaths, primaryLanguage } from '../i18n/languages.ts';
import { checkIntegrity, sourceHash } from '../i18n/integrity.ts';
import { applyCachedReviews, reviewQueue, type CachedReview } from '../i18n/reviews.ts';
import { planDrafts, type CatalogLite, type PlanKind } from '../i18n/memory.ts';
import { describeRequest, type BakeoffRecord } from '../translate/bakeoff.ts';
import { llamaProps } from '../translate/engines/llamaServer.ts';
import { createEngine, profile, type EngineDeps } from '../translate/engines/profiles.ts';
import { readSecret } from '../translate/env.ts';
import { loadGlossary, termsIn } from '../translate/glossary.ts';
import { mask, placeholderNames, unmask, withoutPlaceholders } from '../translate/masking.ts';
import { normalize } from '../translate/normalize.ts';
import { reviewFailed, runReview, type ReviewItem } from '../translate/review.ts';
import type { CatalogEntry } from '../translate/sample.ts';
import { textType } from '../translate/prompt.ts';
import { hardIssues } from '../translate/validate.ts';
import { draftItems, isHardKey, translateKeys } from './drafting.ts';
import { assertCatalogVersion, loadState } from './state.ts';

const BATCH = 20;
const RETRY_BATCH = 5;
const KEEP_VERSIONS = 3;
const USAGE = '사용법: cli.ts drafts run --engine <id> [--base-url URL] [--ledger-dir D] [--previous catalog.json] [--report R] | drafts review [--engine flash] [--requests 15] [--gate pass] [--key-file F] [--cache-dir D] | drafts hard-prepare [--parts 2] [--only keys.json --name N] | drafts hard-import --files a.json,b.json --label 이름 [--instructions I.md] [--inputs in.json]';

interface Catalog {
  readonly version: string;
  readonly keys: Readonly<Record<string, CatalogEntry>>;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const today = (): string => new Date().toISOString().slice(0, 10);

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

function readJsonl<T>(path: string): T[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T) : [];
}

const semver = (v: string): number[] => v.split('.').map(Number);
const bySemver = (a: string, b: string): number => {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return d;
    }
  }

  return 0;
};

/** 처리한 버전들: increments 파일 이름 + 이번 버전 */
function history(dir: string, version: string): string[] {
  const done = existsSync(join(dir, 'increments')) ? readdirSync(join(dir, 'increments')).filter((f) => /^\d+\.\d+\.\d+\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];

  return [...new Set([...done, version])].sort(bySemver);
}

interface Context {
  readonly root: string;
  /** 번역 언어(i18n/languages.json에서 켜진 하나) */
  readonly code: string;
  readonly draftsDir: string;
  readonly catalog: Catalog;
  readonly exclusions: Map<string, string>;
  readonly verbatim: readonly string[];
  readonly glossaryText: string;
}

function context(root: string): Context {
  const state = loadState(join(root, 'i18n', 'state.json'));
  const catalog = JSON.parse(readFileSync(join(root, 'i18n', 'catalog.json'), 'utf8')) as Catalog;
  assertCatalogVersion(catalog, state);

  const verbatimPath = join(root, 'i18n', 'verbatim.json');
  const verbatim = existsSync(verbatimPath) ? (JSON.parse(readFileSync(verbatimPath, 'utf8')) as { literals: string[] }).literals : [];

  const { code } = primaryLanguage(root);

  return { root, code, draftsDir: join(root, 'i18n', 'drafts'), catalog, exclusions: loadExclusions(join(root, 'i18n', 'exclude.json')), verbatim, glossaryText: readFileSync(join(root, langPaths(code).glossary), 'utf8') };
}

/** 결과를 초안에 반영하고 무결성을 확인한 뒤 쓴다. 문제가 있으면 쓰지 않고 멈춘다 */
function commit(ctx: Context, results: ReadonlyMap<string, DraftResult>, runs: Readonly<Record<string, RunInfo>>, options: { readonly replace?: ReadonlySet<string>; readonly previous?: CatalogLite } = {}): ReturnType<typeof applyDrafts> {
  const store = readStore(ctx.draftsDir, ctx.code);
  const first = Object.keys(store.drafts).length === 0;
  // 밤 작업은 갱신 전 카탈로그(--previous)를 넘겨 그 버전의 증분을 남긴다. 첫 전량은 빈 카탈로그와 비교한다
  const previous: CatalogLite = options.previous ?? (first ? { version: '', keys: {} } : ctx.catalog);
  const replace = options.replace;
  const out = applyDrafts({ store, previous, next: ctx.catalog, results, runs, history: history(ctx.draftsDir, ctx.catalog.version), keepVersions: KEEP_VERSIONS, exclusions: ctx.exclusions, verbatim: ctx.verbatim, ...(replace === undefined ? {} : { replace }) });
  const problems = checkIntegrity({ catalog: ctx.catalog, stateVersion: ctx.catalog.version, exclusions: ctx.exclusions, verbatim: ctx.verbatim, drafts: out.store.drafts, meta: out.store.meta, runs: out.store.runs });
  if (problems.length > 0) {
    throw new Error(`초안 무결성 문제 ${String(problems.length)}건(쓰지 않음): ${problems.slice(0, 5).join(' / ')}`);
  }
  writeStore(ctx.draftsDir, ctx.code, out.store, first || options.previous !== undefined ? out.increment : undefined);

  return out;
}

async function runCommand(argv: readonly string[], ctx: Context): Promise<void> {
  const engineId = option(argv, 'engine');
  if (engineId === undefined) {
    throw new Error(USAGE);
  }
  const p = profile(engineId);
  const promptVersion = p.promptVersion ?? 2;
  const glossary = loadGlossary(join(ctx.root, langPaths(ctx.code).glossary));
  const store = readStore(ctx.draftsDir, ctx.code);
  const keys = pendingKeys(ctx.catalog, store, ctx.exclusions);
  const plan = planDrafts({ catalog: ctx.catalog, drafts: store.drafts, exclusions: ctx.exclusions, keys });
  const counts = new Map<PlanKind, number>();
  for (const entry of plan) {
    counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  }
  console.log(`초안이 필요한 키 ${String(keys.length)} → ${[...counts].map(([k, n]) => `${k} ${String(n)}`).join(' · ')}`);

  const promptHash = hash(readFileSync(join(ctx.root, 'pipeline', 'src', 'translate', 'prompt.ts'), 'utf8'));
  const glossaryHash = hash(ctx.glossaryText);
  const ledgerDir = option(argv, 'ledger-dir') ?? join(ctx.root, '.work', 'ledger');
  mkdirSync(ledgerDir, { recursive: true });
  const ledgerPath = join(ledgerDir, `${p.id}.p${String(promptVersion)}.${promptHash}.${glossaryHash}.jsonl`);
  const requestsPath = ledgerPath.replace(/\.jsonl$/, '.requests.jsonl');
  const ledger = new Map(readJsonl<BakeoffRecord>(ledgerPath).map((record) => [record.id, record]));
  let deps: EngineDeps;
  let server: { modelPath: string; build: string } | undefined;
  if (p.runtime === 'gemini') {
    deps = { apiKey: readSecret(join(ctx.root, '.env'), 'GEMINI_API_KEY') };
  } else {
    const baseUrl = option(argv, 'base-url') ?? 'http://127.0.0.1:8080';
    deps = { baseUrl };
    server = await llamaProps(baseUrl, p.model);
  }
  const run = `${today()}-${p.id}`;
  const memoryRun = `${today()}-memory`;
  const outcome = await translateKeys({
    catalog: ctx.catalog.keys,
    keys: plan.filter((entry) => entry.kind === 'mt').map((entry) => entry.key),
    glossary,
    engine: createEngine(p, deps),
    engineId: p.id,
    style: p.style,
    schema: p.schema,
    promptVersion,
    batchSize: p.batchSize ?? BATCH,
    retryBatchSize: p.retryBatchSize ?? RETRY_BATCH,
    run,
    ledger,
    sleep,
    onRecord: (record) => {
      appendFileSync(ledgerPath, `${JSON.stringify(record)}\n`);
    },
    onRequest: (log) => {
      appendFileSync(requestsPath, `${JSON.stringify(log)}\n`);
      console.log(describeRequest(log));
    },
    onWait: (ms, error) => {
      console.log(`${error.kind}: ${String(Math.round(ms / 1000))}초 기다립니다`);
    },
  });
  const runs: Record<string, RunInfo> = {
    [run]: { engine: p.id, model: p.model, ...(p.revision === undefined ? {} : { revision: p.revision }), ...(server === undefined ? {} : { build: server.build }), promptVersion, prompt: promptHash, glossary: glossaryHash, sampling: p.sampling },
    [memoryRun]: { engine: 'memory', prompt: '-', glossary: glossaryHash },
  };
  const previousPath = option(argv, 'previous');
  const previous = previousPath === undefined ? undefined : (JSON.parse(readFileSync(previousPath, 'utf8')) as CatalogLite);
  const results = resultsFromPlan(plan, outcome.translated, memoryRun);
  const out = commit(ctx, results, runs, previous === undefined ? {} : { previous });
  const normalized = [...results.values()].filter((result) => (result.edits?.length ?? 0) > 0).length;
  const reportPath = option(argv, 'report') ?? join(ctx.root, '.work', `drafts-${run}.json`);
  writeFileSync(reportPath, `${JSON.stringify({ run, increment: out.increment, fallbacks: outcome.fallbacks, normalized, rejected: out.rejected, resumed: outcome.resumed, requests: outcome.requests, stopped: outcome.stopped ?? null }, null, 2)}\n`);
  console.log(`초안 ${String(out.increment.drafted)}개 반영 · 폴백 ${String(outcome.fallbacks.length)} · 거부 ${String(out.rejected.length)} · 원장 재사용 ${String(outcome.resumed)} · 요청 ${String(outcome.requests)} → ${reportPath}`);
  if (outcome.stopped === 'quota-daily') {
    console.log('일일 한도로 멈췄습니다. 같은 명령으로 이어서 돌립니다.');
  }
}

/** 어려운 키를 서브에이전트가 읽을 입력 파일로 나눈다(가린 문장·문장/라벨·용어). 서브에이전트는 이 파일과 지시 파일만 본다 */
function hardPrepare(argv: readonly string[], ctx: Context): void {
  const parts = Number(option(argv, 'parts') ?? '2');
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error('--parts는 1 이상의 정수다.');
  }
  // --only: 다시 보낼 키 목록(JSON 배열). 없으면 절충안의 어려운 키 전부
  const onlyPath = option(argv, 'only');
  const only = onlyPath === undefined ? undefined : new Set(JSON.parse(readFileSync(onlyPath, 'utf8')) as string[]);
  const name = option(argv, 'name') ?? 'input';
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error('--name은 영문 소문자·숫자·하이픈만 씁니다.');
  }
  const glossary = loadGlossary(join(ctx.root, langPaths(ctx.code).glossary));
  const keys = Object.keys(ctx.catalog.keys).filter((key) => !ctx.exclusions.has(key) && (only === undefined ? isHardKey(ctx.catalog.keys[key] as CatalogEntry) : only.has(key)));
  const items = draftItems(ctx.catalog.keys, keys).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const dir = join(ctx.root, '.work', 'hard');
  mkdirSync(dir, { recursive: true });
  const map: Record<string, string> = {};
  const inputs = items.map((item) => {
    const names = placeholderNames(item.source, item.placeholders);
    const plain = withoutPlaceholders(item.source, names);
    const lower = plain.toLowerCase();
    const text = mask(item.source, names).text;
    map[item.id] = item.key;

    return {
      id: item.id,
      type: textType({ id: item.id, text, kind: item.kind, ...(item.kinds === undefined ? {} : { kinds: item.kinds }), file: item.file }),
      file: item.file,
      text,
      glossary: termsIn(plain, glossary).map((t) => `${t.en} → ${t.ko}`),
      keepEnglish: glossary.brands.filter((brand) => lower.includes(brand.toLowerCase())),
    };
  });
  const size = Math.ceil(inputs.length / parts);
  for (let part = 0; part < parts; part++) {
    writeFileSync(join(dir, `${name}-${String(part + 1)}.json`), `${JSON.stringify(inputs.slice(part * size, (part + 1) * size), null, 2)}\n`);
  }
  // id는 영어 원문의 지문이라 여러 번 나눠 보내도 겹치지 않는다. 지도는 합쳐 둔다
  const mapPath = join(dir, 'map.json');
  const previous = existsSync(mapPath) ? (JSON.parse(readFileSync(mapPath, 'utf8')) as Record<string, string>) : {};
  writeFileSync(mapPath, `${JSON.stringify({ ...previous, ...map }, null, 2)}\n`);
  console.log(`키 ${String(items.length)}개 → ${dir}/${name}-1..${String(parts)}.json`);
}

/** 서브에이전트 결과({id: 번역})를 되돌리기 → 하드 검사 → 정규화를 거쳐 기존 초안을 덮는다. 걸린 것은 다시 보낼 파일로 남긴다 */
function hardImport(argv: readonly string[], ctx: Context): void {
  const files = option(argv, 'files')?.split(',') ?? [];
  const label = option(argv, 'label');
  if (files.length === 0 || label === undefined || !/^[a-z0-9.-]+$/.test(label)) {
    throw new Error(USAGE);
  }
  const dir = join(ctx.root, '.work', 'hard');
  const map = JSON.parse(readFileSync(join(dir, 'map.json'), 'utf8')) as Record<string, string>;
  // 결과를 만든 지시 파일(해시를 runs.json에 남긴다)과, 답이 빠졌는지 셀 입력 파일
  const instructions = readFileSync(option(argv, 'instructions') ?? join(dir, 'instructions.md'), 'utf8');
  const inputs = (option(argv, 'inputs')?.split(',') ?? []).flatMap((path) => (JSON.parse(readFileSync(path, 'utf8')) as { id: string }[]).map((item) => item.id));
  const run = `${today()}-${label}`;
  const results = new Map<string, DraftResult>();
  const failed: { id: string; issues: string[] }[] = [];
  const answered = new Set<string>();
  for (const file of files) {
    const answers = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [id, value] of Object.entries(answers)) {
      answered.add(id);
      const key = map[id];
      const entry = key === undefined ? undefined : ctx.catalog.keys[key];
      if (key === undefined || entry === undefined || typeof value !== 'string') {
        failed.push({ id, issues: ['unknown-id'] });
        continue;
      }
      const names = placeholderNames(entry.english, entry.placeholders);
      const text = unmask(value.normalize('NFC'), mask(entry.english, names)).text;
      const normalized = normalize(text, names);
      const issues = hardIssues({ source: entry.english, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, placeholders: entry.placeholders }, normalized.text);
      if (issues.length > 0) {
        failed.push({ id, issues });
        continue;
      }
      const edits = normalized.edits.map(({ rule, before, after }) => ({ rule, before, after }));
      const translated: Translated = { text: normalized.text, run, ...(edits.length === 0 ? {} : { edits }), ...(normalized.warnings.length === 0 ? {} : { warnings: normalized.warnings }) };
      results.set(key, { ...translated, via: 'mt' });
    }
  }
  const missing = inputs.filter((id) => !answered.has(id));
  const runs: Record<string, RunInfo> = { [run]: { engine: label, prompt: hash(instructions), glossary: hash(ctx.glossaryText), input: hash(readFileSync(join(dir, 'map.json'), 'utf8')) } };
  const out = commit(ctx, results, runs, { replace: new Set(results.keys()) });
  writeFileSync(join(dir, `retry-${label}.json`), `${JSON.stringify({ failed, missing }, null, 2)}\n`);
  console.log(`반영 ${String(out.increment.drafted)} · 하드 검사 실패 ${String(failed.length)} · 답 없음 ${String(missing.length)} · 거부 ${String(out.rejected.length)} → ${join(dir, `retry-${label}.json`)}`);
}

/**
 * Flash 검토(하루 한도 안). 판정은 캐시(reviews.jsonl)에 이어 쓰고, 캐시 전체를 원문·초안이 그대로인 키의 메타에 다시 얹는다.
 * --gate pass면 major에 검수 필요 표시를 단다(3단계 게이트 통과 때만). 아니면 제안으로만 둔다.
 */
async function reviewCommand(argv: readonly string[], ctx: Context): Promise<void> {
  const p = profile(option(argv, 'engine') ?? 'flash');
  const maxRequests = Number(option(argv, 'requests') ?? '15');
  const batchSize = Number(option(argv, 'batch') ?? '25');
  if (!Number.isInteger(maxRequests) || maxRequests < 4 || !Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error('--requests는 4 이상, --batch는 1 이상의 정수다.');
  }
  const gatePassed = option(argv, 'gate') === 'pass';
  const cacheDir = option(argv, 'cache-dir') ?? join(ctx.root, '.work', 'reviews');
  mkdirSync(cacheDir, { recursive: true });
  const cachePath = join(cacheDir, 'reviews.jsonl');
  const keyFile = option(argv, 'key-file');
  const apiKey = keyFile === undefined ? readSecret(join(ctx.root, '.env'), 'GEMINI_API_KEY') : readFileSync(keyFile, 'utf8').trim();
  const glossary = loadGlossary(join(ctx.root, langPaths(ctx.code).glossary));
  const store = applyCachedReviews(readStore(ctx.draftsDir, ctx.code), readJsonl<CachedReview>(cachePath), { gatePassed });
  const latest = history(ctx.draftsDir, ctx.catalog.version).filter((v) => existsSync(join(ctx.draftsDir, 'increments', `${v}.json`))).at(-1);
  const increment = latest === undefined ? undefined : (JSON.parse(readFileSync(join(ctx.draftsDir, 'increments', `${latest}.json`), 'utf8')) as { added: string[]; changed: string[] });
  // 빠진 답을 다시 묻는 요청 몫을 남긴다(묶음마다 최대 한 번)
  const limit = Math.max(1, Math.floor(maxRequests / 2)) * batchSize;
  const keys = reviewQueue(store, { newest: increment === undefined ? [] : [...increment.added, ...increment.changed], limit });
  const items: ReviewItem[] = keys.flatMap((key) => {
    const entry = ctx.catalog.keys[key];
    const draft = store.drafts[key];

    return entry === undefined || draft === undefined ? [] : [{ id: key, source: entry.english, draft, kind: entry.kinds[0] ?? 'text', kinds: entry.kinds, file: entry.occurrences[0]?.file ?? '', placeholders: entry.placeholders }];
  });
  const run = `${today()}-${p.id}`;
  console.log(`검토 대기열에서 ${String(items.length)}개를 봅니다(요청 최대 ${String(maxRequests)}, 게이트 ${gatePassed ? '통과: major는 검수 필요' : '미통과: 제안으로만'})`);
  const outcome = await runReview({
    items,
    glossary,
    engine: createEngine(p, { apiKey }),
    batchSize,
    sleep,
    onResult: (result) => {
      const entry = ctx.catalog.keys[result.id];
      const draft = store.drafts[result.id];
      if (entry !== undefined && draft !== undefined) {
        const cached: CachedReview = { ...result, key: result.id, sourceHash: sourceHash(entry.english), draft, run };
        appendFileSync(cachePath, `${JSON.stringify(cached)}\n`);
      }
    },
    onRequest: (log) => {
      console.log(`요청 ${String(log.ids.length)}개 ${(log.ms / 1000).toFixed(1)}s${log.error === undefined ? '' : ` 실패 ${log.error}`}${log.unparsed === undefined ? '' : ' 해석 실패'}`);
    },
  });
  const updated = applyCachedReviews(readStore(ctx.draftsDir, ctx.code), readJsonl<CachedReview>(cachePath), { gatePassed });
  writeStore(ctx.draftsDir, ctx.code, updated);
  const left = reviewQueue(updated, { newest: [], limit: Number.MAX_SAFE_INTEGER }).length;
  const reportPath = option(argv, 'report') ?? join(cacheDir, `review-${run}.json`);
  writeFileSync(reportPath, `${JSON.stringify({ run, ...outcome, queueLeft: left, gatePassed }, null, 2)}\n`);
  console.log(`검토 ${String(outcome.reviewed)} · 빠짐 ${String(outcome.missing)} · 요청 ${String(outcome.requests)} · 남은 대기열 ${String(left)}${outcome.stopped === undefined ? '' : ' · 일일 한도로 멈춤'}`);
  if (reviewFailed(outcome)) {
    // 키가 틀리거나 만료되면 조용히 0개로 끝나 아무도 모른다. 단계 실패로 내서 알림이 가게 한다
    throw new Error('검토 요청이 모두 실패했습니다(키·API 확인 필요).');
  }
}

export async function draftsCommand(argv: readonly string[], root: string): Promise<void> {
  const ctx = context(root);
  switch (argv[1]) {
    case 'run':
      await runCommand(argv, ctx);
      return;
    case 'hard-prepare':
      hardPrepare(argv, ctx);
      return;
    case 'hard-import':
      hardImport(argv, ctx);
      return;
    case 'review':
      await reviewCommand(argv, ctx);
      return;
    default:
      throw new Error(USAGE);
  }
}
