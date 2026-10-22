import { describe, expect, it } from 'vitest';
import { createClient, WeblateError } from './client.ts';

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly auth: string | null;
  readonly signal: boolean;
  readonly form?: Record<string, string>;
  readonly fileType?: string;
  readonly fileName?: string;
  readonly file?: string;
}

/** 경로별 응답을 돌려주는 가짜 Weblate. multipart 본문은 필드·파일 내용으로 풀어 기록한다 */
function fake(routes: Record<string, { status?: number; body: unknown }>): { fetch: (url: string, init?: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? 'GET';
    let form: Record<string, string> | undefined;
    let file: string | undefined;
    let fileType: string | undefined;
    let fileName: string | undefined;
    if (init?.body instanceof FormData) {
      form = {};
      for (const [name, value] of init.body as unknown as Iterable<[string, string | Blob]>) {
        if (typeof value === 'string') {
          form[name] = value;
        } else {
          file = await value.text();
          fileType = value.type;
          fileName = value instanceof File ? value.name : undefined;
        }
      }
    }
    seen.push({ url, method, auth: new Headers(init?.headers).get('authorization'), signal: init?.signal !== undefined, ...(form === undefined ? {} : { form }), ...(file === undefined ? {} : { file }), ...(fileType === undefined ? {} : { fileType }), ...(fileName === undefined ? {} : { fileName }) });
    const route = routes[`${method} ${url}`];

    // 204는 본문이 없다(Weblate의 DELETE)
    return route === undefined ? Response.json({ detail: 'Not found.' }, { status: 404 }) : route.status === 204 ? new Response(null, { status: 204 }) : Response.json(route.body, { status: route.status ?? 200 });
  };

  return { fetch, seen };
}

const base = 'http://127.0.0.1:8792';
const units = `${base}/api/translations/coolify-ko/dashboard/ko/units/`;

describe('createClient', () => {
  it('follows every page of units and reads the key from the context', async () => {
    const { fetch, seen } = fake({
      [`GET ${units}?page_size=1000`]: { body: { next: `${units}?page=2`, results: [{ id: 1, context: 'Save', source: ['Save'], target: ['저장'], state: 30 }] } },
      [`GET ${units}?page=2`]: { body: { next: `${units}?page=3`, results: [{ id: 2, context: 'auth.throttle', source: ['Too many attempts.'], target: [''], state: 0 }] } },
      [`GET ${units}?page=3`]: { body: { next: null, results: [{ id: 3, context: ':count item|:count items', source: [':count item|:count items'], target: ['항목 :count개'], state: 10 }] } },
    });
    const client = createClient({ baseUrl: base, token: 'wlu_secret', fetch });

    expect(await client.units('coolify-ko', 'dashboard', 'ko')).toEqual([
      { id: 1, key: 'Save', source: 'Save', target: '저장', state: 30 },
      { id: 2, key: 'auth.throttle', source: 'Too many attempts.', target: '', state: 0 },
      { id: 3, key: ':count item|:count items', source: ':count item|:count items', target: '항목 :count개', state: 10 },
    ]);
    expect(seen.every((s) => s.auth === 'Token wlu_secret' && s.signal)).toBe(true);
  });

  it('reads the extra flags of a unit when Weblate sends them', async () => {
    const { fetch } = fake({ [`GET ${units}?page_size=1000`]: { body: { next: null, results: [{ id: 4, context: 'localhost', source: ['localhost'], target: [''], state: 100, extra_flags: 'read-only' }] } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.units('coolify-ko', 'dashboard', 'ko')).toEqual([{ id: 4, key: 'localhost', source: 'localhost', target: '', state: 100, extraFlags: 'read-only' }]);
  });

  it('uploads a JSON file with the method and conflict mode, and reads the counts', async () => {
    const file = `${base}/api/translations/coolify-ko/dashboard/ko/file/`;
    const { fetch, seen } = fake({ [`POST ${file}`]: { body: { accepted: 2, skipped: 1, not_found: 0, total: 3, result: true } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.uploadFile('coolify-ko', 'dashboard', 'ko', { Save: '저장' }, { method: 'fuzzy', conflicts: 'ignore' })).toEqual({ accepted: 2, skipped: 1, notFound: 0 });
    expect(seen[0]?.form).toEqual({ method: 'fuzzy', conflicts: 'ignore' });
    expect(JSON.parse(seen[0]?.file ?? '{}')).toEqual({ Save: '저장' });
  });

  it('downloads a translation as flat JSON with a search filter', async () => {
    const file = `${base}/api/translations/coolify-ko/dashboard/ko/file/?format=json&q=state%3A%3E%3Dapproved`;
    const { fetch } = fake({ [`GET ${file}`]: { body: { Save: '저장' } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.downloadFile('coolify-ko', 'dashboard', 'ko', 'state:>=approved')).toEqual({ Save: '저장' });
  });

  it('follows next pages on our own address even when Weblate links its public site address', async () => {
    const page2 = `${units}?page=2&page_size=1000`;
    const { fetch, seen } = fake({
      [`GET ${units}?page_size=1000`]: { body: { next: 'http://weblate.example.internal:8444/api/translations/coolify-ko/dashboard/ko/units/?page=2&page_size=1000', results: [] } },
      [`GET ${page2}`]: { body: { next: null, results: [{ id: 9, context: 'Save', source: ['Save'], target: [''], state: 0 }] } },
    });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.units('coolify-ko', 'dashboard', 'ko')).toHaveLength(1);
    expect(seen[1]?.url).toBe(page2);
  });

  it('waits after adding a language until its strings exist', async () => {
    const add = `${base}/api/components/coolify-ko/dashboard/translations/`;
    const ko = `${base}/api/translations/coolify-ko/dashboard/ko/`;
    const { fetch: inner } = fake({ [`POST ${add}`]: { status: 201, body: {} } });
    let polls = 0;
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      if (url !== ko) {
        return inner(url, init);
      }
      polls++;

      return Promise.resolve(Response.json({ total: polls < 3 ? 0 : 4016 }));
    };
    const client = createClient({ baseUrl: base, token: 't', fetch, sleep: () => Promise.resolve() });

    await client.addTranslation('coolify-ko', 'dashboard', 'ko');
    expect(polls).toBe(3);
  });

  it('asks for big pages and passes a search filter when listing units', async () => {
    const url = `${units}?page_size=1000&q=state%3Aapproved`;
    const { fetch, seen } = fake({ [`GET ${url}`]: { body: { next: null, results: [] } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.units('coolify-ko', 'dashboard', 'ko', 'state:approved')).toEqual([]);
    expect(seen[0]?.url).toBe(url);
  });

  it('creates a component from an uploaded source file and waits until its source strings exist', async () => {
    const create = `${base}/api/projects/coolify-ko/components/`;
    const source = `${base}/api/translations/coolify-ko/dashboard/en/`;
    const { fetch: inner, seen } = fake({ [`POST ${create}`]: { status: 201, body: { slug: 'dashboard', task_url: `${base}/api/tasks/abc/` } } });
    let polls = 0;
    // 원문 번역은 백그라운드 작업이 끝나야 생긴다: 처음엔 없고(404), 그다음엔 비어 있고, 마지막에 문자열이 있다
    const fetch = (url: string, init?: RequestInit): Promise<Response> => {
      if (url !== source) {
        return inner(url, init);
      }
      polls++;

      return Promise.resolve(polls === 1 ? Response.json({}, { status: 404 }) : Response.json({ total: polls === 2 ? 0 : 1 }));
    };
    const client = createClient({ baseUrl: base, token: 't', fetch, sleep: () => Promise.resolve() });

    await client.createComponent('coolify-ko', { name: 'dashboard', slug: 'dashboard', sourceJson: { Save: 'Save' }, checkFlags: 'placeholders:r"x"', enforcedChecks: ['placeholders'] });
    expect(seen[0]?.form).toEqual({ name: 'dashboard', slug: 'dashboard', file_format: 'json', source_language: 'en', new_lang: 'add', manage_units: 'true', enable_suggestions: 'true', check_flags: 'placeholders:r"x"', enforced_checks: '["placeholders"]' });
    expect(JSON.parse(seen[0]?.file ?? '{}')).toEqual({ Save: 'Save' });
    expect(polls).toBe(3);
  });

  it('sends JSON for language, unit, project and component changes', async () => {
    const { fetch, seen } = fake({
      [`POST ${base}/api/components/coolify-ko/dashboard/translations/`]: { status: 201, body: {} },
      [`GET ${base}/api/translations/coolify-ko/dashboard/ko/`]: { body: { total: 1 } },
      [`PATCH ${base}/api/units/7/`]: { body: {} },
      [`PATCH ${base}/api/projects/coolify-ko/`]: { body: {} },
      [`PATCH ${base}/api/components/coolify-ko/dashboard/`]: { body: {} },
    });
    const bodies: unknown[] = [];
    const recording = (url: string, init?: RequestInit): Promise<Response> => {
      bodies.push(typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : null);

      return fetch(url, init);
    };
    const client = createClient({ baseUrl: base, token: 't', fetch: recording });

    await client.addTranslation('coolify-ko', 'dashboard', 'ko');
    await client.patchUnit(7, { target: ['저장'], state: 30 });
    await client.patchProject('coolify-ko', { translation_review: true });
    await client.patchComponent('coolify-ko', 'dashboard', { enforced_checks: ['placeholders'] });
    expect(seen.map((s) => s.method)).toEqual(['POST', 'GET', 'PATCH', 'PATCH', 'PATCH']);
    expect(bodies).toEqual([{ language_code: 'ko' }, null, { target: ['저장'], state: 30 }, { translation_review: true }, { enforced_checks: ['placeholders'] }]);
  });

  it('lists, creates, swaps and links source-language screenshots', async () => {
    const list = `${base}/api/components/coolify-ko/dashboard/screenshots/`;
    const { fetch, seen } = fake({
      [`GET ${list}`]: { body: { next: null, results: [{ id: 7, name: '/servers', units: [`${base}/api/units/103/`, `${base}/api/units/104/`] }] } },
      // Weblate 2026.10의 생성 응답(ScreenshotCreateSerializer)에는 id가 없고, 주소는 공개 사이트 주소로 온다
      [`POST ${base}/api/screenshots/`]: {
        status: 201,
        body: { name: '/team', url: 'http://weblate.site/api/screenshots/8/', file_url: 'http://weblate.site/api/screenshots/8/file/' },
      },
      [`POST ${base}/api/screenshots/7/file/`]: { body: { result: true } },
      [`POST ${base}/api/screenshots/8/units/`]: { body: {} },
      [`DELETE ${base}/api/screenshots/7/units/104/`]: { status: 204, body: {} },
    });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.screenshots('coolify-ko', 'dashboard')).toEqual([{ id: 7, name: '/servers', unitIds: [103, 104] }]);
    expect(await client.createScreenshot('coolify-ko', 'dashboard', 'en', '/team', new Uint8Array([137, 80]))).toBe(8);
    expect(seen[1]?.form).toEqual({ name: '/team', project_slug: 'coolify-ko', component_slug: 'dashboard', language_code: 'en' });
    await client.replaceScreenshotImage(7, new Uint8Array([137, 80]));
    await client.linkScreenshot(8, 101);
    expect(seen[3]?.form).toEqual({ unit_id: '101' });
    await client.unlinkScreenshot(7, 104);
    expect(seen.map((s) => s.method)).toEqual(['GET', 'POST', 'POST', 'POST', 'DELETE']);
  });

  it('sends a WebP screenshot as WebP and a PNG as PNG, judged by the file signature', async () => {
    const { fetch, seen } = fake({ [`POST ${base}/api/screenshots/`]: { status: 201, body: { url: 'http://weblate.site/api/screenshots/9/' } }, [`POST ${base}/api/screenshots/9/file/`]: { body: { result: true } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

    await client.createScreenshot('coolify-ko', 'dashboard', 'en', '/team', webp);
    await client.replaceScreenshotImage(9, new Uint8Array([137, 80, 78, 71]));
    expect(seen.map((s) => [s.fileType, s.fileName])).toEqual([
      ['image/webp', 'screenshot.webp'],
      ['image/png', 'screenshot.png'],
    ]);
  });

  it('fails when the created screenshot comes back with neither an id nor a screenshot address', async () => {
    const { fetch } = fake({ [`POST ${base}/api/screenshots/`]: { status: 201, body: { name: '/team', url: 'http://weblate.site/api/units/8/' } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    await expect(client.createScreenshot('coolify-ko', 'dashboard', 'en', '/team', new Uint8Array([137, 80]))).rejects.toThrow('id를 돌려주지');
  });

  it('waits as told and tries again when Weblate says too many requests, then gives up after three tries', async () => {
    const waits: number[] = [];
    let calls = 0;
    const busyOnce = (): Promise<Response> => {
      calls++;

      return Promise.resolve(calls === 1 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : Response.json({ next: null, results: [] }));
    };
    const client = createClient({ baseUrl: base, token: 't', fetch: busyOnce, sleep: (ms) => Promise.resolve(void waits.push(ms)) });

    expect(await client.units('coolify-ko', 'dashboard', 'ko')).toEqual([]);
    expect(waits).toEqual([2000]);

    const alwaysBusy = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 429 }));
    const tired = createClient({ baseUrl: base, token: 't', fetch: alwaysBusy, sleep: () => Promise.resolve() });
    await expect(tired.units('coolify-ko', 'dashboard', 'ko')).rejects.toThrow('HTTP 429');
  });

  it('stops following next pages that never end', async () => {
    const loop = (): Promise<Response> => Promise.resolve(Response.json({ next: `${units}?page=2`, results: [] }));
    const client = createClient({ baseUrl: base, token: 't', fetch: loop });

    await expect(client.units('coolify-ko', 'dashboard', 'ko')).rejects.toThrow('쪽');
  });

  it('returns the status instead of throwing for raw requests, for checks that expect a refusal', async () => {
    const { fetch } = fake({ [`PATCH ${base}/api/units/7/`]: { status: 403, body: { detail: 'no' } }, [`GET ${base}/api/projects/coolify-ko/components/`]: { body: { results: [] } } });
    const client = createClient({ baseUrl: base, token: 't', fetch });

    expect(await client.raw('PATCH', '/api/units/7/', { state: 30 })).toEqual({ status: 403, data: { detail: 'no' } });
    expect(await client.raw('GET', '/api/projects/coolify-ko/components/')).toEqual({ status: 200, data: { results: [] } });
  });

  it('keeps the field errors of a rejected request (400) so a failed setup says why, cut short', async () => {
    const { fetch } = fake({ [`POST ${base}/api/projects/coolify-ko/components/`]: { status: 400, body: { check_flags: ['Invalid regular expression.'] } } });
    const client = createClient({ baseUrl: base, token: 'wlu_secret', fetch });

    const error = (await client.createComponent('coolify-ko', { name: 'x', slug: 'x', sourceJson: {} }).catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('Weblate API가 HTTP 400을 돌려줬습니다: /api/projects/coolify-ko/components/ ({"check_flags":["Invalid regular expression."]})');
  });

  it('fails with the status and path only, never the token or the response body', async () => {
    const { fetch } = fake({ [`GET ${units}?page_size=1000`]: { status: 403, body: { detail: 'secret detail wlu_secret' } } });
    const client = createClient({ baseUrl: base, token: 'wlu_secret', fetch });

    const error = await client.units('coolify-ko', 'dashboard', 'ko').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WeblateError);
    expect((error as Error).message).toBe('Weblate API가 HTTP 403을 돌려줬습니다: /api/translations/coolify-ko/dashboard/ko/units/');
  });
});
