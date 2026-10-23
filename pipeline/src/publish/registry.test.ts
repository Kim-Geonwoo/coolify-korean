import { describe, expect, it } from 'vitest';
import { registryDigest } from './registry.ts';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function fakeFetch(manifest: Response): { readonly calls: { url: string; init: RequestInit | undefined }[]; readonly fetcher: (url: string, init?: RequestInit) => Promise<Response> } {
  const calls: { url: string; init: RequestInit | undefined }[] = [];

  return {
    calls,
    fetcher: (url, init) => {
      calls.push({ url, init });

      return Promise.resolve(url.includes('/token?') ? new Response(JSON.stringify({ token: 'anon' })) : manifest);
    },
  };
}

describe('registryDigest', () => {
  it('reads the index digest a tag points to with an anonymous pull token', async () => {
    const { calls, fetcher } = fakeFetch(new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } }));

    expect(await registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7', fetcher)).toBe(DIGEST);
    expect(calls[0]?.url).toBe('https://ghcr.io/token?service=ghcr.io&scope=repository:kim-geonwoo/coolify-ko:pull');
    expect(calls[1]?.url).toBe('https://ghcr.io/v2/kim-geonwoo/coolify-ko/manifests/4.4.7');
    expect(calls[1]?.init?.method).toBe('HEAD');
    expect(new Headers(calls[1]?.init?.headers).get('authorization')).toBe('Bearer anon');
    expect(new Headers(calls[1]?.init?.headers).get('accept')).toContain('application/vnd.oci.image.index.v1+json');
  });

  it('returns undefined when the tag does not exist', async () => {
    const { fetcher } = fakeFetch(new Response(null, { status: 404 }));

    expect(await registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7', fetcher)).toBeUndefined();
  });

  it('refuses when the package cannot be read anonymously', async () => {
    const { fetcher } = fakeFetch(new Response(null, { status: 403 }));

    await expect(registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7', fetcher)).rejects.toThrow(/HTTP 403/);
  });

  it('refuses a digest header that is not a sha256 digest', async () => {
    const { fetcher } = fakeFetch(new Response(null, { status: 200, headers: { 'docker-content-digest': 'sha256:zz' } }));

    await expect(registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7', fetcher)).rejects.toThrow(/다이제스트/);
  });

  it('refuses a token answer without a token', async () => {
    const fetcher = (): Promise<Response> => Promise.resolve(new Response(JSON.stringify({ error: 'x' })));

    await expect(registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7', fetcher)).rejects.toThrow(/토큰/);
  });

  it('checks the repository and tag before asking anything', async () => {
    const { calls, fetcher } = fakeFetch(new Response(null, { status: 200, headers: { 'docker-content-digest': DIGEST } }));

    await expect(registryDigest('ghcr.io/kim-geonwoo/coolify-ko', '4.4.7/../x', fetcher)).rejects.toThrow(/태그/);
    await expect(registryDigest('https://evil.example/x', '4.4.7', fetcher)).rejects.toThrow(/저장소/);
    expect(calls).toHaveLength(0);
  });
});
