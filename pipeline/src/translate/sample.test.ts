import { describe, expect, it } from 'vitest';
import { parseGlossary } from './glossary.ts';
import { drawSample, type CatalogEntry } from './sample.ts';

const glossary = parseGlossary({ terms: [{ en: 'Server', ko: '서버' }, { en: 'Deploy', ko: '배포' }], brands: ['Docker', 'GitHub'] });

function entry(english: string, kind: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return { english, markup: false, kinds: [kind], placeholders: [], occurrences: [{ file: `resources/views/${kind}.blade.php`, line: 1, kind }], ...extra };
}

function catalog(): Record<string, CatalogEntry> {
  const out: Record<string, CatalogEntry> = {};
  for (let n = 0; n < 80; n++) {
    const text = `Restart number ${String(n)} before you change the server settings.`;
    out[text] = entry(text, n % 3 === 0 ? 'toast' : 'text');
  }
  for (let n = 0; n < 30; n++) {
    out[`Server ${String(n)}`] = entry(`Server ${String(n)}`, 'text');
    out[`Plain ${String(n)}`] = entry(`Plain ${String(n)}`, 'text');
  }
  for (let n = 0; n < 30; n++) {
    const text = n < 5 ? `Copy :name to :Name ${String(n)}` : `Delete :name number ${String(n)}?`;
    out[text] = entry(text, 'toast', { placeholders: ['name'] });
  }
  for (let n = 0; n < 25; n++) {
    const text = `Read <0>the guide ${String(n)}</0> first.<1/>`;
    out[text] = entry(text, 'prop-html', { markup: true });
  }
  for (let n = 0; n < 10; n++) {
    const text = `This is a long helper text number ${String(n)} that explains how every part of the deployment works in detail.`;
    out[text] = entry(text, 'prop-html');
  }
  for (let n = 0; n < 10; n++) {
    const text = `See https://coolify.io/docs/${String(n)} for GitHub setup`;
    out[text] = entry(text, 'text');
  }
  out['auth.throttle'] = entry('Too many login attempts. Please try again in :seconds seconds.', 'upstream-lang', { occurrences: [] });
  out['Added :key as {{vault.:key}}.'] = entry('Added :key as {{vault.:key}}.', 'toast', { placeholders: ['key'] });

  return out;
}

describe('drawSample', () => {
  it('draws 100 items in fixed strata and the same items every time', () => {
    const first = drawSample(catalog(), glossary);
    const second = drawSample(catalog(), glossary);
    const sizes = Object.fromEntries(['representative', 'label', 'placeholder', 'tag', 'long', 'edge'].map((s) => [s, first.filter((i) => i.stratum === s).length]));

    expect(first).toHaveLength(100);
    expect(sizes).toEqual({ representative: 40, label: 15, placeholder: 20, tag: 15, long: 5, edge: 5 });
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(new Set(first.map((i) => i.key)).size).toBe(100);
  });

  it('puts glossary words in labels, case variants first in placeholders, and upstream keys in edge', () => {
    const items = drawSample(catalog(), glossary);

    expect(items.filter((i) => i.stratum === 'label').every((i) => i.source.startsWith('Server'))).toBe(true);
    expect(items.filter((i) => i.stratum === 'placeholder').filter((i) => i.source.includes(':Name'))).toHaveLength(5);
    const throttle = items.find((i) => i.key === 'auth.throttle');
    expect(throttle?.stratum).toBe('edge');
    expect(throttle?.source).toBe('Too many login attempts. Please try again in :seconds seconds.');
    expect(throttle?.file).toBe('lang/en.json');
  });

  it('draws a fresh sample that skips earlier keys and adds verb-first helper texts', () => {
    const base = catalog();
    for (const [n, verb] of ['Notify the team', 'Uses the backup timezone', 'Drops each collection'].entries()) {
      const text = `${verb} when the server ${String(n)} restarts at night.`;
      base[text] = entry(text, 'prop-html');
    }
    const exclude = new Set(drawSample(catalog(), glossary).map((i) => i.key));
    const fresh = drawSample(base, glossary, { exclude, strata: [['directive', 3], ['representative', 5]] });

    expect(fresh.filter((i) => exclude.has(i.key))).toEqual([]);
    expect(fresh.filter((i) => i.stratum === 'directive').map((i) => i.source.split(' ')[0]).sort()).toEqual(['Drops', 'Notify', 'Uses']);
    expect(fresh.filter((i) => i.stratum === 'representative')).toHaveLength(5);
  });

  it('skips keys that already contain token braces', () => {
    expect(drawSample(catalog(), glossary).some((i) => i.source.includes('{{'))).toBe(false);
  });
});
