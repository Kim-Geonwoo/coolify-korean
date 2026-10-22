import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { latestPublished, parsePublished } from './ledger.ts';

const index = `sha256:${'a'.repeat(64)}`;
const ko = { kind: 'ko', index, commit: 'b'.repeat(40), publishedAt: '2026-10-20T00:00:00.000Z' };
const passthrough = { kind: 'passthrough', index, commit: null, publishedAt: '2026-10-22T00:00:00.000Z' };

describe('parsePublished', () => {
  it('reads the publication record', () => {
    expect(parsePublished({ schema: 1, versions: { '4.4.6': ko, '4.4.7': passthrough } }).versions['4.4.7']?.kind).toBe('passthrough');
  });

  it('reads the record in the repository', () => {
    const data = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', '..', 'releases', 'published.json'), 'utf8')) as unknown;

    expect(parsePublished(data).schema).toBe(1);
  });

  it.each([
    ['wrong schema', { schema: 2, versions: {} }],
    ['bad version', { schema: 1, versions: { '4.4': ko } }],
    ['bad index', { schema: 1, versions: { '4.4.6': { ...ko, index: 'sha256:xyz' } } }],
    ['Korean build without a commit', { schema: 1, versions: { '4.4.6': { ...ko, commit: null } } }],
    ['passthrough with a commit', { schema: 1, versions: { '4.4.6': { ...passthrough, commit: 'b'.repeat(40) } } }],
    ['unknown kind', { schema: 1, versions: { '4.4.6': { ...ko, kind: 'other' } } }],
    ['bad date', { schema: 1, versions: { '4.4.6': { ...ko, publishedAt: 'yesterday' } } }],
  ])('refuses %s', (_label, data) => {
    expect(() => parsePublished(data)).toThrow();
  });
});

describe('latestPublished', () => {
  it('orders versions numerically', () => {
    expect(latestPublished(parsePublished({ schema: 1, versions: { '4.4.9': ko, '4.4.10': passthrough } }))).toBe('4.4.10');
  });

  it('has nothing before the first publication', () => {
    expect(latestPublished({ schema: 1, versions: {} })).toBeUndefined();
  });
});
