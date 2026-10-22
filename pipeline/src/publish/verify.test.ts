import { describe, expect, it } from 'vitest';
import { ALLOWED_PUBLIC_PATHS, configIssues, indexIssues, layerIssues, manifestIssues, overlayLayers } from './verify.ts';
import type { TarEntry } from './tar.ts';

// 공식 4.4.6처럼 /var/www 이하는 www-data(9999), 나머지는 root
const officialOwner = (path: string): number => (path.startsWith('var/www/') ? 9999 : 0);
const file = (path: string, type: TarEntry['type'] = 'file', mode = type === 'dir' ? 0o755 : 0o644, owner = officialOwner(path)): TarEntry => ({ path, type, size: 1, offset: 0, mode, uid: owner, gid: owner });

describe('layerIssues', () => {
  it('accepts files under the allowed paths and their parent directories', () => {
    const entries = [file('var/', 'dir'), file('var/www/html/', 'dir'), file('var/www/html/app/', 'dir'), file('var/www/html/app/Providers/CoolifyKoServiceProvider.php'), file('var/www/html/lang-default/ko.json'), file('usr/share/doc/coolify-ko/LICENSE')];

    expect(layerIssues(entries, ALLOWED_PUBLIC_PATHS)).toEqual([]);
  });

  it.each([
    ['a file outside the allowed paths', file('var/www/html/routes/web.php')],
    ['a symlink even inside them', file('var/www/html/app/x.php', 'symlink')],
    ['a hard link', file('var/www/html/app/y.php', 'hardlink')],
    ['a whiteout that deletes an official file', file('var/www/html/app/.wh.z.php')],
    ['a parent-directory escape', file('var/www/html/app/../../../etc/cron.d/x')],
    ['a device or fifo', file('var/www/html/app/fifo', 'other')],
    ['a file sitting on a parent directory path', file('var/www/html/index.php')],
    ['a setuid file', file('var/www/html/app/x.php', 'file', 0o4755)],
    ['a setgid file', file('var/www/html/app/x.php', 'file', 0o2755)],
    ['a world-writable file', file('var/www/html/lang-default/ko.json', 'file', 0o666)],
    ['a parent directory made world-writable', file('var/www/html/', 'dir', 0o777)],
    ['a group-writable file', file('var/www/html/app/x.php', 'file', 0o664)],
    ['a parent directory handed to root', file('var/www/html/', 'dir', 0o755, 0)],
    ['an app file owned by root', file('var/www/html/app/x.php', 'file', 0o644, 0)],
    ['a top directory handed to www-data', file('var/', 'dir', 0o755, 9999)],
    ['a license file owned by www-data', file('usr/share/doc/coolify-ko/LICENSE', 'file', 0o644, 9999)],
  ])('flags %s', (_label, entry) => {
    expect(layerIssues([entry], ALLOWED_PUBLIC_PATHS)).toHaveLength(1);
  });
});

const layer = (digest: string, mediaType = 'application/vnd.oci.image.layer.v1.tar+gzip'): { mediaType: string; digest: string; size: number } => ({ mediaType, digest: `sha256:${digest.repeat(64)}`, size: 1 });
const officialAmd = { layers: [layer('1'), layer('2')] };
const officialArm = { layers: [layer('3'), layer('4')] };
const official = new Map([
  ['linux/amd64', officialAmd],
  ['linux/arm64', officialArm],
] as const);
const ref = (digest: string, architecture: string, attestationOf?: string): Record<string, unknown> => ({
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
  digest: `sha256:${digest.repeat(64)}`,
  platform: attestationOf === undefined ? { os: 'linux', architecture } : { os: 'unknown', architecture: 'unknown' },
  ...(attestationOf === undefined ? {} : { annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': `sha256:${attestationOf.repeat(64)}` } }),
});
const goodIndex = { manifests: [ref('a', 'amd64'), ref('b', 'arm64'), ref('c', '', 'a'), ref('d', '', 'b')] };
const goodManifests = new Map<string, unknown>([
  [`sha256:${'a'.repeat(64)}`, { layers: [...officialAmd.layers, layer('5')] }],
  [`sha256:${'b'.repeat(64)}`, { layers: [...officialArm.layers, layer('6')] }],
]);

describe('indexIssues', () => {
  it('accepts both platforms built on the official layers', () => {
    expect(indexIssues({ index: goodIndex, manifests: goodManifests, official })).toEqual([]);
  });

  it('reports a missing platform', () => {
    expect(indexIssues({ index: { manifests: [ref('a', 'amd64')] }, manifests: goodManifests, official })).toEqual(['linux/arm64 없음']);
  });

  it('reports a platform that does not start from the official layers', () => {
    const manifests = new Map(goodManifests);
    manifests.set(`sha256:${'b'.repeat(64)}`, { layers: [layer('9'), layer('4'), layer('6')] });

    expect(indexIssues({ index: goodIndex, manifests, official })).toHaveLength(1);
  });

  it('reports a layer compressed with something other than gzip', () => {
    const manifests = new Map(goodManifests);
    manifests.set(`sha256:${'a'.repeat(64)}`, { layers: [...officialAmd.layers, layer('5', 'application/vnd.oci.image.layer.v1.tar+zstd')] });

    expect(indexIssues({ index: goodIndex, manifests, official })).toHaveLength(1);
  });

  it('reports an extra platform', () => {
    expect(indexIssues({ index: { manifests: [...goodIndex.manifests, ref('d', 's390x')] }, manifests: goodManifests, official })).toEqual(['linux/s390x는 내지 않는 플랫폼']);
  });

  it('reports a platform with no overlay layer', () => {
    const manifests = new Map(goodManifests);
    manifests.set(`sha256:${'a'.repeat(64)}`, { layers: officialAmd.layers });

    expect(indexIssues({ index: goodIndex, manifests, official })).toHaveLength(1);
  });
});

describe('overlayLayers', () => {
  it('returns only the layers added on top of the official image', () => {
    expect(overlayLayers({ layers: [...officialAmd.layers, layer('5')] }, officialAmd)).toEqual([layer('5')]);
  });
});

describe('indexIssues and provenance entries', () => {
  it('does not let an attestation label hide a real platform manifest', () => {
    const hidden = { ...ref('e', 'amd64'), annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': `sha256:${'a'.repeat(64)}` } };

    expect(indexIssues({ index: { manifests: [...goodIndex.manifests, hidden] }, manifests: goodManifests, official })).toEqual(['linux/amd64가 두 번 있음']);
  });

  it('flags an unknown platform without the attestation label', () => {
    const odd = { ...ref('e', ''), platform: { os: 'unknown', architecture: 'unknown' } };

    expect(indexIssues({ index: { manifests: [...goodIndex.manifests, odd] }, manifests: goodManifests, official })).toEqual(['unknown/unknown는 내지 않는 플랫폼']);
  });

  it('flags an attestation that points at a manifest we do not ship', () => {
    expect(indexIssues({ index: { manifests: [...goodIndex.manifests, ref('e', '', 'f')] }, manifests: goodManifests, official })).toEqual(['출처 증명이 우리 manifest가 아닌 곳을 가리킴']);
  });
});

describe('configIssues', () => {
  const officialConfig: { architecture: string; os: string; config: Record<string, unknown>; rootfs: { type: string; diff_ids: string[] } } = {
    architecture: 'amd64',
    os: 'linux',
    config: { Entrypoint: ['/init'], Cmd: null, User: '', Env: ['PATH=/usr/bin'], WorkingDir: '/var/www/html', ExposedPorts: { '8080/tcp': {} }, Labels: { a: '1' } },
    rootfs: { type: 'layers', diff_ids: ['sha256:1', 'sha256:2'] },
  };
  const ours = structuredClone(officialConfig);
  ours.config.Labels = { a: '1', 'org.opencontainers.image.title': 'coolify-ko' };
  ours.rootfs.diff_ids = ['sha256:1', 'sha256:2', 'sha256:3'];

  it('accepts the official runtime settings with our labels and extra layers', () => {
    expect(configIssues(ours, officialConfig)).toEqual([]);
  });

  it.each([
    ['a changed entrypoint', (c: typeof ours) => (c.config.Entrypoint = ['/bin/sh'])],
    ['an added environment variable', (c: typeof ours) => (c.config.Env = ['PATH=/usr/bin', 'X=1'])],
    ['a different user', (c: typeof ours) => (c.config.User = 'root')],
    ['an extra exposed port', (c: typeof ours) => (c.config.ExposedPorts = { '8080/tcp': {}, '22/tcp': {} })],
    ['a different architecture', (c: typeof ours) => (c.architecture = 'arm64')],
    ['base layers that are not the official ones', (c: typeof ours) => (c.rootfs.diff_ids = ['sha256:9', 'sha256:2', 'sha256:3'])],
    // 이미지 라벨은 컨테이너에 그대로 붙어, traefik.* 같은 라벨로 프록시 라우팅을 바꿀 수 있다(최종 리뷰 2026-10-19)
    ['an added proxy label', (c: typeof ours) => (c.config.Labels = { a: '1', 'org.opencontainers.image.title': 'coolify-ko', 'traefik.http.routers.x.rule': 'Host(`evil`)' })],
    ['a changed official label', (c: typeof ours) => (c.config.Labels = { a: '2', 'org.opencontainers.image.title': 'coolify-ko' })],
    ['a removed official label', (c: typeof ours) => (c.config.Labels = { 'org.opencontainers.image.title': 'coolify-ko' })],
  ])('reports %s', (_label, change) => {
    const copy = structuredClone(ours);
    change(copy);

    expect(configIssues(copy, officialConfig)).toHaveLength(1);
  });
});

describe('manifestIssues', () => {
  const digest = (c: string): string => `sha256:${c.repeat(64)}`;
  const facts = {
    index: digest('1'),
    platforms: { 'linux/amd64': { manifest: digest('2'), config: digest('3') }, 'linux/arm64': { manifest: digest('4'), config: digest('5') } },
    ociSha256: '6'.repeat(64),
  };
  const manifest = { schema: 1, kind: 'ko', version: '4.4.6', baseIndex: digest('7'), ...facts };
  const expected = { baseIndex: digest('7'), version: '4.4.6' };

  it('accepts a manifest that describes the archive and the committed upstream image', () => {
    expect(manifestIssues(manifest, facts, expected)).toEqual([]);
  });

  it.each([
    ['another image index', { ...manifest, index: digest('9') }],
    ['another platform manifest', { ...manifest, platforms: { ...facts.platforms, 'linux/arm64': { manifest: digest('9'), config: digest('5') } } }],
    ['another config', { ...manifest, platforms: { ...facts.platforms, 'linux/amd64': { manifest: digest('2'), config: digest('9') } } }],
    ['another archive hash', { ...manifest, ociSha256: '9'.repeat(64) }],
    ['a base image that is not the committed one', { ...manifest, baseIndex: digest('9') }],
    ['a version that is not the committed one', { ...manifest, version: '4.4.5' }],
  ])('reports %s', (_label, changed) => {
    expect(manifestIssues(changed, facts, expected)).toHaveLength(1);
  });

  it('reports a manifest that is not an object', () => {
    expect(manifestIssues(null, facts, expected)).toHaveLength(1);
  });
});
