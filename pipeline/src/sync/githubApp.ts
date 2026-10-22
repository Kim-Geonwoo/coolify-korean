import { createSign } from 'node:crypto';

/**
 * 서버 푸시용 GitHub App. 배포 키 푸시는 개인 레포에서 주인(관리자) 이름으로 기록돼 규칙셋을 우회한다(2b 리허설).
 * 앱은 별도 신원이라 우회 목록에 없으면 규칙셋이 dev·main을 막는다. 토큰은 1시간짜리 설치 토큰만 쓰고 저장하지 않는다.
 */
const API = 'https://api.github.com';
const TIMEOUT_MS = 20_000;

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

const base64url = (value: string): string => Buffer.from(value).toString('base64url');

/** 앱 JWT(RS256). 시계 차이를 감안해 60초 앞당기고, GitHub 상한(10분) 안에서 끝난다 */
export function appJwt(appId: string, privateKeyPem: string, now: Date): string {
  if (!/^\d{1,12}$/.test(appId)) {
    throw new Error('GitHub App ID 형식이 맞지 않습니다.');
  }
  const seconds = Math.floor(now.getTime() / 1000);
  const unsigned = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iss: appId, iat: seconds - 60, exp: seconds + 540 }))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKeyPem, 'base64url');

  return `${unsigned}.${signature}`;
}

async function call(fetcher: Fetcher, url: string, bearer: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; data: unknown }> {
  const response = await fetcher(url, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${bearer}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'coolify-ko-sync', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  return { status: response.status, data: (await response.json().catch(() => null)) as unknown };
}

/** 그 레포의 설치를 찾아, 그 레포만·내용 쓰기와 PR 쓰기만 되는 토큰을 받는다 */
export async function installationToken(fetcher: Fetcher, jwt: string, owner: string, repo: string): Promise<string> {
  const installation = await call(fetcher, `${API}/repos/${owner}/${repo}/installation`, jwt);
  const id = (installation.data as { id?: unknown } | null)?.id;
  if (installation.status !== 200 || typeof id !== 'number') {
    throw new Error(`GitHub App이 ${owner}/${repo}에 설치되어 있지 않습니다(HTTP ${String(installation.status)}).`);
  }
  const issued = await call(fetcher, `${API}/app/installations/${String(id)}/access_tokens`, jwt, { method: 'POST', body: { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write' } } });
  const token = (issued.data as { token?: unknown } | null)?.token;
  if (issued.status !== 201 || typeof token !== 'string' || token === '') {
    throw new Error(`설치 토큰을 받지 못했습니다(HTTP ${String(issued.status)}).`);
  }

  return token;
}

/** git에 토큰을 넘기는 환경 변수. 인자(ps에 보인다)나 원격 URL(설정·로그에 남는다)에는 넣지 않는다 */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
  };
}

export interface PullRequestInput {
  readonly owner: string;
  readonly repo: string;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

/** 봇 브랜치에서 열린 PR이 있으면 그것을, 없으면 새로 열어 주소를 돌려준다 */
export async function openPullRequest(fetcher: Fetcher, token: string, input: PullRequestInput): Promise<string> {
  const query = new URLSearchParams({ head: `${input.owner}:${input.head}`, base: input.base, state: 'open' });
  const open = await call(fetcher, `${API}/repos/${input.owner}/${input.repo}/pulls?${query.toString()}`, token);
  const existing = Array.isArray(open.data) ? (open.data[0] as { html_url?: unknown } | undefined)?.html_url : undefined;
  if (open.status === 200 && typeof existing === 'string') {
    return existing;
  }
  const created = await call(fetcher, `${API}/repos/${input.owner}/${input.repo}/pulls`, token, { method: 'POST', body: { head: input.head, base: input.base, title: input.title, body: input.body, maintainer_can_modify: true } });
  const url = (created.data as { html_url?: unknown } | null)?.html_url;
  if (created.status !== 201 || typeof url !== 'string') {
    throw new Error(`PR을 열지 못했습니다(HTTP ${String(created.status)}).`);
  }

  return url;
}
