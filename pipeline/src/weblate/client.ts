import type { ExistingScreenshot } from './screenshots.ts';

/**
 * Weblate 번역 단위 하나(단일어 JSON: 키는 context, 원문·대상은 첫 값).
 * 상태 0 빈칸, 10 수정 필요, 11 다시 써야 함(강제 검사에 걸림), 12 확인 필요, 20 번역됨, 30 승인, 100 읽기 전용
 */
export interface WeblateUnit {
  readonly id: number;
  readonly key: string;
  readonly source: string;
  readonly target: string;
  readonly state: number;
  /** 단위에 직접 건 플래그(read-only 등). Weblate가 보내 줄 때만 있다 */
  readonly extraFlags?: string;
  /** 원문 단위의 설명란(Markdown). Weblate가 보내 줄 때만 있다 */
  readonly explanation?: string;
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export type UploadMethod = 'translate' | 'approve' | 'suggest' | 'fuzzy' | 'source' | 'add' | 'replace';
export type ConflictMode = 'ignore' | 'replace-translated' | 'replace-approved';

const DETAIL_LIMIT = 300;
// 다음 쪽 따라가기 상한(쪽당 1000개 × 200쪽). 서버가 같은 쪽을 계속 다음으로 돌려줘도 끝나게
const MAX_PAGES = 200;
// 429(요청이 너무 많음)는 기다렸다 다시. Retry-After(초)를 따르되 1~60초로 묶는다
const RETRIES_429 = 3;

/**
 * 토큰은 메시지에 넣지 않는다. 응답 본문도 넣지 않되, 입력 검증 오류(400)의 필드 설명만 짧게 붙인다
 * (설정이 왜 거절됐는지 알아야 고칠 수 있다. 우리 요청에는 비밀값이 없어 되돌아오는 설명에도 없다).
 */
export class WeblateError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(status: number, path: string, detail?: string) {
    super(`Weblate API가 HTTP ${String(status)}을 돌려줬습니다: ${path}${detail === undefined ? '' : ` (${detail.slice(0, DETAIL_LIMIT)})`}`);
    this.status = status;
    this.path = path;
  }
}

export interface ComponentSpec {
  readonly name: string;
  readonly slug: string;
  /** 원문 언어(en) 파일 내용. 단일어 JSON 템플릿이 된다 */
  readonly sourceJson: Readonly<Record<string, string>>;
  readonly checkFlags?: string;
  readonly enforcedChecks?: readonly string[];
}

export interface WeblateClient {
  units(project: string, component: string, lang: string, q?: string): Promise<WeblateUnit[]>;
  createComponent(project: string, spec: ComponentSpec): Promise<void>;
  addTranslation(project: string, component: string, lang: string): Promise<void>;
  patchUnit(id: number, fields: Readonly<Record<string, unknown>>): Promise<void>;
  patchProject(slug: string, fields: Readonly<Record<string, unknown>>): Promise<void>;
  patchComponent(project: string, component: string, fields: Readonly<Record<string, unknown>>): Promise<void>;
  /** 거부를 기대하는 확인(PoC)용: 던지지 않고 상태와 본문을 돌려준다 */
  raw(method: string, path: string, json?: unknown): Promise<{ status: number; data: unknown }>;
  uploadFile(project: string, component: string, lang: string, json: Readonly<Record<string, string>>, options: { readonly method: UploadMethod; readonly conflicts?: ConflictMode }): Promise<{ accepted: number; skipped: number; notFound: number }>;
  downloadFile(project: string, component: string, lang: string, q?: string): Promise<Record<string, string>>;
  /** 컴포넌트의 스크린샷(이름·이어진 단위 id) */
  screenshots(project: string, component: string): Promise<ExistingScreenshot[]>;
  /** 스크린샷을 만들고 id를 돌려준다. 원문 언어(en)로 만들면 모든 번역에서 보인다 */
  createScreenshot(project: string, component: string, lang: string, name: string, png: Uint8Array): Promise<number>;
  replaceScreenshotImage(id: number, png: Uint8Array): Promise<void>;
  linkScreenshot(id: number, unitId: number): Promise<void>;
  unlinkScreenshot(id: number, unitId: number): Promise<void>;
}

const UNIT_URL = /\/api\/units\/(\d+)\/?$/;
const SCREENSHOT_URL = /\/api\/screenshots\/(\d+)\/?$/;
// ArrayBuffer로 복사해 넘긴다(SharedArrayBuffer일 수 있는 Uint8Array는 BlobPart가 아니다)
// 스크린샷은 PNG나 WebP다(찍기가 WebP로 줄인다). 파일 머리로 종류를 정해 Weblate가 형식을 맞게 읽게 한다
const isWebp = (bytes: Uint8Array): boolean => String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP';
const imagePart = (bytes: Uint8Array): [Blob, string] =>
  isWebp(bytes) ? [new Blob([new Uint8Array(bytes)], { type: 'image/webp' }), 'screenshot.webp'] : [new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'screenshot.png'];
const first = (value: unknown): string => (Array.isArray(value) && typeof value[0] === 'string' ? value[0] : typeof value === 'string' ? value : '');
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export function createClient(options: { readonly baseUrl: string; readonly token: string; readonly fetch?: Fetcher; readonly timeoutMs?: number; readonly sleep?: (ms: number) => Promise<void> }): WeblateClient {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const timeoutMs = options.timeoutMs ?? 20_000;
  const base = options.baseUrl.replace(/\/+$/, '');

  const request = async (url: string, init: { method?: string; body?: FormData; json?: unknown } = {}): Promise<unknown> => {
    const send = (): Promise<Response> =>
      fetcher(url, {
        method: init.method ?? 'GET',
        headers: { authorization: `Token ${options.token}`, accept: 'application/json', ...(init.json === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    let response = await send();
    for (let retry = 1; response.status === 429 && retry <= RETRIES_429; retry++) {
      const seconds = Number(response.headers.get('retry-after'));
      await sleep(Number.isFinite(seconds) && seconds > 0 ? Math.min(60, Math.max(1, seconds)) * 1000 : 5000 * retry);
      response = await send();
    }
    if (!response.ok) {
      const detail = response.status === 400 ? JSON.stringify((await response.json().catch(() => null)) as unknown) : undefined;
      throw new WeblateError(response.status, new URL(url).pathname, detail);
    }
    // 지우기(DELETE)는 본문 없이 204를 돌려준다
    if (response.status === 204) {
      return null;
    }

    return (await response.json()) as unknown;
  };
  const translation = (project: string, component: string, lang: string): string => `${base}/api/translations/${encodeURIComponent(project)}/${encodeURIComponent(component)}/${encodeURIComponent(lang)}`;
  const onBase = (url: string): string => {
    const parsed = new URL(url);

    return `${new URL(base).origin}${parsed.pathname}${parsed.search}`;
  };
  /** 번역(언어)에 문자열이 생길 때까지(최대 10분) 기다린다. 아직 없으면 404다 */
  const waitForStrings = async (project: string, component: string, lang: string): Promise<void> => {
    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        const stats = (await request(`${translation(project, component, lang)}/`)) as { total?: unknown };
        if (typeof stats.total === 'number' && stats.total > 0) {
          return;
        }
      } catch (error: unknown) {
        if (!(error instanceof WeblateError && error.status === 404)) {
          throw error;
        }
      }
      await sleep(2_000);
    }
    throw new Error(`Weblate ${component}/${lang} 준비가 10분 안에 끝나지 않았습니다.`);
  };

  return {
    async units(project, component, lang, q) {
      const out: WeblateUnit[] = [];
      // 쪽 크기 기본값이 문서와 코드에서 다르다(50·100·200). 명시해서 쪽 수를 줄인다
      const query = new URLSearchParams({ page_size: '1000', ...(q === undefined ? {} : { q }) });
      let next: string | null = `${translation(project, component, lang)}/units/?${query.toString()}`;
      for (let pages = 0; next !== null; pages++) {
        if (pages >= MAX_PAGES) {
          throw new Error(`Weblate 단위 목록이 ${String(MAX_PAGES)}쪽을 넘어 멈춥니다.`);
        }
        const page = (await request(next)) as { next?: unknown; results?: unknown };
        for (const raw of Array.isArray(page.results) ? (page.results as Record<string, unknown>[]) : []) {
          const flags = raw['extra_flags'];
          const explanation = raw['explanation'];
          out.push({ id: count(raw['id']), key: first(raw['context']), source: first(raw['source']), target: first(raw['target']), state: count(raw['state']), ...(typeof flags === 'string' ? { extraFlags: flags } : {}), ...(typeof explanation === 'string' ? { explanation } : {}) });
        }
        // Weblate는 다음 쪽 주소를 공개 사이트 주소(https 종단 앞, http로 표기)로 만든다. 그 주소로 가면 400이 난다(2026-10-17 PoC).
        // 경로·질의만 받아 우리 주소로 이어 간다
        next = typeof page.next === 'string' && page.next !== '' ? onBase(page.next) : null;
      }

      return out;
    },
    async createComponent(project, spec) {
      const form = new FormData();
      form.set('name', spec.name);
      form.set('slug', spec.slug);
      form.set('file_format', 'json');
      form.set('source_language', 'en');
      form.set('new_lang', 'add');
      // 키 추가·삭제(원문 갱신)에 필요하다
      form.set('manage_units', 'true');
      // multipart에서 빠진 불리언은 기본값이 아니라 false가 된다(DRF). 제안(Flash 검토)을 받으려면 명시한다(2026-10-17 PoC).
      // 나머지(원문 편집 edit_template 등)는 false로 둔다: 원문은 업스트림에서만 바뀐다
      form.set('enable_suggestions', 'true');
      if (spec.checkFlags !== undefined) {
        form.set('check_flags', spec.checkFlags);
      }
      if (spec.enforcedChecks !== undefined) {
        // multipart에서는 목록을 JSON 문자열로 받는다("Value must be valid JSON", 2026-10-17 PoC)
        form.set('enforced_checks', JSON.stringify(spec.enforcedChecks));
      }
      // 파일을 올려 만들면 Weblate가 원격 없는 로컬 저장소(local:)로 만든다
      form.set('docfile', new Blob([JSON.stringify(spec.sourceJson)], { type: 'application/json' }), 'en.json');
      await request(`${base}/api/projects/${encodeURIComponent(project)}/components/`, { method: 'POST', body: form });
      // 컴포넌트는 백그라운드로 만들어진다. 작업 상태 API는 400을 돌려준 적이 있어(2026-10-17 PoC),
      // 원문(en) 번역에 문자열이 생길 때까지 기다린다
      await waitForStrings(project, spec.slug, 'en');
    },
    async addTranslation(project, component, lang) {
      await request(`${base}/api/components/${encodeURIComponent(project)}/${encodeURIComponent(component)}/translations/`, { method: 'POST', json: { language_code: lang } });
      // 언어 추가도 백그라운드로 끝난다. 바로 단위를 읽으면 0개다(2026-10-17 PoC)
      await waitForStrings(project, component, lang);
    },
    async patchUnit(id, fields) {
      await request(`${base}/api/units/${String(id)}/`, { method: 'PATCH', json: fields });
    },
    async patchProject(slug, fields) {
      await request(`${base}/api/projects/${encodeURIComponent(slug)}/`, { method: 'PATCH', json: fields });
    },
    async patchComponent(project, component, fields) {
      await request(`${base}/api/components/${encodeURIComponent(project)}/${encodeURIComponent(component)}/`, { method: 'PATCH', json: fields });
    },
    async raw(method, path, json) {
      const response = await fetcher(`${base}${path}`, {
        method,
        headers: { authorization: `Token ${options.token}`, accept: 'application/json', ...(json === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(timeoutMs),
      });

      return { status: response.status, data: (await response.json().catch(() => null)) as unknown };
    },
    async uploadFile(project, component, lang, json, upload) {
      const form = new FormData();
      form.set('method', upload.method);
      if (upload.conflicts !== undefined) {
        form.set('conflicts', upload.conflicts);
      }
      form.set('file', new Blob([JSON.stringify(json)], { type: 'application/json' }), `${lang}.json`);
      const result = (await request(`${translation(project, component, lang)}/file/`, { method: 'POST', body: form })) as Record<string, unknown>;

      return { accepted: count(result['accepted']), skipped: count(result['skipped']), notFound: count(result['not_found']) };
    },
    async downloadFile(project, component, lang, q) {
      const query = new URLSearchParams({ format: 'json', ...(q === undefined ? {} : { q }) });
      const data = await request(`${translation(project, component, lang)}/file/?${query.toString()}`);
      if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error('Weblate가 평면 JSON이 아닌 응답을 돌려줬습니다.');
      }

      return Object.fromEntries(Object.entries(data).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    },
    async screenshots(project, component) {
      const out: ExistingScreenshot[] = [];
      let next: string | null = `${base}/api/components/${encodeURIComponent(project)}/${encodeURIComponent(component)}/screenshots/`;
      for (let pages = 0; next !== null; pages++) {
        if (pages >= MAX_PAGES) {
          throw new Error(`Weblate 스크린샷 목록이 ${String(MAX_PAGES)}쪽을 넘어 멈춥니다.`);
        }
        const page = (await request(next)) as { next?: unknown; results?: unknown };
        for (const raw of Array.isArray(page.results) ? (page.results as Record<string, unknown>[]) : []) {
          const units = Array.isArray(raw['units']) ? (raw['units'] as unknown[]) : [];
          out.push({
            id: count(raw['id']),
            name: typeof raw['name'] === 'string' ? raw['name'] : '',
            unitIds: units.flatMap((url) => {
              const match = typeof url === 'string' ? UNIT_URL.exec(new URL(url, base).pathname) : null;

              return match?.[1] === undefined ? [] : [Number(match[1])];
            }),
          });
        }
        next = typeof page.next === 'string' && page.next !== '' ? onBase(page.next) : null;
      }

      return out;
    },
    async createScreenshot(project, component, lang, name, png) {
      const form = new FormData();
      form.set('name', name);
      form.set('project_slug', project);
      form.set('component_slug', component);
      form.set('language_code', lang);
      form.set('image', ...imagePart(png));
      // 생성 응답에는 id가 없고 url(…/api/screenshots/{id}/)만 온다
      const created = (await request(`${base}/api/screenshots/`, { method: 'POST', body: form })) as { id?: unknown; url?: unknown };
      const match = typeof created.url === 'string' ? SCREENSHOT_URL.exec(new URL(created.url, base).pathname) : null;
      const id = count(created.id) || (match?.[1] === undefined ? 0 : Number(match[1]));
      if (id === 0) {
        throw new Error('Weblate가 만든 스크린샷의 id를 돌려주지 않았습니다.');
      }

      return id;
    },
    async replaceScreenshotImage(id, png) {
      const form = new FormData();
      form.set('image', ...imagePart(png));
      await request(`${base}/api/screenshots/${String(id)}/file/`, { method: 'POST', body: form });
    },
    async linkScreenshot(id, unitId) {
      const form = new FormData();
      form.set('unit_id', String(unitId));
      await request(`${base}/api/screenshots/${String(id)}/units/`, { method: 'POST', body: form });
    },
    async unlinkScreenshot(id, unitId) {
      await request(`${base}/api/screenshots/${String(id)}/units/${String(unitId)}/`, { method: 'DELETE' });
    },
  };
}
