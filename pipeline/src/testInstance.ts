import { randomBytes as cryptoRandomBytes } from 'node:crypto';

/** 가짜 언어 번역표: 모든 키의 영어 문구를 ⟦ ⟧로 감싼다. 화면에 ⟦가 보이면 번역 경로를 탄 글자다. */
export function pseudoTranslations(english: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(english).map(([key, text]) => [key, `⟦${text}⟧`]));
}

export interface TestEnvOptions {
  readonly port: number;
  readonly email: string;
  readonly randomBytes?: (size: number) => Buffer;
}

/** 시험 인스턴스용 .env. 비밀값은 실행할 때마다 새로 만들고 레포에 남기지 않는다. */
export function buildTestEnv(options: TestEnvOptions): string {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`포트는 1024~65535 사이 정수여야 합니다: ${String(options.port)}`);
  }
  const random = options.randomBytes ?? cryptoRandomBytes;
  const hex = (size: number): string => random(size).toString('hex');
  const core = random(24).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  const password = `Ck7%${core}x9Q`;
  const lines: ReadonlyArray<readonly [string, string]> = [
    ['APP_ID', 'coolify-ko-test'],
    ['APP_NAME', 'Coolify'],
    ['APP_KEY', `base64:${random(32).toString('base64')}`],
    ['APP_PORT', String(options.port)],
    ['DB_USERNAME', 'coolify'],
    ['DB_DATABASE', 'coolify'],
    ['DB_PASSWORD', hex(16)],
    ['REDIS_PASSWORD', hex(16)],
    ['PUSHER_APP_ID', hex(8)],
    ['PUSHER_APP_KEY', hex(16)],
    ['PUSHER_APP_SECRET', hex(16)],
    ['PUSHER_BACKEND_PORT', '6001'],
    ['ROOT_USERNAME', 'coolify-ko-test'],
    ['ROOT_USER_EMAIL', options.email],
    ['ROOT_USER_PASSWORD', password],
    ['SCHEDULER_ENABLED', 'false'],
    ['HORIZON_ENABLED', 'false'],
  ];

  return lines.map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}

export interface TextSummary {
  readonly total: number;
  readonly translated: number;
  readonly untranslated: readonly string[];
}

export interface TextPiece {
  readonly text: string;
  /** ⟦ … ⟧로 둘러싸인 번역 문장 구간에 들어 있는지(문장 안 링크·kbd 글자 포함) */
  readonly insideTranslation: boolean;
}

/** 조상 한 단계에서 본, 글자 조각 앞쪽의 마지막 표지와 뒤쪽의 첫 표지('⟦', '⟧', 없으면 ''). */
export interface MarkerContext {
  readonly lastBefore: string;
  readonly firstAfter: string;
}

/**
 * 어느 조상 단계에서든 앞에 여는 표지, 뒤에 닫는 표지가 있으면 번역 문장 안의 글자다.
 * CSS display로 블록을 가르면 flex 안의 span처럼 블록으로 바뀐 요소에서 놓치므로 표지 위치로만 판단한다.
 */
export function isInsideTranslation(levels: readonly MarkerContext[]): boolean {
  return levels.some((level) => level.lastBefore === '⟦' && level.firstAfter === '⟧');
}

/** 화면 텍스트 조각 중 글자가 있는 것을 세고, 번역 문장 구간 안에 있는 것과 아닌 것을 나눈다. 표지를 품은 조각(문장 끝 등)도 구간 안이다. */
export function summarizeTexts(pieces: readonly TextPiece[]): TextSummary {
  let total = 0;
  let translated = 0;
  const untranslated: string[] = [];
  for (const piece of pieces) {
    const text = piece.text.trim();
    if (!/\p{L}/u.test(text)) {
      continue;
    }
    total++;
    if (piece.insideTranslation || text.includes('⟦') || text.includes('⟧')) {
      translated++;
    } else {
      untranslated.push(text);
    }
  }

  return { total, translated, untranslated };
}

const ERROR_MARKERS = /Server Error|Whoops|ErrorException|Undefined (?:variable|array key|index)|syntax error|Call to undefined/i;

export interface PageSignal {
  readonly status: number;
  readonly title: string;
  readonly body: string;
}

/** 응답이 없거나(0) 5xx이거나 Laravel 오류 화면이면 오류다. 4xx는 링크 탐색에서 흔해 오류로 세지 않는다. */
export function isErrorPage(signal: PageSignal): boolean {
  return signal.status === 0 || signal.status >= 500 || ERROR_MARKERS.test(signal.title) || ERROR_MARKERS.test(signal.body.slice(0, 2000));
}

export interface PageTally {
  readonly error: boolean;
  readonly jsErrors: number;
  readonly texts: { readonly total: number; readonly translated: number };
}

export interface SmokeTotals {
  readonly pages: number;
  readonly errors: number;
  readonly jsErrors: number;
  readonly textTotal: number;
  readonly textTranslated: number;
}

export function smokeTotals(pages: readonly PageTally[]): SmokeTotals {
  return {
    pages: pages.length,
    errors: pages.filter((page) => page.error).length,
    jsErrors: pages.reduce((sum, page) => sum + page.jsErrors, 0),
    textTotal: pages.reduce((sum, page) => sum + page.texts.total, 0),
    textTranslated: pages.reduce((sum, page) => sum + page.texts.translated, 0),
  };
}
