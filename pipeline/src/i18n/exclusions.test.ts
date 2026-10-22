import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExclusions, parseExclusions } from './exclusions.ts';

const root = join(import.meta.dirname, '..', '..', '..');

describe('exclusions', () => {
  it('reads keys with a reason for each', () => {
    expect(parseExclusions({ keys: { '2xx': 'HTTP 상태 묶음' } })).toEqual(new Map([['2xx', 'HTTP 상태 묶음']]));
  });

  it('rejects entries without a reason and other shapes', () => {
    expect(() => parseExclusions({ keys: { '2xx': '' } })).toThrow(/2xx/);
    expect(() => parseExclusions({ keys: ['2xx'] })).toThrow();
    expect(() => parseExclusions(null)).toThrow();
  });

  it('only lists keys the catalog has', () => {
    const exclusions = loadExclusions(join(root, 'i18n', 'exclude.json'));
    const catalog = JSON.parse(readFileSync(join(root, 'i18n', 'catalog.json'), 'utf8')) as { keys: Record<string, unknown> };

    expect([...exclusions.keys()].filter((key) => !(key in catalog.keys))).toEqual([]);
  });
});
