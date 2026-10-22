import { describe, expect, it } from 'vitest';
import { parseLoadedId, parsePushDigest, pushDecision, recordPublished, remoteIssues } from './push.ts';
import type { PublishedLedger } from './ledger.ts';

const index = `sha256:${'a'.repeat(64)}`;
const other = `sha256:${'b'.repeat(64)}`;

describe('parsing docker output', () => {
  it('reads the loaded image index and the pushed digest', () => {
    expect(parseLoadedId(`Loaded image ID: ${index}\n`)).toBe(index);
    expect(parsePushDigest(`37e291648df3: Pushed\n4.4.6: digest: ${index} size: 1611\n`)).toBe(index);
  });

  it('refuses output without a digest', () => {
    expect(() => parseLoadedId('Loaded image: coolify-ko:test\n')).toThrow();
    expect(() => parsePushDigest('denied: permission_denied\n')).toThrow();
  });
});

describe('pushDecision', () => {
  it('pushes a version tag that does not exist yet', () => {
    expect(pushDecision(undefined, index)).toBe('push');
  });

  it('does nothing when the same image is already there', () => {
    expect(pushDecision(index, index)).toBe('already');
  });

  it('never moves a published version tag to other content', () => {
    expect(pushDecision(other, index)).toBe('conflict');
  });
});

describe('remoteIssues', () => {
  const platforms = { 'linux/amd64': { manifest: `sha256:${'1'.repeat(64)}`, config: `sha256:${'2'.repeat(64)}` }, 'linux/arm64': { manifest: `sha256:${'3'.repeat(64)}`, config: `sha256:${'4'.repeat(64)}` } };
  const remote = {
    manifests: [
      { digest: platforms['linux/amd64'].manifest, platform: { os: 'linux', architecture: 'amd64' } },
      { digest: platforms['linux/arm64'].manifest, platform: { os: 'linux', architecture: 'arm64' } },
      { digest: `sha256:${'5'.repeat(64)}`, platform: { os: 'unknown', architecture: 'unknown' }, annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': platforms['linux/amd64'].manifest } },
    ],
  };

  it('accepts a registry index that holds the verified platform manifests', () => {
    expect(remoteIssues(remote, platforms)).toEqual([]);
  });

  it('reports a platform manifest that differs from the verified one', () => {
    const changed = { manifests: [remote.manifests[0], { ...remote.manifests[1], digest: `sha256:${'9'.repeat(64)}` }] };

    expect(remoteIssues(changed, platforms)).toEqual(['linux/arm64: 레지스트리 manifest가 검증한 것과 다름']);
  });
});

describe('recordPublished', () => {
  const empty: PublishedLedger = { schema: 1, versions: {} };

  it('adds the Korean build with its commit and index', () => {
    const next = recordPublished(empty, { version: '4.4.6', kind: 'ko', index, commit: 'c'.repeat(40), at: new Date('2026-10-20T00:00:00.000Z') });

    expect(next.versions['4.4.6']).toEqual({ kind: 'ko', index, commit: 'c'.repeat(40), publishedAt: '2026-10-20T00:00:00.000Z' });
  });

  it('never rewrites a version that is already recorded', () => {
    const once = recordPublished(empty, { version: '4.4.6', kind: 'ko', index, commit: 'c'.repeat(40), at: new Date() });

    expect(() => recordPublished(once, { version: '4.4.6', kind: 'ko', index: other, commit: 'c'.repeat(40), at: new Date() })).toThrow();
  });
});
