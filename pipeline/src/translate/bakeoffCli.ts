import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { langPaths, primaryLanguage } from '../i18n/languages.ts';
import { describeRequest, failedOnlyByRequests, runBakeoff, runOrder, smokeItems, type BakeoffRecord, type RunOutcome } from './bakeoff.ts';
import { llamaProps } from './engines/llamaServer.ts';
import { createEngine, profile, PROFILES, type EngineDeps } from './engines/profiles.ts';
import { readSecret } from './env.ts';
import { loadGlossary } from './glossary.ts';
import { blindBatches } from './judge.ts';
import { buildReport, renderTables } from './reportCli.ts';
import { drawSample, type CatalogEntry, type SampleItem } from './sample.ts';

const BATCH = 20;
const RETRY_BATCH = 5;
const JUDGE_PASSES = 2;
const JUDGE_BATCH = 25;
const USAGE = '사용법: cli.ts bakeoff sample | bakeoff sample2 | bakeoff judge-prepare | bakeoff report | bakeoff run --engine <id> [--limit N | --repair | --tag 이름] [--sample sample2] [--prompt-version 1|2] [--base-url http://127.0.0.1:8080]';

interface SampleFile {
  readonly version: string;
  readonly glossary: string;
  readonly items: readonly SampleItem[];
}

interface RunMeta {
  readonly started: string;
  readonly finished: string;
  readonly resumedAfter: number;
  readonly repaired: number;
  readonly outcome: RunOutcome;
  readonly promptHash: string;
  readonly promptVersion: 1 | 2;
  readonly sampleName: string;
  readonly glossaryHash: string;
  readonly sampleHash: string;
  readonly server?: { readonly modelPath: string; readonly build: string };
  readonly node: string;
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as T);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 표본을 읽고, 뽑은 뒤 용어집이 바뀌지 않았는지 확인한다 */
function loadSample(samplePath: string, glossaryText: string): { sample: SampleFile; sampleText: string } {
  if (!existsSync(samplePath)) {
    throw new Error('표본이 없습니다. 먼저 bakeoff sample을 실행하세요.');
  }
  const sampleText = readFileSync(samplePath, 'utf8');
  const sample = JSON.parse(sampleText) as SampleFile;
  if (sample.glossary !== hash(glossaryText)) {
    throw new Error('표본을 뽑은 뒤 용어집이 바뀌었습니다. bakeoff sample을 다시 실행하세요.');
  }

  return { sample, sampleText };
}

/** 띄운 llama-server가 이 엔진의 모델을 올렸는지 확인하고, 보고서에 실을 빌드 정보를 읽는다. */
export async function bakeoffCommand(argv: readonly string[], root: string): Promise<void> {
  const dir = join(root, '.work', 'bakeoff');
  mkdirSync(dir, { recursive: true });
  const glossaryPath = join(root, langPaths(primaryLanguage(root).code).glossary);
  const glossaryText = readFileSync(glossaryPath, 'utf8');
  const glossary = loadGlossary(glossaryPath);
  const samplePath = join(dir, 'sample.json');

  switch (argv[1]) {
    case 'sample2': {
      // 2b 프롬프트 v1·v2 비교용: 2a 표본 키를 빼고 동사로 시작하는 설정·도움말 층을 더한 80개
      const catalog = JSON.parse(readFileSync(join(root, 'i18n', 'catalog.json'), 'utf8')) as { version: string; keys: Record<string, CatalogEntry> };
      const { sample: first } = loadSample(samplePath, glossaryText);
      const strata = [['tag', 10], ['placeholder', 15], ['label', 10], ['long', 5], ['edge', 5], ['directive', 15], ['representative', 20]] as const;
      const sample: SampleFile = { version: catalog.version, glossary: hash(glossaryText), items: drawSample(catalog.keys, glossary, { exclude: new Set(first.items.map((i) => i.key)), strata }) };
      writeFileSync(join(dir, 'sample2.json'), `${JSON.stringify(sample, null, 2)}\n`);
      console.log(`표본2 ${String(sample.items.length)}개 → ${join(dir, 'sample2.json')}`);
      return;
    }
    case 'sample': {
      const catalog = JSON.parse(readFileSync(join(root, 'i18n', 'catalog.json'), 'utf8')) as { version: string; keys: Record<string, CatalogEntry> };
      const sample: SampleFile = { version: catalog.version, glossary: hash(glossaryText), items: drawSample(catalog.keys, glossary) };
      const body = `${JSON.stringify(sample, null, 2)}\n`;
      writeFileSync(samplePath, body);
      mkdirSync(join(root, '.local', 'bakeoff'), { recursive: true });
      writeFileSync(join(root, '.local', 'bakeoff', 'sample.json'), body);
      const strata = new Map<string, number>();
      for (const item of sample.items) {
        strata.set(item.stratum, (strata.get(item.stratum) ?? 0) + 1);
      }
      console.log(`표본 ${String(sample.items.length)}개 (${[...strata].map(([s, n]) => `${s} ${String(n)}`).join(', ')}) → ${samplePath}`);
      return;
    }
    case 'report': {
      const { sample } = loadSample(samplePath, glossaryText);
      const report = buildReport(dir, sample.items, glossary);
      const tables = renderTables(report);
      writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(join(dir, 'report-tables.md'), tables);
      mkdirSync(join(root, '.local', 'bakeoff'), { recursive: true });
      writeFileSync(join(root, '.local', 'bakeoff', 'report-tables.md'), tables);
      console.log(tables);
      return;
    }
    case 'judge-prepare': {
      const { sample } = loadSample(samplePath, glossaryText);
      const records = new Map<string, Map<string, BakeoffRecord>>();
      for (const p of PROFILES) {
        records.set(p.id, new Map(readJsonl<BakeoffRecord>(join(dir, `${p.id}.jsonl`)).map((r) => [r.id, r])));
      }
      const { batches, key, excluded } = blindBatches(sample.items, records, glossary, { passes: JUDGE_PASSES, batchSize: JUDGE_BATCH });
      const judgeDir = join(dir, 'judge');
      mkdirSync(judgeDir, { recursive: true });
      for (const batch of batches) {
        writeFileSync(join(judgeDir, `pass-${String(batch.pass)}-batch-${String(batch.batch)}.json`), `${JSON.stringify(batch, null, 2)}\n`);
      }
      // 라벨 → 엔진 표는 심판이 여는 judge/ 밖에 둔다
      writeFileSync(join(dir, 'judge-key.json'), `${JSON.stringify({ key, excluded }, null, 2)}\n`);
      console.log(`심판 묶음 ${String(batches.length)}개 → ${judgeDir} (폴백이라 뺀 후보 ${String(excluded.length)}개)`);
      return;
    }
    case 'run': {
      const engineId = option(argv, 'engine');
      if (engineId === undefined) {
        throw new Error(USAGE);
      }
      const p = profile(engineId);
      const sampleName = option(argv, 'sample') ?? 'sample';
      if (!/^sample2?$/.test(sampleName)) {
        throw new Error('--sample은 sample 또는 sample2만 받는다.');
      }
      const versionText = option(argv, 'prompt-version') ?? String(p.promptVersion ?? 2);
      if (versionText !== '1' && versionText !== '2') {
        throw new Error('--prompt-version은 1 또는 2다.');
      }
      const promptVersion = versionText === '1' ? 1 : 2;
      const { sample, sampleText } = loadSample(join(dir, `${sampleName}.json`), glossaryText);
      const limitText = option(argv, 'limit');
      const limit = limitText === undefined ? undefined : Number(limitText);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        throw new Error('--limit는 1 이상의 정수여야 합니다.');
      }
      // --tag: 동결 실행과 따로 남기는 보조 실행(예: 프롬프트 결함을 고친 재실행)
      const tag = option(argv, 'tag');
      if (tag !== undefined && !/^[a-z0-9-]+$/.test(tag)) {
        throw new Error('--tag는 영문 소문자·숫자·하이픈만 씁니다.');
      }
      const base = limit !== undefined ? `${p.id}.smoke` : tag === undefined ? p.id : `${p.id}.${tag}`;
      const recordsPath = join(dir, `${base}.jsonl`);
      const requestsPath = join(dir, `${base}.requests.jsonl`);
      const metaPath = join(dir, `${base}.meta.json`);
      if (limit !== undefined) {
        writeFileSync(recordsPath, '');
        writeFileSync(requestsPath, '');
      }
      let repaired = 0;
      if (argv.includes('--repair') && limit === undefined) {
        // API 오류로만 폴백한 기록을 지우면 아래 이어하기가 그 항목만 다시 돌린다
        const kept = readJsonl<BakeoffRecord>(recordsPath).filter((record) => {
          const broken = failedOnlyByRequests(record);
          repaired += broken ? 1 : 0;

          return !broken;
        });
        writeFileSync(recordsPath, kept.map((record) => `${JSON.stringify(record)}\n`).join(''));
        console.log(`API 오류로만 폴백한 ${String(repaired)}개를 다시 돌립니다.`);
      }
      const done = new Set(readJsonl<BakeoffRecord>(recordsPath).map((r) => r.id));
      const items = (limit === undefined ? runOrder(sample.items) : smokeItems(sample.items, limit)).filter((item) => !done.has(item.id));
      let deps: EngineDeps;
      let server: { modelPath: string; build: string } | undefined;
      if (p.runtime === 'gemini') {
        deps = { apiKey: readSecret(join(root, '.env'), 'GEMINI_API_KEY') };
      } else {
        const baseUrl = option(argv, 'base-url') ?? 'http://127.0.0.1:8080';
        deps = { baseUrl };
        server = await llamaProps(baseUrl, p.model);
      }
      console.log(`${p.label}: ${String(items.length)}개 실행${done.size > 0 ? `(이미 ${String(done.size)}개 있음, 이어서)` : ''}`);
      const started = new Date().toISOString();
      const outcome = await runBakeoff({
        items,
        glossary,
        style: p.style,
        schema: p.schema,
        engine: createEngine(p, deps),
        engineId: p.id,
        batchSize: BATCH,
        retryBatchSize: RETRY_BATCH,
        promptVersion,
        sleep,
        onRecord: (record) => {
          appendFileSync(recordsPath, `${JSON.stringify(record)}\n`);
        },
        onRequest: (log) => {
          appendFileSync(requestsPath, `${JSON.stringify(log)}\n`);
          console.log(describeRequest(log));
        },
        onWait: (ms, error) => {
          console.log(`${error.kind}: ${String(Math.round(ms / 1000))}초 기다립니다`);
        },
      });
      const run: RunMeta = {
        started,
        finished: new Date().toISOString(),
        resumedAfter: done.size,
        repaired,
        outcome,
        promptHash: hash(readFileSync(join(root, 'pipeline', 'src', 'translate', 'prompt.ts'), 'utf8')),
        promptVersion,
        sampleName,
        glossaryHash: hash(glossaryText),
        sampleHash: hash(sampleText),
        ...(server === undefined ? {} : { server }),
        node: process.version,
      };
      const previous = existsSync(metaPath) && limit === undefined ? ((JSON.parse(readFileSync(metaPath, 'utf8')) as { runs?: RunMeta[] }).runs ?? []) : [];
      writeFileSync(metaPath, `${JSON.stringify({ profile: p, runs: [...previous, run] }, null, 2)}\n`);
      console.log(`기록 ${String(outcome.records)} · 폴백 ${String(outcome.fallbacks)} · 재요청 항목 ${String(outcome.retried)} · 요청 ${String(outcome.requests)} → ${recordsPath}`);
      if (outcome.stopped === 'quota-daily') {
        console.log('일일 한도로 멈췄습니다. 한도가 풀린 뒤(태평양시 자정) 같은 명령으로 이어서 돌립니다.');
      }
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
