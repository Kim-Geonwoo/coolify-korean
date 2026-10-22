import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import type { ExtensionDictionary } from '../../../extension/src/engine.ts';
import { enableOrigin, extensionContext, isEnabled, login, MODAL, openTrigger, ORIGIN, settle, startInstance } from './e2e.ts';
import { pack } from './pack.ts';
import { privacyProblems, shotFileName, STORE_SIZE, storeImageProblem, storeShotPlan, type StoreShot } from './storeShots.ts';

/**
 * Chrome 웹 스토어 스크린샷. e2e와 같은 시험 인스턴스(coolify-ko-ext, 포트 18090)를 띄우고, 확장을 실은 Chromium(1280x800, 배율 1)으로
 * 예시 시드 쪽을 한국어로 찍어 JPEG로 쓴다. 다 찍은 뒤에야 out의 옛 screenshot-*.jpg를 바꾼다.
 *   node pipeline/src/extension/cli.ts store-shots [--keep] [--out .work/extension/store]
 */
const root = join(import.meta.dirname, '..', '..', '..');
const extensionDir = join(root, '.work', 'extension', 'store-chrome');
const JPEG_QUALITY = 92;
const OLD_SHOT = /^screenshot-\d+-[a-z0-9-]+\.jpg$/;

export interface StoreShotsOptions {
  readonly keep: boolean;
  readonly out: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 화면 글: 본문 글과, 보이는 입력칸 값(서버 IP 같은 값은 innerText에 없다) */
async function screenText(page: Page): Promise<string> {
  return page.evaluate(() =>
    [
      document.body.innerText,
      ...Array.from(document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea'))
        .filter((element) => element.type !== 'password' && element.checkVisibility())
        .map((element) => element.value),
    ].join('\n'),
  );
}

/** 번역이 가라앉을 때까지: 한글이 보이고, 글이 잠깐 사이에 더 바뀌지 않을 때까지 */
async function settleTranslation(page: Page): Promise<void> {
  await settle(page);
  await page.waitForFunction(() => /[가-힣]/.test(document.body.innerText), undefined, { timeout: 10_000 });
  let previous = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await page.evaluate(() => document.body.innerText);
    if (current === previous) {
      return;
    }
    previous = current;
    await page.waitForTimeout(400);
  }
}

async function capture(page: Page, shot: StoreShot, dictionary: ExtensionDictionary, email: string): Promise<Buffer> {
  const response = await page.goto(shot.path, { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (response === null || response.status() >= 400) {
    throw new Error(`${shot.path} 열기 실패(${response === null ? '응답 없음' : String(response.status())})`);
  }
  await settleTranslation(page);
  if (shot.modal !== undefined) {
    const korean = dictionary.exact[shot.modal];
    const pattern = new RegExp([shot.modal, ...(korean === undefined ? [] : [korean])].map(escapeRegExp).join('|'));
    if (!(await openTrigger(page, pattern))) {
      throw new Error(`${shot.path}: "${shot.modal}" 단추를 찾지 못했습니다.`);
    }
    await page.locator(MODAL).filter({ visible: true }).last().waitFor({ state: 'visible', timeout: 10_000 });
    await settleTranslation(page);
  }
  const problems = privacyProblems(await screenText(page), email);
  if (problems.length > 0) {
    throw new Error(`${shot.path}: ${problems.join(' ')}`);
  }
  const buffer = await page.screenshot({ type: 'jpeg', quality: JPEG_QUALITY, animations: 'disabled' });
  const problem = storeImageProblem(buffer);
  if (problem !== null) {
    throw new Error(`${shot.path}: ${problem}`);
  }

  return buffer;
}

export async function runStoreShots(options: StoreShotsOptions): Promise<string[]> {
  const started = Date.now();
  pack('chrome', extensionDir, { e2eOrigin: ORIGIN });
  const dictionary = JSON.parse(readFileSync(join(extensionDir, 'dictionary.json'), 'utf8')) as ExtensionDictionary;
  const profile = mkdtempSync(join(tmpdir(), 'coolify-ko-store-'));
  const shots: { readonly name: string; readonly buffer: Buffer }[] = [];

  const instance = await startInstance();
  try {
    const { context, id } = await extensionContext(extensionDir, profile, STORE_SIZE);
    try {
      const enabled = await enableOrigin(context, id);
      if (!isEnabled(enabled)) {
        throw new Error(`확장을 켜지 못했습니다: 응답 ${JSON.stringify(enabled.answer)}, 등록 ${JSON.stringify(enabled.registered)}`);
      }
      const page = await context.newPage();
      await login(page, instance);
      // Coolify의 '알림 없음'·후원 안내 팝업이 화면 아래를 가린다. 앱의 닫기 단추가 남기는 것과 같은 localStorage 시각으로 이번 달은 끈다
      await page.evaluate(() => {
        const now = String(Date.now());
        localStorage.setItem('popupNotification', now);
        localStorage.setItem('popupSponsorship', now);
      });
      for (const [index, shot] of storeShotPlan(instance.environment).entries()) {
        const name = shotFileName(index + 1, shot.slug);
        shots.push({ name, buffer: await capture(page, shot, dictionary, instance.email) });
        console.log(`✓ ${name} ← ${shot.path}${shot.modal === undefined ? '' : ` › ${shot.modal}`}`);
      }
    } finally {
      await context.close();
    }
  } finally {
    rmSync(profile, { recursive: true, force: true });
    if (!options.keep) {
      instance.down();
    }
  }

  mkdirSync(options.out, { recursive: true });
  for (const name of readdirSync(options.out).filter((file) => OLD_SHOT.test(file))) {
    rmSync(join(options.out, name));
  }
  const written = shots.map(({ name, buffer }) => {
    const file = join(options.out, name);
    writeFileSync(file, buffer);

    return file;
  });
  console.log(`스토어 스크린샷 ${String(written.length)}장(${String(STORE_SIZE.width)}x${String(STORE_SIZE.height)} JPEG, ${String(Math.round((Date.now() - started) / 1000))}초): ${options.out}`);

  return written;
}
