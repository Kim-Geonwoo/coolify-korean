import { spawnSync } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCatalogVersion, buildArgs, loadState } from '../sync/state.ts';
import { buildTestEnv } from '../testInstance.ts';
import { createClient } from '../weblate/client.ts';
import { uploadScreenshots, type CapturedPage, type ScreenshotReport } from '../weblate/screenshots.ts';
import { imageArchive } from './archive.ts';
import { captureDoneKey } from './gaps.ts';
import { stepTimeout } from './budget.ts';
import { recordGaps, type UntranslatedGap } from './untranslated.ts';
import { keyedPseudo } from './markers.ts';
import { readCapturedList, readImage } from './pages.ts';
import { DEMO_SEED_PHP } from './seed.ts';

/**
 * 스크린샷 단계(우분투 2 밤 작업, 2026-10-18 사용자 결정). 업스트림 앱(codemod overlay 이미지)과 브라우저(Playwright 공식 이미지)를
 * 모두 rootless Docker 컨테이너 안에서 돌린다. 시험 인스턴스는 docker.sock을 마운트하지 않고 127.0.0.1에만 연다.
 * Weblate 토큰은 이 호스트 프로세스에만 있고 컨테이너에는 넘기지 않는다.
 */
// 레포 playwright 1.64.1과 같은 판(브라우저가 맞아야 한다)
const PLAYWRIGHT_IMAGE = 'mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf';
const PROJECT = 'coolify-ko-screens';
const CAPTURE_NAME = 'coolify-ko-screens-capture';
const BUDGET_MS = 50 * 60_000;
// 찍기 컨테이너 상한과, 그 안에서 찍기를 멈추고 목록을 쓰는 여유
const CAPTURE_MS = 30 * 60_000;
const CAPTURE_WRAP_MS = 2 * 60_000;
// 업스트림 RootUserSeeder와 같은 필드로 루트 계정(id 0)을 만들고 루트 팀(id 0)의 owner로 잇는다(DNS 검사만 건너뛴다)
const ROOT_USER_PHP = String.raw`$u = (new App\Models\User)->forceFill(['id' => 0, 'name' => 'Root User', 'email' => getenv('ROOT_USER_EMAIL'), 'password' => Illuminate\Support\Facades\Hash::make(getenv('ROOT_USER_PASSWORD'))]); $u->save(); $t = App\Models\Team::find(0); if ($t !== null && ! $u->teams()->where('team_id', 0)->exists()) { $u->teams()->attach($t, ['role' => 'owner']); } echo 'ROOT OK';`;
const PORT = 18081;
const EMAIL = 'screens@coolify-ko.invalid';
// HDD 볼륨(ops/ubuntu2/hdd.sh). 있으면 Playwright 이미지는 docker save 파일로만 두고(찍을 때만 SSD로 불러와 끝나면 지운다), 버전별 스크린샷(WebP·PNG)을 보관한다
const HDD = process.env['COOLIFY_KO_HDD'] ?? '/srv/coolify-ko/hdd';
const USAGE = '사용법: cli.ts screenshots run [--base-url http://127.0.0.1:8792] [--token-dir D(기본 $CREDENTIALS_DIRECTORY)] [--cache-dir D] [--report 파일] [--budget-min 50]';

export interface ScreensReport extends ScreenshotReport {
  readonly version: string;
  readonly pages: number;
  readonly keysCovered: number;
  readonly keysTotal: number;
  /** 표식 없이 보인 영어(번역 호출 밖) 수와, 지난 찍기에 없던 것(밤 작업이 알린다) */
  readonly untranslated: number;
  readonly newUntranslated: readonly UntranslatedGap[];
  readonly untranslatedSince?: string;
}

function run(what: string, command: string, args: readonly string[], options: { readonly cwd: string; readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv }): string {
  const result = spawnSync(command, args, { cwd: options.cwd, encoding: 'utf8', timeout: options.timeoutMs, env: options.env ?? process.env, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
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

/** 지난 실행이 남긴 시험 인스턴스·찍기 컨테이너를 치운다(시간 초과로 끊긴 경우). 실패해도 계속한다 */
export function cleanupScreens(): void {
  spawnSync('docker', ['rm', '-f', CAPTURE_NAME], { windowsHide: true, stdio: 'ignore', timeout: 2 * 60_000 });
  spawnSync('docker', ['compose', '-p', PROJECT, 'down', '-v', '--remove-orphans'], { windowsHide: true, stdio: 'ignore', timeout: 5 * 60_000 });
}

function hddReady(): boolean {
  try {
    accessSync(HDD, constants.W_OK);

    return statSync(HDD).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Playwright 이미지를 준비해 로컬 태그를 돌려준다: 이미 있으면 그대로, HDD에 저장본이 있으면 불러오고, 없으면 다이제스트로 받아
 * 로컬 태그를 붙인다(HDD가 있으면 저장본도 만든다). docker load는 레지스트리 다이제스트를 되살리지 않아 로컬 태그로 다룬다
 */
function preparePlaywright(root: string, hdd: boolean, limit: (capMs: number) => number): string {
  const { tag, file } = imageArchive(PLAYWRIGHT_IMAGE);
  const present = spawnSync('docker', ['image', 'inspect', tag], { windowsHide: true, stdio: 'ignore' }).status === 0;
  if (present) {
    return tag;
  }
  const archive = join(HDD, 'images', file);
  if (hdd && existsSync(archive)) {
    run('Playwright 이미지 불러오기(HDD)', 'docker', ['load', '-q', '-i', archive], { cwd: root, timeoutMs: limit(15 * 60_000) });

    return tag;
  }
  run('Playwright 이미지 받기', 'docker', ['pull', '-q', PLAYWRIGHT_IMAGE], { cwd: root, timeoutMs: limit(30 * 60_000) });
  run('Playwright 이미지 태그', 'docker', ['tag', PLAYWRIGHT_IMAGE, tag], { cwd: root, timeoutMs: 60_000 });
  if (hdd) {
    mkdirSync(join(HDD, 'images'), { recursive: true });
    const partial = `${archive}.partial`;
    run('Playwright 이미지 HDD 저장', 'docker', ['save', '-o', partial, tag], { cwd: root, timeoutMs: limit(15 * 60_000) });
    renameSync(partial, archive);
  }

  return tag;
}

export async function runScreenshots(options: { readonly root: string; readonly baseUrl: string; readonly tokenDir: string; readonly cacheDir: string; readonly node?: string; readonly budgetMs?: number }): Promise<ScreensReport> {
  const { root } = options;
  // 바깥(밤 작업)의 시간 제한보다 먼저 끝내 정리할 시간을 남긴다
  const deadline = Date.now() + (options.budgetMs ?? BUDGET_MS);
  const limit = (capMs: number): number => stepTimeout(capMs, deadline, Date.now());
  const state = loadState(join(root, 'i18n', 'state.json'));
  const catalog = JSON.parse(readFileSync(join(root, 'i18n', 'catalog.json'), 'utf8')) as { version: string };
  assertCatalogVersion(catalog, state);
  const version = state.upstream.version;
  const token = readFileSync(join(options.tokenDir, 'weblate-bridge.token'), 'utf8').trim();
  if (token === '') {
    throw new Error('Weblate 토큰 파일이 비어 있습니다: weblate-bridge.token');
  }

  const dir = join(root, '.work', 'screens');
  const out = join(dir, 'out');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(join(dir, 'lang-runtime'), { recursive: true });
  mkdirSync(out, { recursive: true });
  copyFileSync(join(root, 'tools', 'test-instance', 'docker-compose.yml'), join(dir, 'docker-compose.yml'));
  copyFileSync(join(root, 'tools', 'test-instance', 'screens.override.yml'), join(dir, 'screens.override.yml'));
  cleanupScreens();
  writeFileSync(join(dir, '.env'), buildTestEnv({ port: PORT, email: EMAIL }), { mode: 0o600 });
  const env = readEnv(join(dir, '.env'));
  const { translations, keys } = keyedPseudo(JSON.parse(readFileSync(join(root, 'i18n', 'en.json'), 'utf8')) as Record<string, string>);
  writeFileSync(join(dir, 'lang-runtime', 'xx.json'), JSON.stringify(translations));

  const hdd = hddReady();
  const playwright = preparePlaywright(root, hdd, limit);
  const image = `coolify-ko-overlay:${version}`;
  run('overlay 이미지 빌드', 'docker', ['build', ...buildArgs(state), '--target', 'overlay', '-t', image, '.'], { cwd: root, timeoutMs: limit(45 * 60_000) });

  // 비밀번호들은 argv가 아니라 환경 변수로 넘긴다(버리는 시험 인스턴스 값이지만 프로세스 목록에 남기지 않는다)
  const composeEnv = { ...process.env, COOLIFY_TEST_IMAGE: image, COOLIFY_LOCALE: 'xx', REDISCLI_AUTH: env.get('REDIS_PASSWORD') ?? '', CAPTURE_EMAIL: env.get('ROOT_USER_EMAIL') ?? EMAIL, CAPTURE_PASSWORD: env.get('ROOT_USER_PASSWORD') ?? '' };
  const compose = (what: string, args: readonly string[], timeoutMs: number): string =>
    run(what, 'docker', ['compose', '-p', PROJECT, '--project-directory', dir, '-f', join(dir, 'docker-compose.yml'), '-f', join(dir, 'screens.override.yml'), ...args], { cwd: dir, timeoutMs, env: composeEnv });
  const psql = (sql: string): string => compose('시험 DB 질의', ['exec', '-T', 'postgres', 'psql', '-U', env.get('DB_USERNAME') ?? 'coolify', '-d', env.get('DB_DATABASE') ?? 'coolify', '-tAc', sql], limit(60_000));

  try {
    compose('시험 인스턴스 기동', ['up', '-d', '--wait', '--wait-timeout', '600'], limit(15 * 60_000));
    // 컨테이너가 정상이 된 뒤에도 시드는 늦게 끝난다. 루트 팀(id 0)이 생기면 시드가 끝난 것으로 본다(마감 안에서 최대 10분)
    const appLogs = (): void => {
      // 원인을 볼 수 있게 시험 앱 로그 끝을 남긴다(버리는 시험 인스턴스)
      const logs = spawnSync('docker', ['compose', '-p', PROJECT, 'logs', '--no-color', '--tail', '40', 'coolify'], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: composeEnv });
      console.log(`--- 시험 앱 로그 끝 ---\n${`${logs.stdout}${logs.stderr}`.slice(-6000)}`);
    };
    const seedUntil = Date.now() + Math.min(10 * 60_000, limit(10 * 60_000));
    let team = '';
    while (team !== '1' && Date.now() < seedUntil) {
      team = psql('select count(*) from teams where id = 0;').trim();
      if (team !== '1') {
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
    }
    if (team !== '1') {
      appLogs();
      throw new Error('시드(루트 팀)가 끝나지 않았습니다.');
    }
    // 루트 계정은 업스트림 시드(RootUserSeeder)가 이메일 도메인의 DNS를 확인해(email:rfc,dns) 내부 네트워크에서는 만들지 못한다
    // (2026-10-18 리허설 2회). 시드와 같은 필드로 앱 안에서 직접 만든다. 이메일·비밀번호는 컨테이너 환경 변수에서 읽는다(argv에 없음)
    if (psql('select count(*) from users where id = 0;').trim() !== '1') {
      compose('시험 계정 만들기', ['exec', '-T', 'coolify', 'php', 'artisan', 'tinker', '--execute', ROOT_USER_PHP], limit(2 * 60_000));
      if (psql('select count(*) from users where id = 0;').trim() !== '1') {
        appLogs();
        throw new Error('시험 루트 계정을 만들지 못했습니다.');
      }
    }
    // 예시 리소스(서버·프로젝트·앱·DB·서비스): 상세 화면까지 찍으려고 만든다. 실패하면 빈 인스턴스로 찍는다
    try {
      const seeded = compose('예시 리소스 만들기', ['exec', '-T', 'coolify', 'php', 'artisan', 'tinker', '--execute', DEMO_SEED_PHP], limit(5 * 60_000));
      console.log(seeded.split('\n').filter((line) => line.startsWith('SEED')).join('\n').slice(0, 2000));
    } catch (error: unknown) {
      console.log(`예시 리소스를 만들지 못했습니다(빈 인스턴스로 찍습니다): ${(error instanceof Error ? error.message : String(error)).slice(0, 300)}`);
    }
    psql('update teams set show_boarding = false;');
    // currentTeam()이 팀을 Redis 캐시에 두므로 비워야 반영된다
    compose('Redis 비우기', ['exec', '-T', '-e', 'REDISCLI_AUTH', 'redis', 'redis-cli', 'FLUSHALL'], limit(60_000));

    // 찍기 컨테이너의 요약(찍은 쪽·실패·JS 오류 쪽)을 밤 작업·리허설 로그에 남긴다.
    // 찍기는 마감(CAPTURE_DEADLINE)에 스스로 멈춰 찍은 것까지 남긴다: 시간 초과로 죽으면 목록이 통째로 없다
    const captureMs = limit(CAPTURE_MS);
    const captureLog = run(
      '화면 찍기',
      'docker',
      [
        'run', '--rm', '--init', '--name', CAPTURE_NAME, '--network', `${PROJECT}_default`, '--shm-size', '1g', '--memory', '2g',
        // 레포 전체가 아니라 찍기에 필요한 것만 읽기 전용으로(시험 인스턴스 .env·문서를 보이지 않게)
        '-v', `${join(root, 'pipeline')}:/repo/pipeline:ro`, '-v', `${join(root, 'node_modules')}:/repo/node_modules:ro`, '-v', `${join(root, 'package.json')}:/repo/package.json:ro`,
        '-v', `${out}:/out`, '-v', `${options.node ?? process.execPath}:/usr/local/bin/coolify-ko-node:ro`,
        '-w', '/repo', '-e', 'CAPTURE_BASE=http://coolify:8080', '-e', 'CAPTURE_OUT=/out', '-e', 'CAPTURE_EMAIL', '-e', 'CAPTURE_PASSWORD', '-e', 'CAPTURE_DEADLINE',
        playwright, '/usr/local/bin/coolify-ko-node', 'pipeline/src/screenshots/capture.ts',
      ],
      { cwd: root, timeoutMs: captureMs, env: { ...composeEnv, CAPTURE_DEADLINE: String(Date.now() + captureMs - CAPTURE_WRAP_MS) } },
    );
    console.log(captureLog.trim().split('\n').slice(-3).join('\n').slice(0, 2000));
  } finally {
    try {
      compose('시험 인스턴스 내리기', ['down', '-v', '--remove-orphans'], 5 * 60_000);
    } catch (error: unknown) {
      console.log(error instanceof Error ? error.message : String(error));
    }
    spawnSync('docker', ['rm', '-f', CAPTURE_NAME], { windowsHide: true, stdio: 'ignore', timeout: 2 * 60_000 });
    if (hdd) {
      // SSD에는 찍는 동안만 둔다. Playwright는 HDD 저장본에서, overlay는 다음 버전에 다시 만든다
      spawnSync('docker', ['rmi', playwright, PLAYWRIGHT_IMAGE, image], { windowsHide: true, stdio: 'ignore' });
    }
  }

  // 컨테이너가 쓴 결과는 믿지 않는다: 형식·파일 이름·일반 파일·이미지 시그니처(PNG·WebP)를 확인한 것만 올린다(pages.ts)
  const pages: CapturedPage[] = readCapturedList(out, keys);
  const client = createClient({ baseUrl: options.baseUrl, token, timeoutMs: 120_000 });
  const uploaded = await uploadScreenshots(client, { pages, readImage: (file) => readImage(out, file) });
  if (hdd) {
    // 버전별 보관(HDD). 컨테이너가 쓴 폴더를 통째로 옮기지 않고, 검사를 거친 이미지와 정리한 목록만 쓴다
    const archived = join(HDD, 'screens', version);
    rmSync(archived, { recursive: true, force: true });
    mkdirSync(archived, { recursive: true });
    for (const page of pages) {
      try {
        writeFileSync(join(archived, page.file), readImage(out, page.file));
      } catch {
        // 업로드에서 이미 건너뛴 이미지다(보관도 건너뛴다)
      }
    }
    writeFileSync(join(archived, 'pages.json'), `${JSON.stringify(pages, null, 2)}\n`);
  }
  // 표식 없이 보인 영어는 지우기 전에 지난 찍기와 비교하고 다음 기준선으로 남긴다(2026-10-25 4.5.0 사이드바를 놓쳤다)
  mkdirSync(options.cacheDir, { recursive: true });
  const gaps = recordGaps(out, options.cacheDir, version);
  // 컨테이너가 쓴 출력은 SSD에 남기지 않는다(올렸고, 검사를 거친 이미지는 HDD에 보관했다)
  rmSync(out, { recursive: true, force: true });
  // 밤 작업이 같은 입력으로 다시 찍지 않게 남긴다(업로드까지 끝났을 때만). 찍기 코드·변환기·카탈로그가 바뀌면 다시 찍는다
  writeFileSync(join(options.cacheDir, 'screenshots.version'), `${captureDoneKey(root, version)}\n`);

  return {
    version,
    pages: pages.length,
    keysCovered: new Set(pages.flatMap((page) => page.keys)).size,
    keysTotal: keys.length,
    ...uploaded,
    untranslated: gaps.total,
    newUntranslated: gaps.fresh,
    ...(gaps.previousVersion === undefined ? {} : { untranslatedSince: gaps.previousVersion }),
  };
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

export async function screenshotsCommand(argv: readonly string[], root: string): Promise<void> {
  const tokenDir = option(argv, 'token-dir') ?? process.env['CREDENTIALS_DIRECTORY'];
  if (argv[1] !== 'run' || tokenDir === undefined) {
    throw new Error(USAGE);
  }
  const report = await runScreenshots({
    root,
    baseUrl: option(argv, 'base-url') ?? process.env['COOLIFY_KO_WEBLATE_URL'] ?? 'http://127.0.0.1:8792',
    tokenDir,
    cacheDir: option(argv, 'cache-dir') ?? join(root, '.work', 'weblate'),
    budgetMs: Number(option(argv, 'budget-min') ?? '50') * 60_000,
  });
  const reportPath = option(argv, 'report');
  if (reportPath !== undefined) {
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  console.log(`스크린샷: 쪽 ${String(report.pages)} · 키 ${String(report.keysCovered)}/${String(report.keysTotal)} · 새로 ${String(report.created)} · 바꿈 ${String(report.replaced)} · 이음 ${String(report.linked)} · 끊음 ${String(report.unlinked)} · 건너뜀 ${String(report.skipped)}`);
}
