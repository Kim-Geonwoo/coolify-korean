import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, gitAuthEnv, installationToken, openPullRequest } from './githubApp.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;

describe('appJwt', () => {
  it('signs a short-lived RS256 token issued by the app id, backdated against clock drift', () => {
    const jwt = appJwt('123456', privateKey, new Date('2026-10-17T10:00:00Z'));
    const [header = '', payload = '', signature = ''] = jwt.split('.');

    expect(decode(header)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload)).toEqual({ iss: '123456', iat: 1792231140, exp: 1792231740 });
    expect(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url')).toBe(true);
    expect(() => appJwt('12a', privateKey, new Date())).toThrow();
  });
});

interface Call {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly body: unknown;
}

function api(responses: Record<string, { status: number; body: unknown }>): { fetcher: (url: string, init?: RequestInit) => Promise<Response>; calls: Call[] } {
  const calls: Call[] = [];
  const fetcher = (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null });
    expect(init?.signal).toBeDefined();
    const found = responses[`${method} ${url}`];

    return Promise.resolve(Response.json(found?.body ?? { message: 'Not Found' }, { status: found?.status ?? 404 }));
  };

  return { fetcher, calls };
}

describe('installationToken', () => {
  it('finds the installation on the repository and asks for a token limited to it', async () => {
    const { fetcher, calls } = api({
      'GET https://api.github.com/repos/Kim-Geonwoo/coolify-ko/installation': { status: 200, body: { id: 42 } },
      'POST https://api.github.com/app/installations/42/access_tokens': { status: 201, body: { token: 'ghs_abc', expires_at: '2026-10-17T11:00:00Z' } },
    });

    expect(await installationToken(fetcher, 'jwt', 'Kim-Geonwoo', 'coolify-ko')).toBe('ghs_abc');
    expect(calls.map((c) => [c.method, c.auth])).toEqual([['GET', 'Bearer jwt'], ['POST', 'Bearer jwt']]);
    expect(calls[1]?.body).toEqual({ repositories: ['coolify-ko'], permissions: { contents: 'write', pull_requests: 'write' } });
  });

  it('fails clearly when the app is not installed on the repository', async () => {
    const { fetcher } = api({});

    await expect(installationToken(fetcher, 'jwt', 'Kim-Geonwoo', 'coolify-ko')).rejects.toThrow(/설치/);
  });
});

describe('gitAuthEnv', () => {
  it('passes the token to git through environment config, never through arguments or the remote URL', () => {
    expect(gitAuthEnv('ghs_abc')).toEqual({
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
      GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from('x-access-token:ghs_abc').toString('base64')}`,
    });
  });
});

describe('openPullRequest', () => {
  const head = 'https://api.github.com/repos/Kim-Geonwoo/coolify-ko/pulls?head=Kim-Geonwoo%3Abot%2Fi18n&base=dev&state=open';

  it('reuses an open pull request from the bot branch', async () => {
    const { fetcher, calls } = api({ [`GET ${head}`]: { status: 200, body: [{ html_url: 'https://github.com/Kim-Geonwoo/coolify-ko/pull/7', number: 7 }] } });

    expect(await openPullRequest(fetcher, 'ghs_abc', { owner: 'Kim-Geonwoo', repo: 'coolify-ko', head: 'bot/i18n', base: 'dev', title: 't', body: 'b' })).toBe('https://github.com/Kim-Geonwoo/coolify-ko/pull/7');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.auth).toBe('Bearer ghs_abc');
  });

  it('opens one when none is open', async () => {
    const { fetcher, calls } = api({
      [`GET ${head}`]: { status: 200, body: [] },
      'POST https://api.github.com/repos/Kim-Geonwoo/coolify-ko/pulls': { status: 201, body: { html_url: 'https://github.com/Kim-Geonwoo/coolify-ko/pull/8', number: 8 } },
    });

    expect(await openPullRequest(fetcher, 'ghs_abc', { owner: 'Kim-Geonwoo', repo: 'coolify-ko', head: 'bot/i18n', base: 'dev', title: 'i18n: 4.4.7 초안', body: '본문' })).toBe('https://github.com/Kim-Geonwoo/coolify-ko/pull/8');
    expect(calls[1]?.body).toEqual({ head: 'bot/i18n', base: 'dev', title: 'i18n: 4.4.7 초안', body: '본문', maintainer_can_modify: true });
  });
});
