import { describe, expect, it } from 'vitest';
import { decideCandidate, PUBLISH_LAG_MS } from './candidates.ts';
import type { PublishedLedger } from './ledger.ts';

const seenAt = '2026-10-20T00:00:00.000Z';
const at = (ms: number): Date => new Date(Date.parse(seenAt) + ms);
const HOUR = 60 * 60_000;
const none: PublishedLedger = { schema: 1, versions: {} };
const commit = 'c'.repeat(40);
const input = {
  upstream: { version: '4.4.7', seenAt },
  dev: { version: '4.4.7', commit, gates: 'passed' as const },
  hooksOk: true,
  published: none,
  now: at(HOUR),
};

describe('decideCandidate', () => {
  it('waits two days for the Korean build before falling back to the official image', () => {
    expect(PUBLISH_LAG_MS).toBe(2 * 24 * HOUR);
  });

  it('does nothing once the version is published', () => {
    const published: PublishedLedger = { schema: 1, versions: { '4.4.7': { kind: 'ko', index: `sha256:${'a'.repeat(64)}`, commit, publishedAt: seenAt } } };

    expect(decideCandidate({ ...input, published })).toEqual({ kind: 'none', reason: 'published' });
  });

  it('holds everything while the upstream install hooks look different', () => {
    expect(decideCandidate({ ...input, hooksOk: false, now: at(3 * 24 * HOUR) })).toEqual({ kind: 'none', reason: 'hooks' });
  });

  it('offers the Korean build when dev is on the new version and the gates passed', () => {
    expect(decideCandidate(input)).toEqual({ kind: 'ko', version: '4.4.7', commit });
  });

  it('reports failing gates while there is still time', () => {
    expect(decideCandidate({ ...input, dev: { ...input.dev, gates: 'failed' }, now: at(24 * HOUR) })).toEqual({ kind: 'none', reason: 'gates' });
  });

  it('falls back to the official image when the gates still fail after two days', () => {
    expect(decideCandidate({ ...input, dev: { ...input.dev, gates: 'failed' }, now: at(2 * 24 * HOUR) })).toEqual({ kind: 'passthrough', version: '4.4.7' });
  });

  it('waits while dev has not caught up and the delay is not over', () => {
    expect(decideCandidate({ ...input, dev: { ...input.dev, version: '4.4.6' }, now: at(2 * 24 * HOUR - 60_000) })).toEqual({ kind: 'none', reason: 'waiting' });
  });

  it('falls back exactly when the delay is over', () => {
    expect(decideCandidate({ ...input, dev: { ...input.dev, version: '4.4.6' }, now: at(2 * 24 * HOUR) })).toEqual({ kind: 'passthrough', version: '4.4.7' });
  });

  it('treats unknown gates like waiting', () => {
    expect(decideCandidate({ ...input, dev: { ...input.dev, gates: 'unknown' } })).toEqual({ kind: 'none', reason: 'waiting' });
  });

  it('refuses an unreadable first-seen time instead of publishing early', () => {
    expect(() => decideCandidate({ ...input, upstream: { version: '4.4.7', seenAt: 'soon' }, dev: { ...input.dev, version: '4.4.6' } })).toThrow();
  });
});
