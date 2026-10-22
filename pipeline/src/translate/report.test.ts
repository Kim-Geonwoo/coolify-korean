import { describe, expect, it } from 'vitest';
import type { BakeoffRecord, RequestLog } from './bakeoff.ts';
import { parseGlossary } from './glossary.ts';
import { passAgreement, reliability, softSummary } from './report.ts';
import type { JudgeKey, JudgeVerdict } from './judge.ts';

const glossary = parseGlossary({ terms: [{ en: 'Server', ko: '서버' }, { en: 'Registry', ko: '레지스트리' }], brands: [] });

function record(id: string, source: string, attempts: string[][], extra: Partial<BakeoffRecord> = {}): BakeoffRecord {
  return {
    engine: 'e',
    id,
    key: source,
    stratum: 'representative',
    kind: 'text',
    file: 'f',
    source,
    masked: source,
    attempts: attempts.map((issues) => ({ raw: null, issues: issues as BakeoffRecord['attempts'][number]['issues'] })),
    final: source,
    fallback: false,
    soft: null,
    ...extra,
  };
}

describe('reliability', () => {
  it('splits fallbacks into API, output and mixed causes and counts waits from the run log', () => {
    const records = [
      record('a', 'x', [[]]),
      record('b', 'x', [['placeholder-mismatch'], []]),
      record('c', 'x', [['request-failed'], ['request-failed']], { fallback: true }),
      record('d', 'x', [['parse-failed'], ['tag-structure']], { fallback: true }),
      record('e', 'x', [['parse-failed'], ['request-failed']], { fallback: true }),
    ];
    const requests: RequestLog[] = [
      { batch: 0, ids: ['a'], retry: false, ms: 1000, finish: 'STOP', usage: { input: 10, output: 5 } },
      { batch: 0, ids: ['b'], retry: true, ms: 500, error: 'server: HTTP 500' },
      { batch: 0, ids: ['c'], retry: true, ms: 500, finish: 'STOP', unparsed: '{' },
    ];
    const log = 'server: 5초 기다립니다\nserver: 15초 기다립니다\nrate-limit: 30초 기다립니다\n묶음 1';

    expect(reliability(records, requests, log)).toEqual({
      requests: 3,
      failedRequests: { server: 1 },
      waits: { server: 2, 'rate-limit': 1 },
      unparsedResponses: 1,
      firstAttemptIssueItems: 4,
      issueCounts: { 'placeholder-mismatch': 1, 'request-failed': 1, 'parse-failed': 2 },
      retriedItems: 4,
      fallbacks: 3,
      fallbackCauses: { api: 1, output: 1, mixed: 1 },
      totalMs: 2000,
      tokensIn: 10,
      tokensOut: 5,
      tokensThinking: 0,
    });
  });
});

describe('softSummary', () => {
  it('counts glossary terms outside placeholder names and the ending checks', () => {
    const records = [
      record('a', 'Restart the server.', [[]], { soft: { glossaryMissing: [], englishResidue: [], tooLong: false, formalEnding: true } }),
      record('b', 'Log in to :registry', [[]], { soft: { glossaryMissing: [], englishResidue: ['log'], tooLong: false, nounLabel: false } }),
      record('c', 'Server Registry', [[]], { soft: { glossaryMissing: ['Registry'], englishResidue: [], tooLong: true, nounLabel: true } }),
    ];

    expect(softSummary(records, glossary)).toEqual({ termTotal: 3, termMissing: 1, residueItems: 1, residueWords: 1, formal: { ok: 1, total: 1 }, noun: { ok: 1, total: 2 }, tooLong: 1 });
  });
});

describe('passAgreement', () => {
  it('measures how often both passes agree that a candidate has a major or worse error', () => {
    const key: JudgeKey = { '1:a': { A: 'e1', B: 'e2' }, '2:a': { A: 'e2', B: 'e1' } };
    const verdicts: JudgeVerdict[] = [
      { pass: 1, id: 'a', label: 'A', errors: [{ severity: 'major', category: 'accuracy', note: '' }] },
      { pass: 1, id: 'a', label: 'B', errors: [] },
      { pass: 2, id: 'a', label: 'B', errors: [{ severity: 'critical', category: 'accuracy', note: '' }] },
      { pass: 2, id: 'a', label: 'A', errors: [{ severity: 'major', category: 'style', note: '' }] }, // e2: 1회차 없음, 2회차 중대 → 엇갈림
    ];

    expect(passAgreement(verdicts, key)).toEqual({ pairs: 2, agree: 1 });
  });
});
