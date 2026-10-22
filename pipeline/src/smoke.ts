import { chromium, type Page } from 'playwright';
import { isErrorPage, isInsideTranslation, smokeTotals, summarizeTexts, type MarkerContext, type SmokeTotals, type TextPiece } from './testInstance.ts';

export const START_PATHS: readonly string[] = [
  '/', '/onboarding', '/projects', '/servers', '/sources', '/destinations', '/storages', '/shared-variables',
  '/notifications/email', '/notifications/discord', '/notifications/telegram', '/security/private-key',
  '/security/api-tokens', '/security/cloud-tokens', '/security/cloud-init-scripts', '/settings', '/settings/advanced',
  '/settings/updates', '/settings/backup', '/settings/email', '/settings/oauth', '/team', '/team/members',
  '/profile', '/profile/appearance', '/tags', '/terminal', '/admin', '/audit-log', '/analytics',
];

export interface PageReport {
  readonly path: string;
  readonly finalPath: string;
  readonly status: number;
  readonly error: boolean;
  readonly jsErrors: number;
  readonly texts: { readonly total: number; readonly translated: number; readonly untranslatedSample: readonly string[] };
}

export interface SmokeReport {
  readonly base: string;
  readonly pages: readonly PageReport[];
  readonly totals: SmokeTotals;
  readonly untranslatedTop: readonly { readonly text: string; readonly count: number }[];
}

export interface SmokeOptions {
  readonly base: string;
  readonly email: string;
  readonly password: string;
  readonly maxPages: number;
  readonly timeoutMs: number;
}

const MARKER_LEVELS = 6;

async function visibleTexts(page: Page): Promise<TextPiece[]> {
  const raw = await page.evaluate((levelCount) => {
    const lastMarker = (text: string): string => {
      const open = text.lastIndexOf('⟦');
      const close = text.lastIndexOf('⟧');
      return open === -1 && close === -1 ? '' : open > close ? '⟦' : '⟧';
    };
    const firstMarker = (text: string): string => {
      const open = text.indexOf('⟦');
      const close = text.indexOf('⟧');
      if (open === -1 && close === -1) {
        return '';
      }
      if (open === -1) {
        return '⟧';
      }
      return close === -1 || open < close ? '⟦' : '⟧';
    };
    const out: { text: string; levels: { lastBefore: string; firstAfter: string }[] }[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (parent === null || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'CODE', 'PRE'].includes(parent.tagName) || !parent.checkVisibility()) {
        continue;
      }
      const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (text === '') {
        continue;
      }
      // 조상을 몇 단계 올라가며, 그 안에서 이 조각 앞뒤의 가장 가까운 ⟦·⟧ 표지를 모은다.
      const levels: { lastBefore: string; firstAfter: string }[] = [];
      let ancestor: Element | null = parent;
      for (let level = 0; level < levelCount && ancestor !== null; level++, ancestor = ancestor.parentElement) {
        let before = '';
        let after = '';
        let seen = false;
        const inner = document.createTreeWalker(ancestor, NodeFilter.SHOW_TEXT);
        for (let t = inner.nextNode(); t !== null; t = inner.nextNode()) {
          if (t === node) {
            seen = true;
          } else if (seen) {
            after += t.textContent ?? '';
          } else {
            before += t.textContent ?? '';
          }
        }
        levels.push({ lastBefore: lastMarker(before), firstAfter: firstMarker(after) });
      }
      out.push({ text, levels });
    }

    return out;
  }, MARKER_LEVELS);

  return raw.map((piece) => ({ text: piece.text, insideTranslation: isInsideTranslation(piece.levels satisfies readonly MarkerContext[]) }));
}

export async function sameOriginLinks(page: Page, base: string): Promise<string[]> {
  const origin = new URL(base).origin;
  const hrefs = await page.$$eval('a[href]', (anchors) => anchors.map((a) => (a as HTMLAnchorElement).href));

  return hrefs
    .map((href) => {
      try {
        return new URL(href);
      } catch {
        return null;
      }
    })
    .filter((url): url is URL => url !== null && url.origin === origin && !/logout|delete|destroy|download|\/api\//i.test(url.pathname))
    .map((url) => url.pathname)
    .sort();
}

export async function runSmoke(options: SmokeOptions): Promise<SmokeReport> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL: options.base, locale: 'en-US' });
    context.setDefaultTimeout(options.timeoutMs);
    const page = await context.newPage();
    let jsErrors = 0;
    page.on('pageerror', () => {
      jsErrors++;
    });

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.fill('input[name="email"]', options.email);
    await page.fill('input[name="password"]', options.password);
    await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login')), page.click('button[type="submit"]')]);

    const queue = [...START_PATHS];
    const seen = new Set<string>();
    const reports: PageReport[] = [];
    const counts = new Map<string, number>();
    while (queue.length > 0 && reports.length < options.maxPages) {
      const path = queue.shift();
      if (path === undefined || seen.has(path)) {
        continue;
      }
      seen.add(path);
      jsErrors = 0;
      const response = await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
      const status = response?.status() ?? 0;
      const body = await page.textContent('body').catch(() => '') ?? '';
      const title = await page.title().catch(() => '');
      const summary = summarizeTexts(await visibleTexts(page).catch(() => []));
      for (const text of summary.untranslated) {
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      reports.push({
        path,
        finalPath: new URL(page.url()).pathname,
        status,
        error: isErrorPage({ status, title, body }),
        jsErrors,
        texts: { total: summary.total, translated: summary.translated, untranslatedSample: summary.untranslated.slice(0, 15) },
      });
      if (START_PATHS.includes(path)) {
        for (const link of await sameOriginLinks(page, options.base).catch(() => [])) {
          if (!seen.has(link) && !queue.includes(link)) {
            queue.push(link);
          }
        }
      }
    }

    return {
      base: options.base,
      pages: reports,
      totals: smokeTotals(reports),
      untranslatedTop: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 60).map(([text, count]) => ({ text, count })),
    };
  } finally {
    await browser.close();
  }
}
