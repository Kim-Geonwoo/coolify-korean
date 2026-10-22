import { describe, expect, it } from 'vitest';
import type { BakeoffRecord } from './bakeoff.ts';
import { parseGlossary } from './glossary.ts';
import { blindBatches, parseJudgeResult, shuffle, type JudgeBatch } from './judge.ts';
import type { SampleItem } from './sample.ts';

const glossary = parseGlossary({ terms: [{ en: 'Server', ko: '서버' }, { en: 'Registry', ko: '레지스트리' }], brands: [] });

function item(id: string, source: string, placeholders: string[] = []): SampleItem {
  return { id, key: source, source, kind: 'text', file: 'x.blade.php', placeholders, markup: false, stratum: 'representative' };
}

function record(engine: string, it: SampleItem, final: string, fallback = false): BakeoffRecord {
  return { engine, id: it.id, key: it.key, stratum: it.stratum, kind: it.kind, file: it.file, source: it.source, masked: it.source, attempts: [], final, fallback, soft: null };
}

const items = [item('aa', 'Restart the server.'), item('bb', 'Log in to :registry', ['registry']), item('cc', 'Save')];
const engines = ['e1', 'e2', 'e3'];

function recordsOf(fallbackFor?: [string, string]): Map<string, Map<string, BakeoffRecord>> {
  return new Map(engines.map((engine) => [engine, new Map(items.map((it) => [it.id, record(engine, it, `${engine}:${it.id}`, fallbackFor?.[0] === engine && fallbackFor[1] === it.id)]))]));
}

describe('shuffle', () => {
  it('is a deterministic permutation that depends on the seed', () => {
    const values = ['a', 'b', 'c', 'd', 'e', 'f'];

    expect(shuffle(values, 's1')).toEqual(shuffle(values, 's1'));
    expect([...shuffle(values, 's1')].sort()).toEqual(values);
    expect(['s1', 's2', 's3', 's4'].map((s) => shuffle(values, s).join('')).some((order) => order !== shuffle(values, 's1').join(''))).toBe(true);
  });
});

describe('blindBatches', () => {
  it('hides engine names behind per-item labels, twice with different orders', () => {
    const { batches, key } = blindBatches(items, recordsOf(), glossary, { passes: 2, batchSize: 2 });

    expect(batches.map((b) => [b.pass, b.items.length])).toEqual([[1, 2], [1, 1], [2, 2], [2, 1]]);
    const text = JSON.stringify(batches);
    for (const engine of engines) {
      expect(text).not.toContain(`"${engine}"`);
    }
    for (const pass of [1, 2]) {
      for (const it of items) {
        const shown = batches.filter((b) => b.pass === pass).flatMap((b) => b.items).find((x) => x.id === it.id);
        expect(shown?.candidates.map((c) => c.label)).toEqual(['A', 'B', 'C']);
        for (const candidate of shown?.candidates ?? []) {
          expect(candidate.text).toBe(`${key[`${String(pass)}:${it.id}`]?.[candidate.label] ?? '?'}:${it.id}`);
        }
      }
    }
  });

  it('lists only glossary terms outside placeholder names', () => {
    const { batches } = blindBatches(items, recordsOf(), glossary, { passes: 1, batchSize: 10 });
    const terms = Object.fromEntries((batches[0]?.items ?? []).map((x) => [x.id, x.terms]));

    expect(terms).toEqual({ aa: ['Server → 서버'], bb: [], cc: [] });
  });

  it('leaves English fallbacks out of judging and says which', () => {
    const { batches, excluded } = blindBatches(items, recordsOf(['e2', 'bb']), glossary, { passes: 1, batchSize: 10 });

    expect(excluded).toEqual([{ engine: 'e2', id: 'bb' }]);
    expect(batches[0]?.items.find((x) => x.id === 'bb')?.candidates).toHaveLength(2);
  });

  it('refuses incomplete runs', () => {
    const records = recordsOf();
    records.get('e3')?.delete('cc');

    expect(() => blindBatches(items, records, glossary, { passes: 1, batchSize: 10 })).toThrow(/e3/);
  });
});

describe('parseJudgeResult', () => {
  const batch: JudgeBatch = {
    pass: 1,
    batch: 1,
    items: [
      { id: 'aa', kind: 'text', file: 'x', source: 's', terms: [], candidates: [{ label: 'A', text: 'x' }, { label: 'B', text: 'y' }] },
      { id: 'bb', kind: 'text', file: 'x', source: 's', terms: [], candidates: [{ label: 'A', text: 'x' }] },
    ],
  };

  it('reads verdicts for every item and label', () => {
    const json = JSON.stringify({
      items: [
        { id: 'aa', candidates: [{ label: 'A', errors: [] }, { label: 'B', errors: [{ severity: 'major', category: 'accuracy', note: '뜻이 다름' }] }] },
        { id: 'bb', candidates: [{ label: 'A', errors: [{ severity: 'minor', category: 'style', note: '어색함' }] }] },
      ],
    });

    expect(parseJudgeResult(json, batch).map((v) => [v.id, v.label, v.errors.map((e) => e.severity)])).toEqual([
      ['aa', 'A', []],
      ['aa', 'B', ['major']],
      ['bb', 'A', ['minor']],
    ]);
  });

  it('rejects missing items, missing labels and unknown severities', () => {
    const missingItem = JSON.stringify({ items: [{ id: 'aa', candidates: [{ label: 'A', errors: [] }, { label: 'B', errors: [] }] }] });
    const missingLabel = JSON.stringify({ items: [{ id: 'aa', candidates: [{ label: 'A', errors: [] }] }, { id: 'bb', candidates: [{ label: 'A', errors: [] }] }] });
    const badSeverity = JSON.stringify({ items: [{ id: 'aa', candidates: [{ label: 'A', errors: [{ severity: 'huge', category: 'x', note: 'y' }] }, { label: 'B', errors: [] }] }, { id: 'bb', candidates: [{ label: 'A', errors: [] }] }] });

    expect(() => parseJudgeResult(missingItem, batch)).toThrow(/bb/);
    expect(() => parseJudgeResult(missingLabel, batch)).toThrow(/aa.*B/);
    expect(() => parseJudgeResult(badSeverity, batch)).toThrow(/huge/);
  });
});
