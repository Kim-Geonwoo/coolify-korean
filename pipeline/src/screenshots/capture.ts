import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { sameOriginLinks, START_PATHS } from '../smoke.ts';
import { collectAndStrip, MODAL_ROOT, modalTriggers, openModal } from './collect.ts';
import { Crawl, foldExamples } from './crawl.ts';
import { looksUntranslated } from './gaps.ts';
import { planTiles, TILE_HEIGHT } from './tiles.ts';

/**
 * 스크린샷 찍기. runCli가 Playwright 공식 컨테이너 안에서 돌린다(시험 인스턴스와 같은 compose 네트워크, Weblate 토큰 없음).
 * 키 표식 가짜 번역(markers.ts)으로 뜬 화면을 smoke처럼 돌며, 쪽마다 보이는 글·속성에서 키 번호를 모으고
 * 표식을 지워 영어 화면으로 되돌린 뒤 쪽을 세로 조각(tiles.ts)으로 찍는다. 쪽의 창(확인·입력)도 하나씩 열어 찍는다.
 * 결과: OUT/pages.json([{path, part | modal, file, ids}])과 WebP(안 되면 PNG), 표식 없이 보인 영어 목록 OUT/untranslated.json.
 * 환경: CAPTURE_BASE, CAPTURE_OUT, CAPTURE_EMAIL, CAPTURE_PASSWORD(버리는 시험 인스턴스 계정), CAPTURE_MAX_PAGES, CAPTURE_MAX_DEPTH,
 * CAPTURE_DEADLINE(이 시각(epoch ms)이 지나면 찍은 것까지 남기고 멈춘다)
 */
const base = process.env['CAPTURE_BASE'] ?? 'http://coolify:8080';
const out = process.env['CAPTURE_OUT'] ?? '/out';
const maxPages = Number(process.env['CAPTURE_MAX_PAGES'] ?? '300');
const maxDepth = Number(process.env['CAPTURE_MAX_DEPTH'] ?? '4');
const deadline = Number(process.env['CAPTURE_DEADLINE'] ?? String(Date.now() + 25 * 60_000));
const email = process.env['CAPTURE_EMAIL'] ?? '';
const password = process.env['CAPTURE_PASSWORD'] ?? '';
// 찍기 폭(Weblate 상한 2000px 안). 파일 이름이 세 자리라 1000장까지
const WIDTH = 1440;
const MAX_FILES = 1000;
// 쪽마다 여는 창 수와 하루 전체 상한(창마다 쪽을 새로 열어 시간이 든다)
const MODALS_PER_PAGE = 4;
const MAX_MODALS = 200;
const PUBLIC_PATHS = ['/login', '/register', '/forgot-password'];
// WebP 품질: 글자 가장자리가 뭉개지지 않는 선(실측으로 정함). 브라우저 내장 인코더라 따로 받을 것이 없다
const WEBP_QUALITY = 0.92;

interface Shot {
  readonly path: string;
  readonly part?: number;
  readonly modal?: string;
  readonly file: string;
  readonly ids: string[];
}

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ baseURL: base, locale: 'en-US', viewport: { width: WIDTH, height: 900 } });
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  // 이미지 변환은 시험 인스턴스 쪽이 아닌 빈 쪽에서 한다(화면 상태를 건드리지 않게)
  const converter = await context.newPage();
  mkdirSync(out, { recursive: true });
  const crawl = new Crawl(START_PATHS, { maxDepth, maxPages, screenOf: foldExamples });
  const finals = new Set<string>();
  const shots: Shot[] = [];
  let jsErrors = 0;
  page.on('pageerror', () => {
    jsErrors++;
  });
  const failed: string[] = [];
  const brokenJs: string[] = [];
  let modals = 0;
  let stoppedEarly = false;
  const nextName = (): string | undefined => (shots.length < MAX_FILES ? String(shots.length).padStart(3, '0') : undefined);
  let pngBytes = 0;
  let savedBytes = 0;
  // PNG를 브라우저(Chromium)의 WebP 인코더로 줄인다. 더 커지거나 실패하면 PNG 그대로
  const save = async (name: string, png: Buffer): Promise<string> => {
    pngBytes += png.byteLength;
    const webp = await converter
      .evaluate(
        async ([b64, quality]) => {
          const raw = Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
          const bitmap = await createImageBitmap(new Blob([raw], { type: 'image/png' }));
          const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
          const context2d = canvas.getContext('2d');
          if (context2d === null) {
            return '';
          }
          context2d.drawImage(bitmap, 0, 0);
          const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/webp', quality })).arrayBuffer());
          let text = '';
          for (let index = 0; index < bytes.length; index += 0x8000) {
            text += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }

          return btoa(text);
        },
        [png.toString('base64'), WEBP_QUALITY] as const,
      )
      .then((b64) => Buffer.from(b64, 'base64'))
      .catch(() => Buffer.alloc(0));
    const useWebp = webp.byteLength > 12 && webp.byteLength < png.byteLength;
    const file = `${name}.${useWebp ? 'webp' : 'png'}`;
    writeFileSync(join(out, file), useWebp ? webp : png);
    savedBytes += useWebp ? webp.byteLength : png.byteLength;

    return file;
  };
  // 표식 없이 보인 영어(오버레이가 감싸지 못한 글): 글 → 본 쪽(앞의 3개)
  const untranslated = new Map<string, string[]>();
  const note = (texts: readonly string[], where: string): void => {
    for (const text of texts.filter(looksUntranslated)) {
      const paths = untranslated.get(text) ?? [];
      if (paths.length < 3 && !paths.includes(where)) {
        paths.push(where);
      }
      untranslated.set(text, paths);
    }
  };
  const open = async (path: string): Promise<boolean> => {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => null);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);

    return response !== null && response.status() < 400;
  };
  // 표식을 모아 지우고 세로 조각으로 찍는다. Weblate는 2000px을 넘는 이미지를 거부한다: 조각마다 그 안에 보이는 키만 잇는다
  const shootTiles = async (finalPath: string): Promise<void> => {
    const { marks, height, plain } = await collectAndStrip(page);
    note(plain, finalPath);
    for (const tile of planTiles(marks, height)) {
      const name = nextName();
      if (name === undefined) {
        break;
      }
      const file = await save(name, await page.screenshot({ fullPage: true, clip: { x: 0, y: tile.y, width: WIDTH, height: tile.height } }));
      shots.push({ path: finalPath, part: Math.floor(tile.y / TILE_HEIGHT) + 1, file, ids: tile.ids });
    }
  };

  // 로그인 전 화면(로그인·가입·비밀번호 찾기)은 로그인하면 다시 볼 수 없어 먼저 찍는다
  for (const path of PUBLIC_PATHS) {
    if ((await open(path)) && !finals.has(new URL(page.url()).pathname)) {
      const finalPath = new URL(page.url()).pathname;
      finals.add(finalPath);
      await shootTiles(finalPath).catch(() => void failed.push(path));
    }
  }
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', email);
  await page.fill('input[name="password"]', password);
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login')), page.click('button[type="submit"]')]);

  for (let step = crawl.next(); step !== undefined; step = crawl.next()) {
    // 마감이 지나면 찍은 것까지만 남긴다(컨테이너가 시간 초과로 죽으면 목록이 통째로 없다)
    if (Date.now() > deadline) {
      stoppedEarly = true;
      break;
    }
    const { path, depth } = step;
    jsErrors = 0;
    const ok = await open(path);
    const finalPath = new URL(page.url()).pathname;
    // 이동에 실패했거나(응답 없음) 오류 쪽이면 찍지 않는다. 다른 경로가 같은 쪽으로 넘어가면(리다이렉트) 한 번만 찍는다
    if (!ok) {
      failed.push(path);
      continue;
    }
    if (finals.has(finalPath)) {
      continue;
    }
    finals.add(finalPath);
    const links = await sameOriginLinks(page, base).catch(() => []);
    const triggers = await modalTriggers(page).catch(() => []);
    try {
      await shootTiles(finalPath);
    } catch {
      // 한 쪽이 던져도(닫힌 페이지·시간 초과) 그날 전체를 버리지 않는다
      failed.push(path);
    }
    // 표식이 JS 로직 값에 들어가 화면 스크립트가 깨졌을 수 있는 쪽(찍기는 하되 알린다)
    if (jsErrors > 0) {
      brokenJs.push(finalPath);
    }
    crawl.add(links, depth);

    // 창(확인·입력)은 쪽을 새로 열고 단추를 눌러 창 안의 키만 찍는다. 이름이 같은 단추는 한 번만
    const labels = new Set<string>();
    for (const trigger of triggers) {
      if (labels.size >= MODALS_PER_PAGE || modals >= MAX_MODALS || Date.now() > deadline) {
        break;
      }
      if (labels.has(trigger.label)) {
        continue;
      }
      labels.add(trigger.label);
      try {
        if (!(await open(finalPath)) || !(await openModal(page, trigger.index))) {
          continue;
        }
        await page.waitForTimeout(700);
        const { marks, plain } = await collectAndStrip(page, MODAL_ROOT);
        note(plain, `${finalPath} › ${trigger.label}`);
        const ids = [...new Set(marks.map((mark) => mark.id))];
        const name = nextName();
        if (ids.length === 0 || name === undefined) {
          continue;
        }
        const file = await save(name, await page.screenshot());
        shots.push({ path: finalPath, modal: trigger.label, file, ids });
        modals++;
      } catch {
        failed.push(`${finalPath} › ${trigger.label}`);
      }
    }
  }
  writeFileSync(join(out, 'pages.json'), `${JSON.stringify(shots, null, 2)}\n`);
  const gaps = [...untranslated].sort((a, b) => a[0].localeCompare(b[0])).map(([text, paths]) => ({ text, paths }));
  writeFileSync(join(out, 'untranslated.json'), `${JSON.stringify(gaps, null, 2)}\n`);
  const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1);
  console.log(
    `찍은 쪽 ${String(finals.size)}(조각 ${String(shots.length - modals)} · 창 ${String(modals)}) · 돈 쪽 ${String(crawl.visited)} · 실패 ${String(failed.length)} · JS 오류 쪽 ${String(brokenJs.length)}${stoppedEarly ? ' · 마감으로 멈춤' : ''}`,
  );
  console.log(`이미지 ${mb(savedBytes)}MB(PNG ${mb(pngBytes)}MB에서 줄임) · 표식 없이 보인 영어 ${String(gaps.length)}개`);
  if (failed.length > 0 || brokenJs.length > 0) {
    console.log(`실패: ${failed.slice(0, 10).join(' ')} · JS 오류: ${brokenJs.slice(0, 10).join(' ')}`);
  }
} finally {
  await browser.close();
}
