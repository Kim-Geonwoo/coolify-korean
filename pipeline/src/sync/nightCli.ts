import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from '../i18n/integrity.ts';
import { buildReleaseImage, readTrustCommand, trustMessage } from '../release/image.ts';
import { captureDoneKey } from '../screenshots/gaps.ts';
import { postDiscord } from './discord.ts';
import { runNight, type NightDeps, type PublishPlan } from './night.ts';
import { decideCandidate } from '../publish/candidates.ts';
import { fetchHookFiles, hookFingerprint, hookIssues } from '../publish/hooks.ts';
import { parsePublished } from '../publish/ledger.ts';
import { loadState, parseState, syncDockerfileDefaults, type SyncState } from './state.ts';
import { discordMessage, emptyStatus, type JobStatus } from './status.ts';
import { appJwt, gitAuthEnv, installationToken, openPullRequest } from './githubApp.ts';
import { checkUpstream } from './upstream.ts';
import { langPaths, primaryLanguage } from '../i18n/languages.ts';

/**
 * 우분투 2의 밤 작업(systemd coolify-ko-sync.service가 coolify-ko 사용자로 실행한다).
 * 비밀값은 systemd LoadCredential=로 받은 파일($CREDENTIALS_DIRECTORY)에서만 읽고, 인자·환경 변수·로그에 넣지 않는다.
 */
const env = (name: string, fallback: string, pattern: RegExp): string => {
  const value = process.env[name] ?? fallback;
  if (!pattern.test(value)) {
    throw new Error(`${name} 값이 형식에 맞지 않습니다.`);
  }

  return value;
};
const BASE = env('COOLIFY_KO_BASE', '/srv/coolify-ko', /^\/[A-Za-z0-9._/-]+$/);
const WORK = join(BASE, 'work', 'coolify-ko');
// 리허설은 기준 브랜치·푸시 브랜치·캐시를 바꿔 돈다. 푸시는 bot/* 말고는 받지 않는다
const BRANCH = env('COOLIFY_KO_BRANCH', 'dev', /^[A-Za-z0-9._/-]+$/);
const PUSH_BRANCH = env('COOLIFY_KO_PUSH_BRANCH', 'bot/i18n', /^bot\/[a-z0-9-]+$/);
const CACHE = env('COOLIFY_KO_CACHE', join(BASE, 'cache'), /^\/[A-Za-z0-9._/-]+$/);
if (!CACHE.startsWith(`${BASE}/`)) {
  throw new Error('COOLIFY_KO_CACHE는 COOLIFY_KO_BASE 아래여야 합니다.');
}
const NUMA_NODE = Number(env('COOLIFY_KO_NUMA_NODE', '0', /^[01]$/));
const THREADS = Number(env('COOLIFY_KO_THREADS', '8', /^\d{1,2}$/));
// 하루 Flash 요청 몫(서버 전용 프로젝트). 리허설은 줄여서 아낀다
const REVIEW_REQUESTS = env('COOLIFY_KO_REVIEW_REQUESTS', '15', /^(?:[4-9]|1[0-5])$/);
const LIMITS = { memoryGiB: Number(env('COOLIFY_KO_MIN_MEMORY_GIB', '10', /^\d{1,5}$/)), diskGiB: Number(env('COOLIFY_KO_MIN_DISK_GIB', '40', /^\d{1,5}$/)) };
const LLAMA_PORT = 8091;
const LLAMA = join(BASE, 'tools', 'llama-b11700', 'llama-server');
const MODEL = join(BASE, 'models', 'Index-Translate-9B.Q5_K_M.gguf');
// Weblate(비치명 단계). 무엇을 올렸는지는 Weblate 쪽 상태라 리허설(COOLIFY_KO_CACHE를 바꿈)도 같은 기록을 쓴다
const WEBLATE_CACHE = join(BASE, 'cache', 'weblate');
const WEBLATE_URL = env('COOLIFY_KO_WEBLATE_URL', 'http://127.0.0.1:8792', /^http:\/\/127\.0\.0\.1:\d{1,5}$/);
/** systemd TimeoutStartSec(2시간 30분)보다 먼저 스스로 멈춘다 */
const BUDGET_MS = (2 * 60 + 15) * 60_000;
const ENGINE = 'index-9b-cpu';
/** 초안 단계 뒤(검토 30분 상한·Weblate·verify·커밋·푸시)에 남겨 둘 시간. 그 나머지만 엔진에 준다(2026-10-24 4.5.0이 상한에 끊겨 하나도 못 올렸다) */
const AFTER_DRAFTS_MS = 45 * 60_000;
const COMPARE_URL = `https://github.com/Kim-Geonwoo/coolify-ko/compare/${BRANCH}...${PUSH_BRANCH}`;
const OWNER = 'Kim-Geonwoo';
const REPO = 'coolify-ko';
const REPO_URL = `https://github.com/${OWNER}/${REPO}.git`;
const BOT = ['-c', 'user.name=coolify-ko-bot', '-c', 'user.email=coolify-ko-bot@users.noreply.github.com'];

mkdirSync(CACHE, { recursive: true });
const started = Date.now();
const remaining = (): number => Math.max(60_000, BUDGET_MS - (Date.now() - started));

class CommandFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** 명령을 돌리고, 실패하면 짧은 코드(명령 이름)만 남긴다. 출력은 journald로 바로 흘린다 */
function run(code: string, command: string, args: readonly string[], timeoutMs = remaining(), extraEnv: Readonly<Record<string, string>> = {}): void {
  const result = spawnSync(command, args, { cwd: WORK, stdio: 'inherit', timeout: Math.min(timeoutMs, remaining()), env: { ...process.env, ...extraEnv } });
  if (result.error !== undefined || result.status !== 0) {
    throw new CommandFailure(code, `${command} 실패(${result.error?.message ?? `종료 ${String(result.status)}`})`);
  }
}

function capture(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, { cwd: WORK, encoding: 'utf8', timeout: 60_000 });
  if (result.status !== 0) {
    throw new CommandFailure('git', `${command} 실패`);
  }

  return result.stdout;
}

function credential(name: string): string {
  const dir = process.env['CREDENTIALS_DIRECTORY'];
  if (dir === undefined) {
    throw new CommandFailure('credential', 'CREDENTIALS_DIRECTORY가 없습니다(systemd LoadCredential=로 실행해야 한다).');
  }

  return join(dir, name);
}

/** GitHub App 설치 토큰(1시간). 키 파일은 LoadCredential로만 받는다 */
async function appToken(): Promise<string> {
  try {
    const appId = readFileSync(credential('github-app-id'), 'utf8').trim();
    const pem = readFileSync(credential('github-app.pem'), 'utf8');

    return await installationToken(fetch, appJwt(appId, pem, new Date()), OWNER, REPO);
  } catch (error: unknown) {
    throw new CommandFailure('app-token', error instanceof Error ? error.message : 'GitHub App 토큰을 받지 못했습니다.');
  }
}

function memFreeGiB(node: number): number {
  const text = readFileSync(`/sys/devices/system/node/node${String(node)}/meminfo`, 'utf8');
  const match = /MemFree:\s+(\d+) kB/.exec(text);
  if (match?.[1] === undefined) {
    throw new CommandFailure('meminfo', 'NUMA 노드 MemFree를 읽지 못했습니다.');
  }

  return Number(match[1]) / 1024 / 1024;
}

async function withLlama<T>(work: () => Promise<T>): Promise<T> {
  // NUMA 노드 하나에 CPU·메모리를 묶는다(우분투 2 장부: 소켓당 메모리 2채널, home-ci는 노드 1)
  const server = spawn('numactl', [`--cpunodebind=${String(NUMA_NODE)}`, `--membind=${String(NUMA_NODE)}`, LLAMA, '-m', MODEL, '--host', '127.0.0.1', '--port', String(LLAMA_PORT), '-c', '4096', '-np', '1', '-t', String(THREADS)], { stdio: 'ignore' });
  try {
    const until = Date.now() + 5 * 60_000;
    for (;;) {
      try {
        const response = await fetch(`http://127.0.0.1:${String(LLAMA_PORT)}/health`, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) {
          break;
        }
      } catch {
        // 아직 올라오는 중
      }
      if (Date.now() > until || server.exitCode !== null) {
        throw new CommandFailure('llama-start', 'llama-server가 5분 안에 준비되지 않았습니다.');
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }

    return await work();
  } finally {
    server.kill('SIGTERM');
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

const statusPath = join(CACHE, 'status.json');
const statePath = join(WORK, 'i18n', 'state.json');
const previousCatalog = join(CACHE, 'previous-catalog.json');

/** Weblate 봇 토큰 두 개가 LoadCredential로 들어왔을 때만 Weblate 단계를 돈다(리허설 시나리오·서비스 파일 갱신 전에는 건너뛴다) */
function weblateTokenDir(): string | undefined {
  const dir = process.env['CREDENTIALS_DIRECTORY'];

  return dir !== undefined && existsSync(join(dir, 'weblate-bridge.token')) && existsSync(join(dir, 'weblate-flash.token')) ? dir : undefined;
}

function weblateStage(tokenDir: string): Promise<{ changed: boolean; rejected: string[] }> {
  const report = join(CACHE, 'weblate-report.json');
  rmSync(report, { force: true });
  run('weblate', 'node', ['pipeline/src/cli.ts', 'weblate', 'sync', '--base-url', WEBLATE_URL, '--token-dir', tokenDir, '--cache-dir', WEBLATE_CACHE, '--report', report], 20 * 60_000);
  const data = readJson(report) as { changed?: unknown; rejected?: unknown };
  const rejected = (Array.isArray(data.rejected) ? (data.rejected as unknown[]) : []).flatMap((item) => {
    const key = (item as { key?: unknown } | null)?.key;

    return typeof key === 'string' ? [key] : [];
  });

  return Promise.resolve({ changed: data.changed === true, rejected });
}

// 4단계: PaaS용 한국어판 이미지. 전달 폴더는 PaaS 호스트가 설치된 뒤 install.sh가 만든다
const RELEASE_IMAGES = '/srv/handoff/coolify-ko/images';
const RELEASE_IMAGE_MIN_MS = 40 * 60_000;
async function releaseImageStage(): Promise<'ready' | 'skipped'> {
  if (!existsSync(RELEASE_IMAGES)) {
    console.log('한국어판 이미지: 전달 폴더가 없어 건너뜁니다(PaaS 호스트 설치 전).');

    return 'skipped';
  }
  if (remaining() < RELEASE_IMAGE_MIN_MS) {
    console.log('한국어판 이미지: 남은 시간이 모자라 다음 밤으로 미룹니다.');

    return 'skipped';
  }
  const result = await buildReleaseImage({ repo: WORK, out: RELEASE_IMAGES, ref: `origin/${BRANCH}`, deadline: started + BUDGET_MS });
  if (result.kind === 'built' && result.manifest !== undefined) {
    console.log(`한국어판 이미지: 새로 만듦 ${result.key} (${String(Math.round(result.manifest.bytes / 1024 / 1024))}MB)`);
    await postDiscord(credential('discord-webhook'), trustMessage(result.manifest.version, result.manifest.configDigest, result.manifest.commit, readTrustCommand()));
  } else {
    console.log(`한국어판 이미지: 그대로(${result.key})`);
  }

  return 'ready';
}

/**
 * 5단계: 공개판 발행 후보와 상류 설치 후크 판정(발행은 사람이 PC에서 한다). dev 판단은 작업 사본이 아니라 origin/dev를 읽는다:
 * 새 버전을 처리한 밤에는 작업 사본의 state가 이미 새 버전이지만 dev에는 아직 병합 전이다
 */
const PUBLISH_STATUS = join(CACHE, 'publish.json');
async function publishPlanStage(input: Parameters<NonNullable<NightDeps['publishPlan']>>[0]): Promise<PublishPlan> {
  const files = await fetchHookFiles(input.upstream.version, fetch);
  const issues = hookIssues(files);
  const fingerprint = hookFingerprint(files);
  const dev = (path: string): unknown => JSON.parse(capture('git', ['show', `origin/${BRANCH}:${path}`])) as unknown;
  const commit = capture('git', ['rev-parse', `origin/${BRANCH}`]).trim();
  const candidate = decideCandidate({
    upstream: input.upstream,
    dev: { version: parseState(dev('i18n/state.json')).upstream.version, commit, gates: input.gates },
    hooksOk: issues.length === 0,
    published: parsePublished(dev('releases/published.json')),
    now: new Date(),
  });
  const announce = (dev('i18n/release.json') as { publish?: unknown }).publish === true;
  writeFileSync(PUBLISH_STATUS, canonicalJson({ at: new Date().toISOString(), candidate, hookIssues: issues, hookFingerprint: fingerprint, announce }));
  console.log(`공개판 후보: ${candidate.kind === 'none' ? `없음(${candidate.reason})` : `${candidate.kind} ${candidate.version}`} · 후크 문제 ${String(issues.length)}`);

  return { candidate, hookIssues: issues, hookFingerprint: fingerprint, announce };
}

/** 스크린샷: 아직 안 찍은 카탈로그 버전이고 남은 시간이 넉넉할 때만 찍는다(빌드·기동 20~30분, 예시 리소스·약 170쪽·창 찍기 10~15분) */
const SCREENSHOT_MIN_MS = 55 * 60_000;
async function screenshotsStage(tokenDir: string): Promise<void> {
  const version = (readJson(join(WORK, 'i18n', 'catalog.json')) as { version?: unknown }).version;
  const donePath = join(WEBLATE_CACHE, 'screenshots.version');
  const done = existsSync(donePath) ? readFileSync(donePath, 'utf8').trim() : '';
  if (typeof version !== 'string' || done === captureDoneKey(WORK, version)) {
    console.log('스크린샷: 이 입력(버전·찍기 코드·변환기·카탈로그)으로는 이미 찍었습니다.');

    return;
  }
  if (remaining() < SCREENSHOT_MIN_MS) {
    console.log('스크린샷: 남은 시간이 모자라 다음 밤으로 미룹니다.');

    return;
  }
  const reportPath = join(CACHE, 'screenshots-report.json');
  rmSync(reportPath, { force: true });
  try {
    // 안쪽은 50분 안에 끝내고 정리할 시간을 남긴다. 바깥 제한은 그보다 5분 길다
    run('screenshots', 'node', ['pipeline/src/cli.ts', 'screenshots', 'run', '--base-url', WEBLATE_URL, '--token-dir', tokenDir, '--cache-dir', WEBLATE_CACHE, '--report', reportPath, '--budget-min', '50'], SCREENSHOT_MIN_MS);
  } finally {
    // 끊겨도 시험 인스턴스·찍기 컨테이너가 rootless 데몬에 남지 않게(다음 밤 메모리 하한에 걸린다)
    spawnSync('docker', ['rm', '-f', 'coolify-ko-screens-capture'], { stdio: 'ignore', timeout: 2 * 60_000 });
    spawnSync('docker', ['compose', '-p', 'coolify-ko-screens', 'down', '-v', '--remove-orphans'], { stdio: 'ignore', timeout: 5 * 60_000 });
  }
  // 지난 찍기에 없던 '표식 없이 보인 영어'는 변환 규칙이 모르는 꼴이 새로 생겼다는 신호라 바로 알린다(2026-10-25 4.5.0 사이드바)
  const report = readJson(reportPath) as { newUntranslated?: unknown; untranslatedSince?: unknown };
  const fresh = Array.isArray(report.newUntranslated) ? report.newUntranslated.flatMap((gap: unknown) => (typeof (gap as { text?: unknown } | null)?.text === 'string' ? [(gap as { text: string }).text] : [])) : [];
  if (fresh.length > 0) {
    console.log(`스크린샷: 지난 찍기에 없던 표식 없는 영어 ${String(fresh.length)}개: ${fresh.slice(0, 5).join(' · ')}`);
    await postDiscord(credential('discord-webhook'), discordMessage({ type: 'untranslated', version, ...(typeof report.untranslatedSince === 'string' ? { previousVersion: report.untranslatedSince } : {}), count: fresh.length, examples: fresh }));
  }
}

const weblateTokens = weblateTokenDir();
if (weblateTokens === undefined) {
  console.log('Weblate 토큰이 없어 Weblate 단계를 건너뜁니다.');
}

const deps: NightDeps = {
  now: () => new Date(),
  log: (line) => {
    console.log(line);
  },
  readStatus: () => (existsSync(statusPath) ? (readJson(statusPath) as JobStatus) : emptyStatus()),
  writeStatus: (status) => {
    writeFileSync(statusPath, canonicalJson(status));
  },
  readState: () => loadState(statePath),
  writeState: (state: SyncState) => {
    const parsed = parseState(state);
    writeFileSync(statePath, canonicalJson(parsed));
    // Dockerfile 기본값도 같은 버전으로(state.test가 둘이 같은지 본다, 2026-10-23 밤 작업 실패)
    const dockerfile = join(WORK, 'Dockerfile');
    writeFileSync(dockerfile, syncDockerfileDefaults(readFileSync(dockerfile, 'utf8'), parsed));
  },
  resetWorkcopy: () => {
    rmSync(join(WORK, '.git', 'index.lock'), { force: true });
    run('git', 'git', ['fetch', '--prune', 'origin']);
    run('git', 'git', ['reset', '--hard', `origin/${BRANCH}`]);
    run('git', 'git', ['clean', '-fdx', '-e', 'node_modules']);
    run('pnpm-install', 'pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], 15 * 60_000);

    return Promise.resolve();
  },
  resources: () => {
    const disk = statfsSync(BASE);

    return Promise.resolve({ memFreeGiB: memFreeGiB(NUMA_NODE), diskFreeGiB: (disk.bavail * disk.bsize) / 1024 ** 3 });
  },
  upstream: (state) => checkUpstream(state),
  extract: () => {
    copyFileSync(join(WORK, 'i18n', 'catalog.json'), previousCatalog);
    run('extract', 'node', ['pipeline/src/cli.ts', 'extract'], 45 * 60_000);
    // 새 카탈로그에서 낡은 검수 결과를 뺀다. 그날 Weblate 단계가 실패해도 verify가 초안 푸시를 막지 않게(검토 Critical 1)
    run('extract', 'node', ['pipeline/src/cli.ts', 'weblate', 'prune'], 5 * 60_000);

    return Promise.resolve();
  },
  drafts: () =>
    withLlama(() => {
      const report = join(CACHE, 'drafts-report.json');
      const budgetMin = Math.max(1, Math.floor((remaining() - AFTER_DRAFTS_MS) / 60_000));
      // 새 버전 밤에만 이전 카탈로그와 비교한다(추출이 남기고, 초안을 쓴 뒤 지운다. 이어 하는 밤은 증분을 다시 쓰지 않는다)
      const previous = existsSync(previousCatalog) ? ['--previous', previousCatalog] : [];
      run('drafts', 'node', ['pipeline/src/cli.ts', 'drafts', 'run', '--engine', ENGINE, '--base-url', `http://127.0.0.1:${String(LLAMA_PORT)}`, '--ledger-dir', join(CACHE, 'ledger'), ...previous, '--report', report, '--budget-min', String(budgetMin)]);
      rmSync(previousCatalog, { force: true });
      const data = readJson(report) as { increment: { added: string[]; changed: string[]; removed: string[]; drafted: number }; fallbacks: string[]; normalized: number; pending?: number };

      return Promise.resolve({ added: data.increment.added.length, changed: data.increment.changed.length, removed: data.increment.removed.length, drafted: data.increment.drafted, fallbacks: data.fallbacks.length, normalized: data.normalized, pending: data.pending ?? 0 });
    }),
  pendingDrafts: () => {
    const out = join(CACHE, 'drafts-pending.json');
    run('drafts', 'node', ['pipeline/src/cli.ts', 'drafts', 'pending', '--engine', ENGINE, '--ledger-dir', join(CACHE, 'ledger'), '--out', out], 5 * 60_000);
    const pending = (readJson(out) as { pending?: unknown }).pending;

    return Promise.resolve(typeof pending === 'number' && Number.isInteger(pending) && pending >= 0 ? pending : 0);
  },
  review: () => {
    const report = join(CACHE, 'review-report.json');
    const gate = process.env['COOLIFY_KO_REVIEW_GATE'] === 'pass' ? ['--gate', 'pass'] : [];
    run('review', 'node', ['pipeline/src/cli.ts', 'drafts', 'review', '--engine', 'flash', '--key-file', credential('gemini.key'), '--cache-dir', CACHE, '--report', report, '--requests', REVIEW_REQUESTS, ...gate], 30 * 60_000);
    const data = readJson(report) as { reviewed: number; queueLeft: number };

    return Promise.resolve({ reviewed: data.reviewed, queueEmpty: data.queueLeft === 0 });
  },
  hasChanges: () => Promise.resolve(capture('git', ['status', '--porcelain', '--', 'i18n']).trim() !== ''),
  verify: () => {
    run('verify', 'pnpm', ['verify'], 30 * 60_000);

    return Promise.resolve();
  },
  commitAndPush: async (message) => {
    run('commit', 'git', ['add', '--', 'i18n', 'Dockerfile', 'reports/coverage.md']);
    run('commit', 'git', [...BOT, 'commit', '-q', '-m', message]);
    // 배포 키는 받아 오기 전용이다. 푸시는 GitHub App 신원으로 해서 main·dev 규칙셋이 막게 한다
    // bot/*만 올린다. 작업 사본의 pre-push 훅도 다른 ref를 거부한다
    const token = await appToken();
    run('push', 'git', ['push', '--force', REPO_URL, `HEAD:refs/heads/${PUSH_BRANCH}`], 10 * 60_000, gitAuthEnv(token));
    try {
      return await openPullRequest(fetch, token, { owner: OWNER, repo: REPO, head: PUSH_BRANCH, base: BRANCH, title: message, body: `밤 작업(coolify-ko-sync)이 만든 번역 초안과 Weblate 검수 결과다. 검토 판정은 ${langPaths(primaryLanguage().code).draftsMeta}의 review(제안), 승인된 번역은 i18n/reviewed/에 있다.` });
    } catch (error: unknown) {
      // 푸시는 됐으니 PR을 못 열어도 실패로 보지 않는다. 비교 주소로 알린다
      console.log(`PR 열기 실패: ${error instanceof Error ? error.message : '알 수 없음'}`);

      return undefined;
    }
  },
  notify: (event) => postDiscord(credential('discord-webhook'), discordMessage(event)),
  compareUrl: COMPARE_URL,
  limits: LIMITS,
  ...(weblateTokens === undefined ? {} : { weblate: () => weblateStage(weblateTokens) }),
  // 스크린샷은 서비스에서 켤 때만(첫 실행이 Playwright 이미지 약 2GB를 받는다. 사용자 승인과 rehearse.sh screens 확인 뒤 on)
  releaseImage: releaseImageStage,
  publishPlan: publishPlanStage,
  ...(weblateTokens === undefined || process.env['COOLIFY_KO_SCREENSHOTS'] !== 'on' ? {} : { screenshots: () => screenshotsStage(weblateTokens) }),
};

runNight(deps)
  .then((outcome) => {
    console.log(`밤 작업 결과: ${outcome}`);
    process.exit(outcome === 'failed' ? 1 : 0);
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
