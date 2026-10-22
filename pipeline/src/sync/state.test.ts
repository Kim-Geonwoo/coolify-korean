import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertCatalogVersion, buildArgs, imageRef, parseState } from './state.ts';

const root = join(import.meta.dirname, '..', '..', '..');
const valid = { upstream: { version: '4.4.6', image: 'docker.io/coollabsio/coolify', digest: `sha256:${'a'.repeat(64)}` } };

describe('state', () => {
  it('pins the upstream image by version and digest', () => {
    const state = parseState(valid);

    expect(imageRef(state)).toBe(`docker.io/coollabsio/coolify:4.4.6@sha256:${'a'.repeat(64)}`);
    expect(buildArgs(state)).toEqual(['--build-arg', `COOLIFY_IMAGE=docker.io/coollabsio/coolify:4.4.6@sha256:${'a'.repeat(64)}`, '--build-arg', 'COOLIFY_VERSION=4.4.6']);
  });

  it('rejects versions, images and digests that could inject build arguments', () => {
    expect(() => parseState({ upstream: { ...valid.upstream, version: '4.4.6 --push' } })).toThrow();
    expect(() => parseState({ upstream: { ...valid.upstream, version: '4.5-rc.1' } })).toThrow();
    expect(() => parseState({ upstream: { ...valid.upstream, image: 'evil image' } })).toThrow();
    expect(() => parseState({ upstream: { ...valid.upstream, digest: 'sha256:abc' } })).toThrow();
    expect(() => parseState({})).toThrow();
  });

  it('refuses a catalog extracted from another version', () => {
    const state = parseState(valid);

    expect(() => {
      assertCatalogVersion({ version: '4.4.6', keys: {} }, state);
    }).not.toThrow();
    expect(() => {
      assertCatalogVersion({ version: '4.4.5', keys: {} }, state);
    }).toThrow(/4\.4\.5/);
    expect(() => {
      assertCatalogVersion({ keys: {} }, state);
    }).toThrow();
  });

  it('matches the defaults the Dockerfile falls back to', () => {
    const state = parseState(JSON.parse(readFileSync(join(root, 'i18n', 'state.json'), 'utf8')) as unknown);
    const dockerfile = readFileSync(join(root, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain(`ARG COOLIFY_IMAGE=${imageRef(state)}\n`);
    expect(dockerfile).toContain(`ARG COOLIFY_VERSION=${state.upstream.version}\n`);
  });
});
