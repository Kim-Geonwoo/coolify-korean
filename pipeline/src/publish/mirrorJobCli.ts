import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { canonicalJson } from '../i18n/integrity.ts';
import { postDiscord } from '../sync/discord.ts';
import { parsePublished } from './ledger.ts';
import { runMirrorJob, type MirrorStatus } from './mirrorJob.ts';
import { registryDigest } from './registry.ts';
import { ASSETS_DIR, IMAGE_REPO, refreshVersions, SITE_URL, versionsPath } from './site.ts';

/**
 * 서버 진입점: coolify-ko-mirror.service(6시간 타이머)가 부른다. 작업 레포(밤 작업 작업 사본)는 fetch만 하고 바꾸지 않는다.
 * 미러 레포 push는 LoadCredential로 받은 그 레포 하나의 배포 키로만 한다(~/.ssh/config의 작업 레포 키는 쓰지 않음)
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
const MIRROR = join(BASE, 'mirror', 'coolify-ko-mirror');
const STATUS = join(BASE, 'cache', 'mirror-status.json');
const BRANCH = env('COOLIFY_KO_BRANCH', 'dev', /^[A-Za-z0-9._/-]+$/);
const MIRROR_REPO = env('COOLIFY_KO_MIRROR_REPO', 'git@github.com:Kim-Geonwoo/coolify-ko-mirror.git', /^git@github\.com:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\.git$/);
const HOME = env('HOME', `${BASE}/home`, /^\/[A-Za-z0-9._/-]+$/);
const CREDENTIALS = env('CREDENTIALS_DIRECTORY', '', /^\/[A-Za-z0-9._/-]+$/);
const SERVED_DELAY_MS = 120_000;
const TIMEOUT_MS = 20_000;
const BOT = ['-c', 'user.name=coolify-ko-bot', '-c', 'user.email=coolify-ko-bot@users.noreply.github.com'];
const MIRROR_SSH = `ssh -i ${CREDENTIALS}/mirror-deploy-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${HOME}/.ssh/known_hosts -o ConnectTimeout=20 -F /dev/null`;

function git(cwd: string, args: readonly string[], mirror = false): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, env: { ...process.env, ...(mirror ? { GIT_SSH_COMMAND: MIRROR_SSH } : {}) } });

  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function must(cwd: string, args: readonly string[], mirror = false): string {
  const result = git(cwd, args, mirror);
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? ''} 실패: ${result.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`);
  }

  return result.stdout;
}

let ready = false;

async function main(): Promise<void> {
  const outcome = await runMirrorJob({
    now: () => new Date(),
    log: (line) => {
      console.log(line);
    },
    sync: () => {
      if (!existsSync(join(MIRROR, '.git'))) {
        mkdirSync(dirname(MIRROR), { recursive: true });
        must(dirname(MIRROR), ['clone', '-q', MIRROR_REPO, MIRROR], true);
      }
      must(MIRROR, ['fetch', '-q', 'origin'], true);
      // 첫 발행 전에는 빈 레포라 main이 없다
      ready = git(MIRROR, ['rev-parse', '--verify', '-q', 'origin/main']).status === 0;
      if (ready) {
        must(MIRROR, ['checkout', '-q', '-B', 'main', 'origin/main']);
        must(MIRROR, ['reset', '-q', '--hard', 'origin/main']);
        must(MIRROR, ['clean', '-q', '-fdx']);
      }

      return Promise.resolve();
    },
    siteReady: () => ready && existsSync(versionsPath(MIRROR)),
    published: () => {
      must(WORK, ['fetch', '-q', 'origin', BRANCH]);

      return parsePublished(JSON.parse(must(WORK, ['show', `origin/${BRANCH}:releases/published.json`])) as unknown);
    },
    registry: (version) => registryDigest(IMAGE_REPO, version, fetch),
    cdn: async () => {
      const response = await fetch('https://cdn.coollabs.io/coolify/versions.json', { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'coolify-ko-mirror', accept: 'application/json' } });
      if (!response.ok) {
        throw new Error(`versions.json을 받지 못했습니다(HTTP ${String(response.status)}).`);
      }

      return (await response.json()) as unknown;
    },
    refresh: (input) => refreshVersions(MIRROR, input),
    push: () => {
      must(MIRROR, ['add', `${ASSETS_DIR}/versions.json`]);
      const upstream = (JSON.parse(readFileSync(versionsPath(MIRROR), 'utf8')) as { 'coolify-ko'?: { upstream?: unknown } })['coolify-ko']?.upstream;
      must(MIRROR, [...BOT, 'commit', '-q', '-m', `versions: 상류 ${String(upstream)} 기준 갱신`]);
      const pushed = git(MIRROR, ['push', '-q', 'origin', 'HEAD:main'], true);
      if (pushed.status === 0) {
        return Promise.resolve('pushed');
      }
      if (/rejected|fetch first|non-fast-forward/.test(pushed.stderr)) {
        return Promise.resolve('rejected');
      }

      return Promise.reject(new Error(`git push 실패: ${pushed.stderr.trim().split('\n').slice(-2).join(' ').slice(0, 200)}`));
    },
    served: async () => {
      await new Promise((resolve) => setTimeout(resolve, SERVED_DELAY_MS));
      const response = await fetch(`${SITE_URL}/versions.json?check=${String(Date.now())}`, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });

      return response.ok && (await response.text()) === readFileSync(versionsPath(MIRROR), 'utf8');
    },
    readStatus: () => {
      try {
        const data = JSON.parse(readFileSync(STATUS, 'utf8')) as Partial<MirrorStatus>;

        return typeof data.failures === 'number' && Number.isInteger(data.failures) && data.failures >= 0 ? (data as MirrorStatus) : { failures: 0 };
      } catch {
        return { failures: 0 };
      }
    },
    writeStatus: (status) => {
      writeFileSync(STATUS, canonicalJson(status));
    },
    notify: (message) => postDiscord(join(CREDENTIALS, 'discord-webhook'), message),
  });
  console.log(`미러 갱신 결과: ${outcome}`);
  process.exit(outcome === 'failed' ? 1 : 0);
}

if (CREDENTIALS === '') {
  console.error('CREDENTIALS_DIRECTORY가 없습니다(systemd LoadCredential=로 실행해야 한다).');
  process.exit(1);
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
