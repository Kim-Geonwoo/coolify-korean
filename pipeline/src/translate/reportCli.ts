import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BakeoffRecord, RequestLog } from './bakeoff.ts';
import { PROFILES, type EngineProfile } from './engines/profiles.ts';
import type { Glossary } from './glossary.ts';
import { parseJudgeResult, shuffle, type JudgeBatch, type JudgeKey, type JudgeVerdict } from './judge.ts';
import { passAgreement, reliability, softSummary, sourceWords, type Reliability, type SoftSummary } from './report.ts';
import type { SampleItem, Stratum } from './sample.ts';
import { bootstrapDifference, itemPenalties, stratumScores, type ItemPenalty, type ScoredItem } from './score.ts';

/** 무료 등급 하루 요청 한도. 공식 수치가 없어 제3자 값을 쓴다(2026-10-17 조사) */
const API_DAILY_LIMIT: Readonly<Record<string, number>> = { flash: 20, 'flash-lite': 500, 'gemma4-26b': 1500, 'gemma4-31b': 1500 };
const FULL_KEYS = 4015;
const INCREMENT_KEYS = 300;
const STRATA: readonly Stratum[] = ['representative', 'label', 'placeholder', 'tag', 'long', 'edge'];

export interface EngineReport {
  readonly profile: EngineProfile;
  readonly reliability: Reliability;
  readonly soft: SoftSummary;
  readonly perHundredWords: number;
  readonly byStratum: Readonly<Record<string, number>>;
  readonly versusBest: { readonly estimate: number; readonly low: number; readonly high: number };
  readonly majorsPerHundredWords: number;
  readonly confirmedCriticals: number;
  readonly markupErrors: number;
  readonly tokensPerSecond?: number;
}

export interface CriticalCase {
  readonly engine: string;
  readonly id: string;
  readonly source: string;
  readonly text: string;
  readonly notes: readonly string[];
}

export interface PreferItem {
  readonly id: string;
  readonly stratum: string;
  readonly source: string;
  readonly candidates: readonly { readonly label: string; readonly text: string }[];
}

export interface BakeoffReport {
  readonly engines: readonly EngineReport[];
  readonly best: string;
  readonly agreement: { readonly pairs: number; readonly agree: number };
  readonly criticals: readonly CriticalCase[];
  readonly prefer: readonly PreferItem[];
  readonly preferKey: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

function readJsonl<T>(path: string): T[] {
  return existsSync(path) ? readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as T) : [];
}

function loadVerdicts(dir: string): JudgeVerdict[] {
  const verdicts: JudgeVerdict[] = [];
  const missing: string[] = [];
  for (let pass = 1; pass <= 2; pass++) {
    for (let batch = 1; ; batch++) {
      const input = join(dir, 'judge', `pass-${String(pass)}-batch-${String(batch)}.json`);
      if (!existsSync(input)) {
        break;
      }
      const output = join(dir, 'judge', `result-pass-${String(pass)}-batch-${String(batch)}.json`);
      if (!existsSync(output)) {
        missing.push(output);
        continue;
      }
      verdicts.push(...parseJudgeResult(readFileSync(output, 'utf8'), JSON.parse(readFileSync(input, 'utf8')) as JudgeBatch));
    }
  }
  if (missing.length > 0) {
    throw new Error(`심판 결과가 없습니다: ${missing.join(', ')}`);
  }

  return verdicts;
}

/** 층마다 키 해시 순으로 2개씩, 엔진 이름을 가린 블라인드 선호 문항 12개 */
export function preferSet(items: readonly SampleItem[], records: ReadonlyMap<string, ReadonlyMap<string, BakeoffRecord>>): { prefer: PreferItem[]; key: Record<string, Record<string, string>> } {
  const prefer: PreferItem[] = [];
  const key: Record<string, Record<string, string>> = {};
  const labels = ['A', 'B', 'C', 'D', 'E', 'F'];
  for (const stratum of STRATA) {
    const chosen = shuffle(items.filter((i) => i.stratum === stratum).map((i) => i.id).sort(), `prefer:${stratum}`).slice(0, 2);
    for (const id of chosen) {
      const item = items.find((i) => i.id === id);
      if (item === undefined) {
        continue;
      }
      const engines = shuffle([...records.keys()], `prefer:${id}`).filter((engine) => records.get(engine)?.get(id)?.fallback === false);
      key[id] = Object.fromEntries(engines.map((engine, index) => [labels[index] ?? '?', engine]));
      prefer.push({ id, stratum, source: item.source, candidates: engines.map((engine, index) => ({ label: labels[index] ?? '?', text: records.get(engine)?.get(id)?.final ?? '' })) });
    }
  }

  return { prefer, key };
}

export function buildReport(dir: string, items: readonly SampleItem[], glossary: Glossary): BakeoffReport {
  const records = new Map<string, Map<string, BakeoffRecord>>();
  for (const p of PROFILES) {
    const list = readJsonl<BakeoffRecord>(join(dir, `${p.id}.jsonl`));
    if (list.length !== items.length) {
      throw new Error(`${p.id} 기록이 ${String(list.length)}개입니다(표본 ${String(items.length)}개).`);
    }
    records.set(p.id, new Map(list.map((r) => [r.id, r])));
  }
  const { key, excluded } = JSON.parse(readFileSync(join(dir, 'judge-key.json'), 'utf8')) as { key: JudgeKey; excluded: { engine: string; id: string }[] };
  const verdicts = loadVerdicts(dir);
  const penalties = itemPenalties(verdicts, key, excluded);
  const engines = PROFILES.map((p) => p.id);
  const scored: ScoredItem[] = items.map((item) => ({
    id: item.id,
    stratum: item.stratum,
    words: sourceWords(item.source),
    penalty: Object.fromEntries(engines.map((engine) => {
      const found = penalties.get(engine)?.get(item.id);
      if (found === undefined) {
        throw new Error(`${engine}의 ${item.id} 판정이 없습니다.`);
      }

      return [engine, found.penalty];
    })),
  }));
  const scores = stratumScores(scored, engines);
  const best = [...engines].sort((a, b) => (scores.overall[a] ?? 0) - (scores.overall[b] ?? 0))[0] ?? engines[0] ?? '';
  const totalWords = scored.reduce((sum, item) => sum + item.words, 0);
  const criticals: CriticalCase[] = [];
  const reports = PROFILES.map((p): EngineReport => {
    const list = [...(records.get(p.id)?.values() ?? [])];
    const requests = readJsonl<RequestLog>(join(dir, `${p.id}.requests.jsonl`));
    const runLog = existsSync(join(dir, `${p.id}.run.log`)) ? readFileSync(join(dir, `${p.id}.run.log`), 'utf8') : '';
    const byItem = penalties.get(p.id) ?? new Map<string, ItemPenalty>();
    let majors = 0;
    let confirmed = 0;
    for (const [id, penalty] of byItem) {
      majors += penalty.majors;
      confirmed += penalty.criticals;
      if (penalty.criticals > 0) {
        const notes = verdicts.filter((v) => v.id === id && key[`${String(v.pass)}:${id}`]?.[v.label] === p.id).flatMap((v) => v.errors.filter((e) => e.severity === 'critical').map((e) => `${String(v.pass)}회차: ${e.note}`));
        criticals.push({ engine: p.id, id, source: records.get(p.id)?.get(id)?.source ?? '', text: records.get(p.id)?.get(id)?.final ?? '', notes });
      }
    }
    const markupErrors = verdicts.filter((v) => key[`${String(v.pass)}:${v.id}`]?.[v.label] === p.id).reduce((sum, v) => sum + v.errors.filter((e) => e.category === 'markup').length, 0) / 2;
    const speeds = requests.map((r) => r.tokensPerSecond).filter((s): s is number => s !== undefined);

    return {
      profile: p,
      reliability: reliability(list, requests, runLog),
      soft: softSummary(list, glossary),
      perHundredWords: scores.overall[p.id] ?? 0,
      byStratum: Object.fromEntries(STRATA.map((s) => [s, scores.byStratum[s]?.[p.id] ?? 0])),
      versusBest: p.id === best ? { estimate: 0, low: 0, high: 0 } : bootstrapDifference(scored, p.id, best, 2000, `bakeoff:${p.id}`),
      majorsPerHundredWords: (majors / totalWords) * 100,
      confirmedCriticals: confirmed,
      markupErrors,
      ...(speeds.length === 0 ? {} : { tokensPerSecond: speeds.reduce((a, b) => a + b, 0) / speeds.length }),
    };
  });
  const { prefer, key: preferKey } = preferSet(items, records);

  return { engines: reports, best, agreement: passAgreement(verdicts, key), criticals, prefer, preferKey };
}

const fixed = (value: number, digits = 1): string => value.toFixed(digits);
const percent = (ok: number, total: number): string => (total === 0 ? '-' : `${fixed((ok / total) * 100)}%`);

function minutes(ms: number): string {
  return ms >= 60_000 ? `${fixed(ms / 60_000)}분` : `${fixed(ms / 1000)}초`;
}

/** 보고서에 붙일 표(마크다운). 감점은 원문 100단어당, 낮을수록 좋다 */
export function renderTables(report: BakeoffReport): string {
  const lines: string[] = [];
  const row = (cells: readonly string[]): void => {
    lines.push(`| ${cells.join(' | ')} |`);
  };
  const header = (cells: readonly string[]): void => {
    row(cells);
    row(cells.map(() => '---'));
  };

  lines.push('### 품질(심판 MQM-lite, 원문 100단어당 감점 · 낮을수록 좋음)', '');
  header(['엔진', '감점/100단어', `최선(${report.best}) 대비 차이 [95% 구간]`, '중대/100단어', '확정 치명', '마크업·조사 오류', ...STRATA]);
  for (const e of report.engines) {
    const ci = e.profile.id === report.best ? '기준' : `${fixed(e.versusBest.estimate)} [${fixed(e.versusBest.low)}, ${fixed(e.versusBest.high)}]`;
    row([e.profile.label, fixed(e.perHundredWords), ci, fixed(e.majorsPerHundredWords), String(e.confirmedCriticals), fixed(e.markupErrors), ...STRATA.map((s) => fixed(e.byStratum[s] ?? 0))]);
  }
  lines.push('', `심판 일관성: 두 회차가 "중대 이상 오류 있음"을 같게 판정한 비율 ${percent(report.agreement.agree, report.agreement.pairs)} (${String(report.agreement.pairs)}쌍)`, '');

  lines.push('### 신뢰성(100개)', '');
  header(['엔진', '요청', '일시 오류(재시도로 넘김)', '최종 실패 요청', 'JSON 해석 실패', '첫 시도 문제 항목', '재요청 항목', '폴백(API/출력/혼합)']);
  for (const e of report.engines) {
    const r = e.reliability;
    const waits = Object.entries(r.waits).map(([k, n]) => `${k} ${String(n)}`).join(', ') || '0';
    const failed = Object.entries(r.failedRequests).map(([k, n]) => `${k} ${String(n)}`).join(', ') || '0';
    row([e.profile.label, String(r.requests), waits, failed, String(r.unparsedResponses), String(r.firstAttemptIssueItems), String(r.retriedItems), `${String(r.fallbacks)} (${String(r.fallbackCauses.api)}/${String(r.fallbackCauses.output)}/${String(r.fallbackCauses.mixed)})`]);
  }

  lines.push('', '### 소프트 지표(폴백 제외)', '');
  header(['엔진', '용어 준수', '영어 잔존 항목', '문장 합니다체', '라벨 명사형', '라벨 과길이']);
  for (const e of report.engines) {
    const s = e.soft;
    row([e.profile.label, percent(s.termTotal - s.termMissing, s.termTotal), String(s.residueItems), percent(s.formal.ok, s.formal.total), percent(s.noun.ok, s.noun.total), String(s.tooLong)]);
  }

  lines.push('', '### 속도·운영 추정', '');
  header(['엔진', '100개 시간', 'tok/s', '입력·출력(·사고) 토큰', `전체 ${String(FULL_KEYS)}키`, `증분 ${String(INCREMENT_KEYS)}키`, '전체에 필요한 요청(하루 한도)']);
  for (const e of report.engines) {
    const r = e.reliability;
    const limit = API_DAILY_LIMIT[e.profile.id];
    const fullRequests = Math.ceil((r.requests / 100) * FULL_KEYS);
    const api = limit === undefined ? '로컬' : `${String(fullRequests)}회 (${String(limit)}/일 → ${String(Math.ceil(fullRequests / limit))}일)`;
    row([
      e.profile.label,
      minutes(r.totalMs),
      e.tokensPerSecond === undefined ? '-' : fixed(e.tokensPerSecond),
      `${String(r.tokensIn)}·${String(r.tokensOut)}${r.tokensThinking > 0 ? `·${String(r.tokensThinking)}` : ''}`,
      minutes((r.totalMs / 100) * FULL_KEYS),
      minutes((r.totalMs / 100) * INCREMENT_KEYS),
      api,
    ]);
  }

  if (report.criticals.length > 0) {
    lines.push('', '### 두 회차가 모두 단 치명 오류(사용자 확인 전에는 탈락 사유로 쓰지 않음)', '');
    for (const c of report.criticals) {
      lines.push(`- ${c.engine} · ${c.id}: "${c.source}" → "${c.text}"`, ...c.notes.map((n) => `  - ${n}`));
    }
  }

  return `${lines.join('\n')}\n`;
}
