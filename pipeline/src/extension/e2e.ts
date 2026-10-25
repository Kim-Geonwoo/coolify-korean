import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import type { ExtensionDictionary } from '../../../extension/src/engine.ts';
import { looksUntranslated } from '../screenshots/gaps.ts';
import { DEMO_SEED_PHP } from '../screenshots/seed.ts';
import { START_PATHS } from '../smoke.ts';
import { buildTestEnv } from '../testInstance.ts';
import { imageRef, loadState } from '../sync/state.ts';
import { pack } from './pack.ts';

/**
 * 확장 e2e(방법 C, Chromium). 공식 이미지로 영어 시험 인스턴스를 띄우고(다른 세션과 겹치지 않게 프로젝트 coolify-ko-ext, 포트 18090),
 * 확장을 실은 Chromium으로 확인 항목 1~6을 본다. 같은 쪽을 확장 없이도 돌려(기준) 콘솔 오류·영어 비율을 대조한다.
 *   node pipeline/src/extension/cli.ts e2e [--keep] [--report 파일]
 */
const root = join(import.meta.dirname, '..', '..', '..');
const work = join(root, '.work', 'extension');
const instanceDir = join(work, 'test-instance');
const PROJECT = 'coolify-ko-ext';
const PORT = 18090;
export const ORIGIN = `http://127.0.0.1:${String(PORT)}`;
// 확장 사전이 따르는 상류 판(i18n/state.json, 다이제스트 고정). 4.4.6에 박아 둬 4.5.0 스토어 사진도 옛 화면이었다(2026-10-25)
const IMAGE = imageRef(loadState(join(root, 'i18n', 'state.json')));
const EMAIL = 'e2e@coolify-ko.invalid';
const POLL_WAIT_MS = 12_000;
const HANGUL = /[가-힣]/;
// 업스트림 RootUserSeeder와 같은 필드로 루트 계정(id 0)을 만든다(시드의 이메일 DNS 검사만 건너뛴다. screenshots/runCli.ts와 같은 방식)
const ROOT_USER_PHP = String.raw`$u = (new App\Models\User)->forceFill(['id' => 0, 'name' => 'Root User', 'email' => getenv('ROOT_USER_EMAIL'), 'password' => Illuminate\Support\Facades\Hash::make(getenv('ROOT_USER_PASSWORD'))]); $u->save(); $t = App\Models\Team::find(0); if ($t !== null && ! $u->teams()->where('team_id', 0)->exists()) { $u->teams()->attach($t, ['role' => 'owner']); } echo 'ROOT OK';`;

export interface TextMeasure {
  readonly total: number;
  readonly english: number;
  readonly korean: number;
  readonly ratio: number;
  readonly englishSample: readonly string[];
}

/** 화면 글 조각 중 글자가 있는 것 대비, 번역 안 된 영어 문구(스크린샷 파이프라인의 looksUntranslated)의 비율 */
export function measureTexts(texts: readonly string[]): TextMeasure {
  let total = 0;
  let korean = 0;
  const english: string[] = [];
  for (const raw of texts) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!/\p{L}/u.test(text)) {
      continue;
    }
    total++;
    if (HANGUL.test(text)) {
      korean++;
    } else if (looksUntranslated(text)) {
      english.push(text);
    }
  }

  return { total, english: english.length, korean, ratio: total === 0 ? 0 : english.length / total, englishSample: english.slice(0, 20) };
}

const normalizeError = (message: string): string => message.replace(/\b[a-z]+:\/\/\S+/gi, '<url>').replace(/[0-9a-f]{6,}/gi, '<id>').replace(/\d+/g, '<n>').trim();

// 시험 인스턴스에 실시간 서비스(soketi)가 없어서 나는 Coolify 자체 오류. 쪽에 오래 머물수록 늘어 기준 실행과 수가 다르다
const ENVIRONMENT_ERRORS = [/could not connect to its real-time service/, /^WebSocket connection to .* failed/];

/** 확장을 실었을 때만 보인 콘솔 오류(주소·숫자·id는 무시하고 기준 실행과 대조, 실시간 서비스 없음 오류는 뺀다) */
export function extraErrors(withExtension: readonly string[], baseline: readonly string[]): string[] {
  const known = new Set(baseline.map(normalizeError));

  return withExtension.filter((message) => !known.has(normalizeError(message)) && !ENVIRONMENT_ERRORS.some((pattern) => pattern.test(message)));
}

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function run(what: string, command: string, args: readonly string[], timeoutMs: number, env: NodeJS.ProcessEnv = process.env): string {
  const result = spawnSync(command, args, { cwd: instanceDir, encoding: 'utf8', timeout: timeoutMs, env, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0) {
    const tail = result.stderr.trim().split('\n').slice(-3).join(' / ').slice(0, 400);
    throw new Error(`${what} 실패(${result.error?.message ?? `종료 ${String(result.status)}`})${tail === '' ? '' : `: ${tail}`}`);
  }

  return result.stdout;
}

function readEnv(file: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) {
      map.set(line.slice(0, at), line.slice(at + 1).trim());
    }
  }

  return map;
}

export interface Instance {
  readonly email: string;
  readonly password: string;
  readonly environment: string;
  readonly down: () => void;
}

/** 시험 인스턴스를 새로 띄운다(이 프로젝트만 지우고 다시 만든다). 다른 compose 프로젝트는 건드리지 않는다 */
export async function startInstance(): Promise<Instance> {
  mkdirSync(join(instanceDir, 'lang-runtime'), { recursive: true });
  copyFileSync(join(root, 'tools', 'test-instance', 'docker-compose.yml'), join(instanceDir, 'docker-compose.yml'));
  writeFileSync(join(instanceDir, '.env'), buildTestEnv({ port: PORT, email: EMAIL }), { mode: 0o600 });
  const env = readEnv(join(instanceDir, '.env'));
  // 비밀번호는 argv가 아니라 환경 변수로 넘긴다
  const composeEnv = { ...process.env, COOLIFY_TEST_IMAGE: IMAGE, COOLIFY_LOCALE: 'en', APP_PORT: String(PORT), REDISCLI_AUTH: env.get('REDIS_PASSWORD') ?? '' };
  const compose = (what: string, args: readonly string[], timeoutMs: number): string =>
    run(what, 'docker', ['compose', '-p', PROJECT, '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), ...args], timeoutMs, composeEnv);
  const psql = (sql: string): string => compose('시험 DB 질의', ['exec', '-T', 'postgres', 'psql', '-U', env.get('DB_USERNAME') ?? 'coolify', '-d', env.get('DB_DATABASE') ?? 'coolify', '-tAc', sql], 60_000).trim();
  const down = (): void => {
    spawnSync('docker', ['compose', '-p', PROJECT, '--project-directory', instanceDir, '-f', join(instanceDir, 'docker-compose.yml'), 'down', '-v', '--remove-orphans'], { cwd: instanceDir, env: composeEnv, windowsHide: true, stdio: 'ignore', timeout: 5 * 60_000 });
  };

  down();
  compose('시험 인스턴스 기동', ['up', '-d', '--wait', '--wait-timeout', '600'], 15 * 60_000);
  const until = Date.now() + 10 * 60_000;
  while (psql('select count(*) from teams where id = 0;') !== '1') {
    if (Date.now() > until) {
      throw new Error('시드(루트 팀)가 10분 안에 끝나지 않았습니다.');
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  if (psql('select count(*) from users where id = 0;') !== '1') {
    compose('시험 계정 만들기', ['exec', '-T', 'coolify', 'php', 'artisan', 'tinker', '--execute', ROOT_USER_PHP], 2 * 60_000);
  }
  const seeded = compose('예시 리소스 만들기', ['exec', '-T', 'coolify', 'php', 'artisan', 'tinker', '--execute', DEMO_SEED_PHP], 5 * 60_000);
  console.log(seeded.split('\n').filter((line) => line.startsWith('SEED')).join('\n').slice(0, 1000));
  psql('update teams set show_boarding = false;');
  // 기본 확인 문구('Confirm Deletion')를 쓰는 모달(정적 사이트의 Nginx 설정 생성)이 보이게 예시 앱 하나를 정적으로 둔다
  psql("update application_settings set is_static = true where application_id = (select id from applications where uuid = 'demo-dockerfile');");
  compose('Redis 비우기', ['exec', '-T', '-e', 'REDISCLI_AUTH', 'redis', 'redis-cli', 'FLUSHALL'], 60_000);
  const environment = psql("select e.uuid from environments e join projects p on p.id = e.project_id where p.uuid = 'demo' order by e.id limit 1;");
  if (environment === '') {
    throw new Error('예시 프로젝트의 환경을 찾지 못했습니다.');
  }

  return { email: env.get('ROOT_USER_EMAIL') ?? EMAIL, password: env.get('ROOT_USER_PASSWORD') ?? '', environment, down };
}

/** 보이는 글 노드와 화면 문구 속성(placeholder·title·aria-label)을 모은다 */
async function visibleTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const parent = node.parentElement;
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (text !== '' && parent !== null && !['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(parent.tagName) && parent.checkVisibility()) {
        out.push(text.slice(0, 300));
      }
    }
    for (const element of Array.from(document.querySelectorAll<HTMLElement>('[placeholder],[title],[aria-label]'))) {
      if (element.checkVisibility()) {
        for (const name of ['placeholder', 'title', 'aria-label']) {
          const value = element.getAttribute(name)?.trim();
          if (value !== undefined && value !== '') {
            out.push(value.slice(0, 300));
          }
        }
      }
    }

    return out;
  });
}

/** 영어 문구가 그대로 보이는 글 노드 수(정확히 그 문구인 노드만) */
async function visibleExactly(page: Page, labels: readonly string[]): Promise<Record<string, number>> {
  return page.evaluate((wanted) => {
    const counts: Record<string, number> = Object.fromEntries(wanted.map((label) => [label, 0]));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      const text = (node.nodeValue ?? '').replace(/\s+/g, ' ').trim();
      if (text in counts && node.parentElement?.checkVisibility() === true) {
        counts[text] = (counts[text] ?? 0) + 1;
      }
    }

    return counts;
  }, labels);
}

/** labels의 번역이 화면에 보이고, 영어 그대로인 노드가 없는지 */
async function translatedLabels(page: Page, dictionary: ExtensionDictionary, labels: readonly string[]): Promise<{ ok: boolean; detail: string }> {
  const body = await page.evaluate(() => document.body.innerText);
  const english = await visibleExactly(page, labels);
  const problems = labels.flatMap((label) => {
    const korean = dictionary.exact[label];
    if (korean === undefined) {
      return [`사전에 없음: ${label}`];
    }

    return [...(body.includes(korean) ? [] : [`안 보임: ${korean}`]), ...((english[label] ?? 0) > 0 ? [`영어 그대로: ${label}`] : [])];
  });

  return { ok: problems.length === 0, detail: problems.length === 0 ? `${String(labels.length)}개 문구 한국어` : problems.join(', ') };
}

export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

export async function login(page: Page, instance: Instance): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.fill('input[name="email"]', instance.email);
  await page.fill('input[name="password"]', instance.password);
  await Promise.all([page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 }), page.click('button[type="submit"]')]);
  await settle(page);
}

export const MODAL = 'body > [x-show="modalOpen"]';

/** 열린 확인 모달에서 확인 문구를 읽고, 그것을 입력하면 확인 단추가 켜지는지 본다. 단추는 누르지 않고 닫는다 */
async function confirmModal(page: Page, expected: string): Promise<{ ok: boolean; detail: string }> {
  const modal = page.locator(MODAL).filter({ visible: true }).last();
  await modal.waitFor({ state: 'visible', timeout: 10_000 });
  const next = modal.locator('div[x-show="step === 1"] button').filter({ visible: true });
  if ((await next.count()) > 0) {
    await next.first().click();
  }
  const shown = modal.locator('input[readonly]').filter({ visible: true }).first();
  await shown.waitFor({ state: 'visible', timeout: 10_000 });
  const confirmation = await shown.inputValue();
  const confirm = modal.locator('[x-bind\\:disabled]').filter({ visible: true }).first();
  const disabledBefore = await confirm.isDisabled();
  await modal.locator('input[x-model="userConfirmationText"]').fill(confirmation);
  await page.waitForTimeout(300);
  const disabledAfter = await confirm.isDisabled();
  await page.keyboard.press('Escape');
  const ok = confirmation === expected && disabledBefore && !disabledAfter;

  return { ok, detail: `확인 문구 "${confirmation}"(기대 "${expected}"), 입력 전 단추 ${disabledBefore ? '꺼짐' : '켜짐'} → 입력 뒤 ${disabledAfter ? '꺼짐' : '켜짐'}` };
}

export async function openTrigger(page: Page, pattern: RegExp): Promise<boolean> {
  return page.evaluate((source) => {
    const wanted = new RegExp(source);
    const triggers = Array.from(document.querySelectorAll<HTMLElement>('[\\@click]')).filter((element) => /modalOpen\s*=\s*true/.test(element.getAttribute('@click') ?? '') && element.checkVisibility() && wanted.test(element.textContent));
    triggers[0]?.click();

    return triggers.length > 0;
  }, pattern.source);
}

interface Pass {
  readonly ratios: Record<string, TextMeasure>;
  readonly errors: string[];
}

/** 같은 쪽 목록을 돌며 영어 비율을 잰다(콘솔 오류는 page에 걸린 수집기가 모은다) */
async function measurePages(page: Page, paths: readonly string[], wantKorean: boolean): Promise<Record<string, TextMeasure>> {
  const ratios: Record<string, TextMeasure> = {};
  for (const path of paths) {
    const response = await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => null);
    if (response === null || response.status() >= 400) {
      continue;
    }
    await settle(page);
    if (wantKorean) {
      await page.waitForFunction(() => /[가-힣]/.test(document.body.innerText), undefined, { timeout: 5000 }).catch(() => undefined);
    }
    ratios[path] = measureTexts(await visibleTexts(page));
  }

  return ratios;
}

function collectErrors(page: Page, into: string[]): void {
  page.on('console', (message) => {
    if (message.type() === 'error') {
      into.push(`${message.text()} @ ${message.location().url}`);
    }
  });
  page.on('pageerror', (error) => {
    into.push(`pageerror: ${error.message}`);
  });
}

async function baselinePass(instance: Instance, paths: readonly string[]): Promise<Pass> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL: ORIGIN, locale: 'en-US', viewport: { width: 1440, height: 900 } });
    context.setDefaultTimeout(30_000);
    const page = await context.newPage();
    const errors: string[] = [];
    collectErrors(page, errors);
    await login(page, instance);

    return { ratios: await measurePages(page, paths, false), errors };
  } finally {
    await browser.close();
  }
}

export async function extensionContext(extensionDir: string, profile: string, viewport: { readonly width: number; readonly height: number } = { width: 1440, height: 900 }): Promise<{ context: BrowserContext; id: string }> {
  // 확장은 persistent context에서만 실린다. headless shell은 확장을 못 실어 전체 Chromium(channel chromium, 새 headless)을 쓴다
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    baseURL: ORIGIN,
    locale: 'en-US',
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: 1,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  context.setDefaultTimeout(30_000);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
  const id = new URL(worker.url()).host;
  // 설치 직후 background가 묶음 사전을 저장소에 옮길 때까지 기다린다
  for (let attempt = 0; attempt < 50; attempt++) {
    const ready = await worker.evaluate(async () => (await chrome.storage.local.get(['bundled']))['bundled'] !== undefined);
    if (ready) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  return { context, id };
}

export interface Enabled {
  /** background의 응답({ ok: true }면 켜짐) */
  readonly answer: unknown;
  /** 동적으로 등록된 content script의 matches */
  readonly registered: string[][];
}

/** 켜기: popup이 권한 요청 뒤 보내는 메시지와 같은 길(e2e 판은 시험 주소 권한이 설치 때 허락돼 있다) */
export async function enableOrigin(context: BrowserContext, id: string): Promise<Enabled> {
  const popup = await context.newPage();
  try {
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const answer = await popup.evaluate(async (origin) => chrome.runtime.sendMessage({ type: 'enable', origin }), ORIGIN);
    const registered = await popup.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((script) => script.matches ?? []));

    return { answer, registered };
  } finally {
    await popup.close();
  }
}

/** 켜기 응답이 ok이고 시험 주소 하나만 등록됐는지 */
export const isEnabled = (enabled: Enabled): boolean => JSON.stringify(enabled.answer) === '{"ok":true}' && JSON.stringify(enabled.registered) === JSON.stringify([[`${ORIGIN}/*`]]);

export async function runE2e(argv: readonly string[]): Promise<void> {
  const keep = argv.includes('--keep');
  const reportIndex = argv.indexOf('--report');
  const reportPath = reportIndex >= 0 ? (argv[reportIndex + 1] ?? '') : join(work, 'e2e-report.json');
  const extensionDir = join(work, 'e2e-chrome');
  pack('chrome', extensionDir, { e2eOrigin: ORIGIN });
  const dictionary = JSON.parse(readFileSync(join(extensionDir, 'dictionary.json'), 'utf8')) as ExtensionDictionary;
  const profile = mkdtempSync(join(tmpdir(), 'coolify-ko-ext-'));
  const checks: Check[] = [];
  const check = (name: string, result: { ok: boolean; detail: string }): void => {
    checks.push({ name, ...result });
    console.log(`${result.ok ? '✓' : '✗'} ${name}: ${result.detail}`);
  };

  const instance = await startInstance();
  try {
    const app = `/project/demo/environment/${instance.environment}/application/demo-nixpacks`;
    const database = `/project/demo/environment/${instance.environment}/database/demo-postgres`;
    const paths = [...START_PATHS.filter((path) => path !== '/onboarding' && path !== '/terminal'), app, database];
    const baseline = await baselinePass(instance, paths);

    const { context, id } = await extensionContext(extensionDir, profile);
    try {
      const enabled = await enableOrigin(context, id);
      check('켜기·동적 등록', { ok: isEnabled(enabled), detail: `응답 ${JSON.stringify(enabled.answer)}, 등록 ${JSON.stringify(enabled.registered)}` });

      const page = await context.newPage();
      const errors: string[] = [];
      collectErrors(page, errors);

      // 1. 로그인·대시보드 주요 문구
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      await settle(page);
      check('1a /login 한국어', await translatedLabels(page, dictionary, ['Login', 'Email', 'Password']));
      await login(page, instance);
      check('1b 대시보드 한국어', await translatedLabels(page, dictionary, ['Dashboard', 'Projects', 'Servers', 'Settings']));

      // 2. Livewire 갱신(wire:poll 10초) 뒤에도 한국어 유지
      const livewire: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/livewire') && request.method() === 'POST') {
          livewire.push(request.url());
        }
      });
      await page.goto(app, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const pollLabels = ['Deploy', 'Links', 'General'];
      const before = await translatedLabels(page, dictionary, pollLabels);
      // 페이지 쪽 관찰자: 한국어였던 글 노드를 앱(morph)이 바꾼 기록을 모은다. 확장은 한국어를 바꾸지 않으므로 이 기록은 모두 앱의 되돌림이다
      await page.evaluate(() => {
        const reverted = new Set<Node>();
        (window as unknown as { coolifyKoE2e: Set<Node> }).coolifyKoE2e = reverted;
        new MutationObserver((records) => {
          for (const record of records) {
            if (/[가-힣]/.test(record.oldValue ?? '')) {
              reverted.add(record.target);
            }
          }
        }).observe(document.documentElement, { subtree: true, characterData: true, characterDataOldValue: true });
      });
      livewire.length = 0;
      const ratioBefore = measureTexts(await visibleTexts(page)).ratio;
      await page.waitForTimeout(POLL_WAIT_MS);
      const counters = await page.evaluate(() => {
        const reverted = [...(window as unknown as { coolifyKoE2e: Set<Node> }).coolifyKoE2e];
        const english = reverted.filter((node) => node.isConnected && !/[가-힣]/.test(node.nodeValue ?? ''));

        return { reverts: reverted.length, stillEnglish: english.length, sample: english.slice(0, 5).map((node) => node.nodeValue ?? '') };
      });
      const after = await translatedLabels(page, dictionary, pollLabels);
      const ratioAfter = measureTexts(await visibleTexts(page)).ratio;
      check('2 Livewire 갱신 뒤 유지', {
        ok: before.ok && after.ok && livewire.length > 0 && counters.reverts > 0 && counters.stillEnglish === 0 && ratioAfter <= ratioBefore + 0.01,
        detail: `${String(POLL_WAIT_MS / 1000)}초 동안 Livewire 요청 ${String(livewire.length)}번, morph가 바꾼 한국어 글 노드 ${String(counters.reverts)}개 중 영어로 남은 것 ${String(counters.stillEnglish)}개${counters.sample.length > 0 ? `(${counters.sample.join(' | ')})` : ''}, 영어 비율 ${ratioBefore.toFixed(3)} → ${ratioAfter.toFixed(3)} (전 ${before.detail} / 뒤 ${after.detail})`,
      });

      // 3. 확인 문구: 삭제 모달(리소스 이름)과 기본 확인 문구 'Confirm Deletion'(DB 파일 복원 모달)
      await page.goto(`${app}/danger`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const deleteOpened = await openTrigger(page, /삭제|Delete/);
      const deleteResult = deleteOpened ? await confirmModal(page, 'demo-nixpacks') : { ok: false, detail: '삭제 단추를 못 찾음' };
      await page.goto(`/project/demo/environment/${instance.environment}/application/demo-dockerfile`, { waitUntil: 'domcontentloaded' });
      await settle(page);
      const generate = dictionary.exact['Generate default'] ?? 'Generate default';
      const nginxOpened = await openTrigger(page, new RegExp(`${generate}|Generate default`));
      const nginxResult = nginxOpened ? await confirmModal(page, 'Confirm Deletion') : { ok: false, detail: 'Nginx 설정 생성 단추를 못 찾음' };
      check('3 확인 문구 그대로·입력하면 단추 켜짐', { ok: deleteResult.ok && nginxResult.ok, detail: `삭제 모달: ${deleteResult.detail} / 기본 확인 문구(Nginx 설정 생성 모달): ${nginxResult.detail}` });

      // 4. value 없는 option. Coolify 4.4.6 화면에는 <option>이 없어(뷰 462개 실측 0개) 실제 쪽에 시험용 select를 넣어 본다
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await settle(page);
      await page.evaluate(() => {
        const holder = document.createElement('div');
        holder.id = 'coolify-ko-e2e-options';
        const select = document.createElement('select');
        const bare = document.createElement('option');
        bare.textContent = 'Save';
        const valued = document.createElement('option');
        valued.value = 'save';
        valued.textContent = 'Save';
        const span = document.createElement('span');
        span.textContent = 'Save';
        select.append(bare, valued);
        holder.append(select, span);
        document.body.append(holder);
      });
      await page.waitForTimeout(300);
      const options = await page.evaluate(() => {
        const holder = document.getElementById('coolify-ko-e2e-options');
        const result = { bare: holder?.querySelectorAll('option')[0]?.textContent ?? '', valued: holder?.querySelectorAll('option')[1]?.textContent ?? '', span: holder?.querySelector('span')?.textContent ?? '' };
        holder?.remove();

        return result;
      });
      const save = dictionary.exact['Save'] ?? '';
      check('4 value 없는 option 그대로', { ok: options.bare === 'Save' && options.valued === save && options.span === save, detail: `value 없음 "${options.bare}", value 있음 "${options.valued}", 같은 글의 span "${options.span}"` });

      // 6. 영어 비율(확장) — 콘솔 오류도 이 순회까지 모은다
      const ratios = await measurePages(page, paths, true);
      // 5. 콘솔 오류: 확장 쪽에서만 보인 것, 확장 스크립트에서 난 것
      const extra = extraErrors(errors, baseline.errors);
      const fromExtension = errors.filter((message) => message.includes('chrome-extension://'));
      check('5 콘솔 오류 0(확장 탓)', { ok: extra.length === 0 && fromExtension.length === 0, detail: `확장 실행 오류 ${String(errors.length)}건 · 기준(확장 없음) ${String(baseline.errors.length)}건 · 확장에서만 ${String(extra.length)}건 · 확장 스크립트발 ${String(fromExtension.length)}건${extra.length > 0 ? `: ${extra.slice(0, 5).join(' | ')}` : ''}` });

      const sum = (measures: Record<string, TextMeasure>): { total: number; english: number; ratio: number } => {
        const values = Object.values(measures);
        const total = values.reduce((acc, item) => acc + item.total, 0);
        const english = values.reduce((acc, item) => acc + item.english, 0);

        return { total, english, ratio: total === 0 ? 0 : english / total };
      };
      const withExt = sum(ratios);
      const without = sum(baseline.ratios);
      const missedTop = new Map<string, number>();
      for (const measure of Object.values(ratios)) {
        for (const text of measure.englishSample) {
          missedTop.set(text, (missedTop.get(text) ?? 0) + 1);
        }
      }
      console.log(`6 영어 비율: 확장 ${(withExt.ratio * 100).toFixed(1)}% (${String(withExt.english)}/${String(withExt.total)}, ${String(Object.keys(ratios).length)}쪽) · 확장 없음 ${(without.ratio * 100).toFixed(1)}% (${String(without.english)}/${String(without.total)})`);
      writeFileSync(
        reportPath,
        `${JSON.stringify(
          {
            origin: ORIGIN,
            image: IMAGE,
            dictionaryVersion: dictionary.version,
            checks,
            englishRatio: { withExtension: withExt, baseline: without, pages: Object.fromEntries(Object.entries(ratios).map(([path, measure]) => [path, { ratio: measure.ratio, baseline: baseline.ratios[path]?.ratio ?? null, total: measure.total, english: measure.english }])) },
            untranslatedTop: [...missedTop.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40),
            consoleErrors: { withExtension: errors.slice(0, 50), baseline: baseline.errors.slice(0, 50) },
          },
          null,
          2,
        )}\n`,
      );
      console.log(`보고서: ${reportPath}`);
    } finally {
      await context.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
    if (!keep) {
      instance.down();
    }
  }
  const failed = checks.filter((item) => !item.ok);
  if (failed.length > 0) {
    throw new Error(`e2e 실패 ${String(failed.length)}건: ${failed.map((item) => item.name).join(', ')}`);
  }
  console.log(`e2e 통과(${String(checks.length)}개 확인)`);
}
