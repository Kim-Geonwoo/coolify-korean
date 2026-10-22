import type { BakeoffRecord, RequestLog } from './bakeoff.ts';
import { termsIn, type Glossary } from './glossary.ts';
import type { JudgeKey, JudgeVerdict } from './judge.ts';
import { placeholderNames, withoutPlaceholders } from './masking.ts';

export interface Reliability {
  readonly requests: number;
  /** 재시도 끝에도 실패한 요청, 종류별 */
  readonly failedRequests: Readonly<Record<string, number>>;
  /** 재시도로 넘긴 일시 오류(분당 한도·서버 오류 등), 종류별. 실행 로그의 "…초 기다립니다" 줄 */
  readonly waits: Readonly<Record<string, number>>;
  readonly unparsedResponses: number;
  /** 첫 요청에서 하드 검사·해석·요청 실패에 걸린 항목 수 */
  readonly firstAttemptIssueItems: number;
  readonly issueCounts: Readonly<Record<string, number>>;
  readonly retriedItems: number;
  readonly fallbacks: number;
  /** api: 모든 시도가 요청 실패, output: 요청은 됐지만 출력이 검사에 걸림, mixed: 둘 다 */
  readonly fallbackCauses: { readonly api: number; readonly output: number; readonly mixed: number };
  readonly totalMs: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly tokensThinking: number;
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

export function reliability(records: readonly BakeoffRecord[], requests: readonly RequestLog[], runLog: string): Reliability {
  const failedRequests: Record<string, number> = {};
  for (const request of requests) {
    if (request.error !== undefined) {
      bump(failedRequests, request.error.split(':')[0] ?? 'unknown');
    }
  }
  const waits: Record<string, number> = {};
  for (const match of runLog.matchAll(/^([a-z-]+): \d+초 기다립니다$/gm)) {
    bump(waits, match[1] ?? 'unknown');
  }
  const issueCounts: Record<string, number> = {};
  let firstAttemptIssueItems = 0;
  const causes = { api: 0, output: 0, mixed: 0 };
  for (const record of records) {
    const first = record.attempts[0]?.issues ?? [];
    if (first.length > 0) {
      firstAttemptIssueItems++;
    }
    for (const issue of first) {
      bump(issueCounts, issue);
    }
    if (record.fallback) {
      const failed = record.attempts.map((a) => a.issues.includes('request-failed'));
      if (failed.every(Boolean)) {
        causes.api++;
      } else if (failed.some(Boolean)) {
        causes.mixed++;
      } else {
        causes.output++;
      }
    }
  }

  return {
    requests: requests.length,
    failedRequests,
    waits,
    unparsedResponses: requests.filter((r) => r.unparsed !== undefined).length,
    firstAttemptIssueItems,
    issueCounts,
    retriedItems: records.filter((r) => r.attempts.length > 1).length,
    fallbacks: records.filter((r) => r.fallback).length,
    fallbackCauses: causes,
    totalMs: requests.reduce((sum, r) => sum + r.ms, 0),
    tokensIn: requests.reduce((sum, r) => sum + (r.usage?.input ?? 0), 0),
    tokensOut: requests.reduce((sum, r) => sum + (r.usage?.output ?? 0), 0),
    tokensThinking: requests.reduce((sum, r) => sum + (r.usage?.thinking ?? 0), 0),
  };
}

export interface SoftSummary {
  readonly termTotal: number;
  readonly termMissing: number;
  readonly residueItems: number;
  readonly residueWords: number;
  readonly formal: { readonly ok: number; readonly total: number };
  readonly noun: { readonly ok: number; readonly total: number };
  readonly tooLong: number;
}

/** 폴백이 아닌 항목의 소프트 지표 합계. 용어 수는 자리표시자 이름을 뺀 원문에서 센다 */
export function softSummary(records: readonly BakeoffRecord[], glossary: Glossary): SoftSummary {
  const out = { termTotal: 0, termMissing: 0, residueItems: 0, residueWords: 0, formal: { ok: 0, total: 0 }, noun: { ok: 0, total: 0 }, tooLong: 0 };
  for (const record of records) {
    const soft = record.soft;
    if (record.fallback || soft === null) {
      continue;
    }
    out.termTotal += termsIn(withoutPlaceholders(record.source, placeholderNames(record.source, [])), glossary).length;
    out.termMissing += soft.glossaryMissing.length;
    out.residueItems += soft.englishResidue.length > 0 ? 1 : 0;
    out.residueWords += soft.englishResidue.length;
    if (soft.formalEnding !== undefined) {
      out.formal.total++;
      out.formal.ok += soft.formalEnding ? 1 : 0;
    }
    if (soft.nounLabel !== undefined) {
      out.noun.total++;
      out.noun.ok += soft.nounLabel ? 1 : 0;
    }
    out.tooLong += soft.tooLong ? 1 : 0;
  }

  return out;
}

/** 두 회차가 같은 후보에 "중대 이상 오류 있음"을 똑같이 판정한 비율(심판 일관성) */
export function passAgreement(verdicts: readonly JudgeVerdict[], key: JudgeKey): { pairs: number; agree: number } {
  const flags = new Map<string, Map<number, boolean>>();
  for (const verdict of verdicts) {
    const engine = key[`${String(verdict.pass)}:${verdict.id}`]?.[verdict.label];
    if (engine === undefined) {
      continue;
    }
    const pair = `${engine}:${verdict.id}`;
    const byPass = flags.get(pair) ?? new Map<number, boolean>();
    flags.set(pair, byPass);
    byPass.set(verdict.pass, verdict.errors.some((e) => e.severity !== 'minor'));
  }
  let pairs = 0;
  let agree = 0;
  for (const byPass of flags.values()) {
    const values = [...byPass.values()];
    if (values.length < 2) {
      continue;
    }
    pairs++;
    agree += values.every((v) => v === values[0]) ? 1 : 0;
  }

  return { pairs, agree };
}

/** 원문 영어 단어 수(번호 태그·자리표시자 제외, 최소 1) */
export function sourceWords(source: string): number {
  return Math.max(1, source.replace(/<\/?\d+\/?>/g, ' ').split(/\s+/).filter((w) => /[A-Za-z]/.test(w) && !/^:[A-Za-z_]/.test(w)).length);
}
