import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { hubBlob, imageIndexOf, publicKey } from './build.ts';

const ids = ['a'.repeat(40), 'b'.repeat(40)];
const lang = 'c'.repeat(64);
const base = 'docker.io/coollabsio/coolify:4.4.6@sha256:' + 'd'.repeat(64);

describe('publicKey', () => {
  it('names the public build by version and a short hash', () => {
    expect(publicKey('4.4.6', base, ids, lang)).toMatch(/^4\.4\.6-p[0-9a-f]{12}$/);
  });

  it('changes when only the language file changes', () => {
    expect(publicKey('4.4.6', base, ids, lang)).not.toBe(publicKey('4.4.6', base, ids, 'e'.repeat(64)));
  });

  it.each([
    ['a bad version', () => publicKey('4.4', base, ids, lang)],
    ['a bad object id', () => publicKey('4.4.6', base, ['xyz'], lang)],
    ['a bad language hash', () => publicKey('4.4.6', base, ids, 'nope')],
  ])('refuses %s', (_label, call) => {
    expect(call).toThrow();
  });
});

describe('imageIndexOf', () => {
  const inner = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: [] };
  const innerDigest = `sha256:${'f'.repeat(64)}`;

  it('follows the single image index that buildx writes into index.json', () => {
    const top = { manifests: [{ mediaType: 'application/vnd.oci.image.index.v1+json', digest: innerDigest }] };

    expect(imageIndexOf(top, (digest) => (digest === innerDigest ? inner : undefined))).toEqual({ digest: innerDigest, index: inner });
  });

  it('refuses a layout that does not hold exactly one image index', () => {
    expect(() => imageIndexOf({ manifests: [] }, () => inner)).toThrow();
  });
});

describe('hubBlob', () => {
  const body = Buffer.from('{"config":{}}');
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const fake =
    (blob: Buffer): typeof fetch =>
    (input) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.startsWith('https://auth.docker.io/token')) {
        return Promise.resolve(new Response(JSON.stringify({ token: 't' }), { status: 200 }));
      }

      return Promise.resolve(url.endsWith(`/blobs/${digest}`) ? new Response(new Uint8Array(blob), { status: 200 }) : new Response('no', { status: 404 }));
    };

  it('reads an anonymous blob and checks its digest', async () => {
    expect((await hubBlob('docker.io/coollabsio/coolify', digest, fake(body))).toString('utf8')).toBe('{"config":{}}');
  });

  it('refuses content that does not match the digest', async () => {
    await expect(hubBlob('docker.io/coollabsio/coolify', digest, fake(Buffer.from('{"config":{"User":"root"}}')))).rejects.toThrow();
  });

  it('refuses registries other than Docker Hub', async () => {
    await expect(hubBlob('ghcr.io/coollabsio/coolify', digest, fake(body))).rejects.toThrow();
  });
});
