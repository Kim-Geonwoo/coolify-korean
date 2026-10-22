import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildArgs, imageRef, parseState } from '../sync/state.ts';

/**
 * PaaS용 한국어판 이미지(4단계 설계 5.2). 밤 작업이 dev의 상태로 만들어 전달 폴더에 두고, 사용자가 PaaS 호스트에서 승인해야 VM에 들어간다.
 * 빌드 문맥은 작업 사본이 아니라 `git archive <ref>`다: 밤 작업이 같은 사본에 새 버전 초안을 쓰는 중이어도 dev 그대로 만든다
 */
// 이미지에 들어가는 레포 경로(Dockerfile의 COPY와 게이트). 이것과 공식 이미지가 같으면 같은 이미지다
export const IMAGE_INPUTS = ['Dockerfile', 'codemod', 'overlay', 'LICENSE', 'NOTICE', 'tools/equivalence', '.dockerignore'] as const;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;
const GIT_ID = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const KEEP = 3;
// 승인했지만 아직 적용 전인 판을 지우지 않게, 이보다 젊은 판은 개수와 상관없이 남긴다(검토 2026-10-18 I4)
const KEEP_YOUNGER_MS = 7 * 24 * 60 * 60_000;
// 밤 작업 마감 앞에 남길 여유와, docker 단계 하나에 줄 최소 시간
const MARGIN_MS = 5 * 60_000;
const MIN_STEP_MS = 2 * 60_000;
const CONFIG = /^(?:blobs\/sha256\/([0-9a-f]{64})|([0-9a-f]{64})\.json)$/;

export interface ImageManifest {
  readonly schema: 1;
  readonly version: string;
  readonly key: string;
  readonly commit: string;
  readonly baseImage: string;
  readonly imageId: string;
  /** 이미지 설정의 sha256(docker save 안 manifest.json의 Config). 이미지 저장소 종류와 상관없이 같아 승인·대조에 쓴다 */
  readonly configDigest: string;
  readonly tag: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly builtAt: string;
}

/** 이미지 이름: 버전 + (공식 이미지·입력 경로 git 객체 id)의 해시 12자 */
export function imageKey(version: string, baseImage: string, objectIds: readonly string[]): string {
  if (!VERSION.test(version)) {
    throw new Error(`버전 형식이 아닙니다: ${version.slice(0, 40)}`);
  }
  if (!objectIds.every((id) => GIT_ID.test(id))) {
    throw new Error('git 객체 id 형식이 아닙니다.');
  }

  return `${version}-${createHash('sha256').update([baseImage, ...objectIds].join('\n')).digest('hex').slice(0, 12)}`;
}

/** 지울 오래된 빌드: 최근 keep개와 일주일이 안 된 판은 남긴다 */
export function retired(dirs: readonly { readonly name: string; readonly builtAt: string }[], now: number, keep = KEEP): string[] {
  return [...dirs]
    .sort((a, b) => Date.parse(b.builtAt) - Date.parse(a.builtAt))
    .slice(keep)
    .filter((dir) => now - Date.parse(dir.builtAt) > KEEP_YOUNGER_MS)
    .map((dir) => dir.name);
}

/** docker save가 쓴 manifest.json에서 이미지 설정 다이제스트를 읽는다(OCI·옛 형식 모두) */
export function configDigestOf(manifestText: string): string {
  let config: unknown;
  try {
    config = (JSON.parse(manifestText) as { Config?: unknown }[])[0]?.Config;
  } catch {
    config = undefined;
  }
  const match = typeof config === 'string' ? CONFIG.exec(config) : null;
  const hex = match?.[1] ?? match?.[2];
  if (hex === undefined) {
    throw new Error('이미지 설정 다이제스트를 읽지 못했습니다.');
  }

  return `sha256:${hex}`;
}

/** 지금 형식을 다 갖춘 manifest인지(설정 다이제스트가 없는 예전 판은 다시 만든다) */
export function isCompleteManifest(text: string): boolean {
  try {
    const digest = (JSON.parse(text) as { configDigest?: unknown }).configDigest;

    return typeof digest === 'string' && IMAGE_ID.test(digest);
  } catch {
    return false;
  }
}

/** docker 단계 하나의 시간 제한: 단계 상한과 "밤 작업 마감 − 여유" 중 작은 쪽. 모자라면 던진다(검토 I5) */
export function imageStepTimeout(capMs: number, deadline: number, now: number): number {
  const left = deadline - now - MARGIN_MS;
  if (left < MIN_STEP_MS) {
    throw new Error('한국어판 이미지에 쓸 시간이 모자라 다음 밤으로 미룹니다.');
  }

  return Math.min(capMs, left);
}

/** 사용자에게 보낼 승인 안내(Discord). 승인 값은 이미지 설정 다이제스트다 */
// 서버 설정의 승인 명령(예: sudo -u <사용자> <명령> ko trust). 한 줄, 셸 연결 문자 없이
const TRUST_COMMAND = /^[A-Za-z0-9 ._/-]{1,120}$/;
export const TRUST_COMMAND_FILE = '/srv/coolify-ko/config/trust-command';

/**
 * 사용자에게 보낼 승인 안내(Discord). 승인 값은 이미지 설정 다이제스트다.
 * PaaS 호스트의 승인 명령은 레포가 아니라 서버 설정(TRUST_COMMAND_FILE)에서 받는다(공개 레포에 내부 이름을 남기지 않게)
 */
export function trustMessage(version: string, imageId: string, commit: string, command?: string): string {
  if (!IMAGE_ID.test(imageId)) {
    throw new Error('이미지 id 형식이 아닙니다.');
  }
  if (command !== undefined && !TRUST_COMMAND.test(command)) {
    throw new Error('승인 명령 설정이 한 줄 명령 형식이 아닙니다.');
  }

  return [
    `coolify-ko 한국어판 이미지 준비: ${version} (dev ${commit.slice(0, 7)})`,
    ...(command === undefined ? ['PaaS 호스트에서 승인할 값:', `${version} ${imageId}`] : ['PaaS에 넣으려면 서버에서:', `${command} ${version} ${imageId}`]),
  ].join('\n');
}

/** 서버 설정의 승인 명령(없거나 형식이 틀리면 undefined: 안내는 값만 보낸다) */
export function readTrustCommand(path = TRUST_COMMAND_FILE): string | undefined {
  try {
    const text = readFileSync(path, 'utf8').trim();

    return TRUST_COMMAND.test(text) ? text : undefined;
  } catch {
    return undefined;
  }
}

const git = (repo: string, args: readonly string[], maxBuffer = 16 * 1024 * 1024): Buffer => {
  const result = spawnSync('git', ['-C', repo, ...args], { windowsHide: true, timeout: 120_000, maxBuffer });
  if (result.status !== 0) {
    throw new Error(`git ${args[0] ?? ''} 실패`);
  }

  return result.stdout;
};

const docker = (args: readonly string[], options: { readonly input?: Buffer; readonly timeoutMs: number }): string => {
  const result = spawnSync('docker', args, { windowsHide: true, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(options.input === undefined ? {} : { input: options.input }) });
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? ''} 실패: ${result.stderr.toString('utf8').trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
  }

  return result.stdout.toString('utf8');
};

const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => {
        resolve(hash.digest('hex'));
      });
  });

/** 새 파일로만 열어(wx) 쓰고 0640으로 맞춘 뒤 이름을 바꾼다(심은 링크를 따라 쓰지 않는다) */
const publishText = (dir: string, name: string, data: string): void => {
  const partial = join(dir, `.${name}.${randomBytes(8).toString('hex')}.partial`);
  const fd = openSync(partial, 'wx', 0o640);
  try {
    writeFileSync(fd, data);
    fchmodSync(fd, 0o640);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, join(dir, name));
};

/**
 * 이미지를 만들기 전 게이트: 템플릿 컴파일·문법 검사와 정적 동등성(en 출력이 원본과 같음). 실패는 던진다.
 * context는 `git archive`의 tar, budget은 단계 상한을 받아 실제 시간 제한을 돌려준다
 */
export function runGates(context: Buffer, args: readonly string[], budget: (capMs: number) => number): void {
  docker(['build', '-q', ...args, '--target', 'compile-check', '-'], { input: context, timeoutMs: budget(40 * 60_000) });
  const report = mkdtempSync(join(tmpdir(), 'coolify-ko-equivalence-'));
  try {
    docker(['build', '-q', ...args, '--target', 'equivalence-report', '--output', `type=local,dest=${report}`, '-'], { input: context, timeoutMs: budget(40 * 60_000) });
  } finally {
    rmSync(report, { recursive: true, force: true });
  }
}

/**
 * ref(기본 origin/dev)의 상태로 한국어판 이미지를 만든다. 이미 같은 이미지가 있으면 아무것도 하지 않는다.
 * 컴파일 검사·정적 동등성 게이트를 먼저 통과해야 overlay를 만든다. 실패는 던진다(밤 작업이 비치명으로 받는다)
 */
export async function buildReleaseImage(options: { readonly repo: string; readonly out: string; readonly ref?: string; readonly now?: () => Date; readonly deadline?: number }): Promise<{ readonly kind: 'exists' | 'built'; readonly manifest?: ImageManifest; readonly key: string }> {
  const ref = options.ref ?? 'origin/dev';
  const commit = git(options.repo, ['rev-parse', `${ref}^{commit}`]).toString('utf8').trim();
  const state = parseState(JSON.parse(git(options.repo, ['show', `${commit}:i18n/state.json`]).toString('utf8')) as unknown);
  const baseImage = imageRef(state);
  const objectIds = IMAGE_INPUTS.map((path) => git(options.repo, ['rev-parse', `${commit}:${path}`]).toString('utf8').trim());
  const key = imageKey(state.upstream.version, baseImage, objectIds);
  const dir = join(options.out, key);
  if (existsSync(join(dir, 'manifest.json')) && isCompleteManifest(readFileSync(join(dir, 'manifest.json'), 'utf8'))) {
    return { kind: 'exists', key };
  }

  const context = git(options.repo, ['archive', '--format=tar', commit, '--', ...IMAGE_INPUTS], 512 * 1024 * 1024);
  // 밤 작업 마감을 넘기면 systemd가 끊어 그 밤 상태 기록이 사라진다: 단계마다 남은 시간 안으로 줄인다
  const budget = (capMs: number): number => (options.deadline === undefined ? capMs : imageStepTimeout(capMs, options.deadline, Date.now()));
  const args = buildArgs(state);
  const tag = `coolify-ko:${key}`;
  runGates(context, args, budget);
  docker(['build', '-q', ...args, '--target', 'overlay', '--label', `org.opencontainers.image.revision=${commit}`, '-t', tag, '-'], { input: context, timeoutMs: budget(40 * 60_000) });
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 60_000 }).trim();

  mkdirSync(dir, { recursive: true, mode: 0o2750 });
  const partial = join(dir, `.image.tar.${randomBytes(8).toString('hex')}.partial`);
  try {
    const fd = openSync(partial, 'wx', 0o640);
    try {
      const saved = spawnSync('docker', ['save', tag], { stdio: ['ignore', fd, 'pipe'], windowsHide: true, timeout: budget(30 * 60_000) });
      if (saved.status !== 0) {
        throw new Error('docker save 실패');
      }
      fchmodSync(fd, 0o640);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, join(dir, 'image.tar'));
  } catch (error: unknown) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  } finally {
    spawnSync('docker', ['rmi', tag], { windowsHide: true, stdio: 'ignore', timeout: 5 * 60_000 });
  }
  const tarPath = join(dir, 'image.tar');
  // 폴더 안에서 상대 이름으로 연다: GNU tar는 "C:..." 같은 경로를 원격 호스트로 읽는다
  const inner = spawnSync('tar', ['-xOf', 'image.tar', 'manifest.json'], { cwd: dir, windowsHide: true, timeout: 5 * 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (inner.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error('이미지 묶음에서 manifest.json을 읽지 못했습니다.');
  }
  const configDigest = configDigestOf(inner.stdout.toString('utf8'));
  const manifest: ImageManifest = {
    schema: 1,
    version: state.upstream.version,
    key,
    commit,
    baseImage,
    imageId,
    configDigest,
    tag,
    sha256: await sha256File(tarPath),
    bytes: statSync(tarPath).size,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
  };
  publishText(dir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  // 오래된 빌드 정리(manifest가 있는 것만 센다. 반쯤 만든 폴더는 위에서 지운다)
  const built = readdirSync(options.out, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) {
      return [];
    }
    try {
      return [{ name: entry.name, builtAt: (JSON.parse(readFileSync(join(options.out, entry.name, 'manifest.json'), 'utf8')) as { builtAt: string }).builtAt }];
    } catch {
      return [];
    }
  });
  for (const name of retired(built, Date.now())) {
    rmSync(join(options.out, name), { recursive: true, force: true });
  }

  return { kind: 'built', manifest, key };
}
