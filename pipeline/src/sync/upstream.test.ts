import { describe, expect, it } from 'vitest';
import type { SyncState } from './state.ts';
import { checkUpstream, decideUpstream, parseHubTag, parseStableVersion } from './upstream.ts';

const D1 = `sha256:${'a'.repeat(64)}`;
const D2 = `sha256:${'b'.repeat(64)}`;
const current: SyncState = { upstream: { version: '4.4.6', image: 'docker.io/coollabsio/coolify', digest: D1 } };

describe('decideUpstream', () => {
  it('takes a newer stable version only when its release and image both exist', () => {
    expect(decideUpstream({ current, stable: '4.4.7', release: true, digest: D2 })).toEqual({ action: 'new', version: '4.4.7', digest: D2 });
    expect(decideUpstream({ current, stable: '4.4.7', release: false, digest: D2 })).toEqual({ action: 'wait', version: '4.4.7', reason: 'no-release' });
    expect(decideUpstream({ current, stable: '4.4.7', release: true, digest: undefined })).toEqual({ action: 'wait', version: '4.4.7', reason: 'no-image' });
    expect(decideUpstream({ current, stable: '4.10.0', release: true, digest: D2 })).toMatchObject({ action: 'new', version: '4.10.0' });
  });

  it('does nothing for the same version and stops when the version goes back or the same tag was rebuilt', () => {
    expect(decideUpstream({ current, stable: '4.4.6', release: true, digest: D1 })).toEqual({ action: 'same' });
    expect(decideUpstream({ current, stable: '4.4.6', release: true, digest: undefined })).toEqual({ action: 'same' });
    expect(decideUpstream({ current, stable: '4.4.6', release: true, digest: D2 })).toEqual({ action: 'stop', reason: 'digest-changed', detail: '4.4.6' });
    expect(decideUpstream({ current, stable: '4.4.5', release: true, digest: D2 })).toEqual({ action: 'stop', reason: 'regress', detail: '4.4.6 → 4.4.5' });
  });
});

describe('parsers', () => {
  it('reads the stable v4 version and refuses anything that is not x.y.z', () => {
    expect(parseStableVersion({ coolify: { v4: { version: '4.4.6' }, nightly: { version: '4.5-rc.1' } } })).toBe('4.4.6');
    expect(() => parseStableVersion({ coolify: { v4: { version: '4.5-rc.1' } } })).toThrow(/4\.5-rc\.1/);
    expect(() => parseStableVersion({})).toThrow();
  });

  it('reads a tag digest from Docker Hub and treats a missing tag as no image', () => {
    expect(parseHubTag({ name: '4.4.6', digest: D1 })).toBe(D1);
    expect(() => parseHubTag({ name: '4.4.6', digest: 'sha256:short' })).toThrow();
  });
});

describe('checkUpstream', () => {
  it('asks versions.json, the GitHub release and the Docker Hub tag with timeouts', async () => {
    const asked: string[] = [];
    const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
      asked.push(url);
      expect(init?.signal).toBeDefined();
      if (url.includes('versions.json')) {
        return Promise.resolve(Response.json({ coolify: { v4: { version: '4.4.7' } } }));
      }
      if (url.includes('api.github.com')) {
        return Promise.resolve(new Response('{}', { status: 200 }));
      }

      return Promise.resolve(new Response('{}', { status: 404 }));
    };

    expect(await checkUpstream(current, fetcher)).toEqual({ action: 'wait', version: '4.4.7', reason: 'no-image' });
    expect(asked).toEqual([
      'https://cdn.coollabs.io/coolify/versions.json',
      'https://api.github.com/repos/coollabsio/coolify/releases/tags/v4.4.7',
      'https://hub.docker.com/v2/repositories/coollabsio/coolify/tags/4.4.7',
    ]);
  });

  it('fails on unexpected HTTP errors instead of guessing', async () => {
    const fetcher = (): Promise<Response> => Promise.resolve(new Response('', { status: 503 }));

    await expect(checkUpstream(current, fetcher)).rejects.toThrow(/503/);
  });
});
