import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, createReadStream, existsSync, fchmodSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publicLangFile } from '../release/publicLang.ts';
import { IMAGE_INPUTS, runGates } from '../release/image.ts';
import { buildArgs, imageRef, parseState } from '../sync/state.ts';
import { PLATFORMS, sourceDrift, type Platform } from './platforms.ts';
import { listTar, listTarFile, readTarEntry, uniquePaths, type TarEntry } from './tar.ts';
import { ALLOWED_PUBLIC_PATHS, configIssues, indexIssues, layerIssues, manifestIssues, overlayLayers, platformManifests } from './verify.ts';

/**
 * 다른 사용자용 공개판 이미지(5단계, 판결 R1): 사용자가 PC에서 origin/dev 커밋으로 빌드하고 검증한다. 서버에는 발행 토큰이 없다.
 * 결과는 OCI 묶음(amd64·arm64 + 출처 증명) 하나와 manifest.json이다. 레지스트리 push·서명은 공개 계획에서 한다
 */
export interface PublicManifest {
  readonly schema: 1;
  readonly kind: 'ko';
  readonly version: string;
  readonly key: string;
  readonly commit: string;
  readonly code: string;
  /** 공식 이미지 index 다이제스트(state.json) */
  readonly baseIndex: string;
  /** 우리 이미지 index 다이제스트(레지스트리에 올리면 이 값이 태그의 다이제스트다) */
  readonly index: string;
  readonly platforms: Readonly<Record<Platform, { readonly manifest: string; readonly config: string }>>;
  readonly langSha256: string;
  readonly ociSha256: string;
  readonly bytes: number;
  readonly builtAt: string;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const GIT_ID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const INDEX_TYPE = 'application/vnd.oci.image.index.v1+json';
const STEP_MS = 60 * 60_000;

/** 공개판 이름: 버전 + (공식 이미지·입력 경로 git 객체·언어 파일)의 해시 12자. PaaS판(imageKey)과 섞이지 않게 p를 붙인다 */
export function publicKey(version: string, baseImage: string, objectIds: readonly string[], langSha256: string): string {
  if (!VERSION.test(version) || !objectIds.every((id) => GIT_ID.test(id)) || !SHA256.test(langSha256)) {
    throw new Error('공개판 이름을 만들 값의 형식이 맞지 않습니다.');
  }

  return `${version}-p${createHash('sha256').update([baseImage, ...objectIds, langSha256].join('\n')).digest('hex').slice(0, 12)}`;
}

/** buildx OCI 묶음의 index.json은 이미지 index 하나를 가리킨다. 그것을 따라가 플랫폼 목록이 든 index를 돌려준다 */
export function imageIndexOf(top: unknown, blob: (digest: string) => unknown): { readonly digest: string; readonly index: unknown } {
  const list = (top as { manifests?: unknown } | null)?.manifests;
  const indexes = Array.isArray(list) ? list.filter((item: unknown) => (item as { mediaType?: unknown } | null)?.mediaType === INDEX_TYPE) : [];
  const digest = (indexes[0] as { digest?: unknown } | undefined)?.digest;
  if (indexes.length !== 1 || typeof digest !== 'string' || !DIGEST.test(digest)) {
    throw new Error('OCI 묶음에 이미지 index가 하나가 아닙니다.');
  }
  const index = blob(digest);
  if (index === undefined) {
    throw new Error('이미지 index blob이 없습니다.');
  }

  return { digest, index };
}

const run = (command: string, args: readonly string[], options: { readonly input?: Buffer; readonly timeoutMs: number; readonly cwd?: string }): string => {
  const result = spawnSync(command, args, { windowsHide: true, timeout: options.timeoutMs, maxBuffer: 64 * 1024 * 1024, ...(options.input === undefined ? {} : { input: options.input }), ...(options.cwd === undefined ? {} : { cwd: options.cwd }) });
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] ?? ''} ${args[1] ?? ''} 실패: ${result.stderr.toString('utf8').trim().split('\n').slice(-3).join(' ').slice(0, 300)}`);
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

/** OCI 묶음의 blob을 읽고 다이제스트를 대조한다 */
function blobReader(tarPath: string, entries: readonly TarEntry[]): (digest: string) => Buffer {
  return (digest) => {
    const entry = DIGEST.test(digest) ? entries.find((item) => item.path === `blobs/sha256/${digest.slice(7)}`) : undefined;
    if (entry === undefined) {
      throw new Error(`OCI 묶음에 blob이 없습니다: ${digest.slice(0, 19)}`);
    }
    const data = readTarEntry(tarPath, entry);
    if (`sha256:${createHash('sha256').update(data).digest('hex')}` !== digest) {
      throw new Error(`blob 내용이 다이제스트와 다릅니다: ${digest.slice(0, 19)}`);
    }

    return data;
  };
}

function readLayout(tarPath: string): { readonly digest: string; readonly index: unknown; readonly blob: (digest: string) => Buffer } {
  // 같은 경로가 둘이면 푸는 쪽(마지막)과 우리(첫 것)가 다른 index·blob을 본다
  const entries = uniquePaths(listTarFile(tarPath));
  const top = entries.find((item) => item.path === 'index.json');
  if (top === undefined) {
    throw new Error('OCI 묶음에 index.json이 없습니다.');
  }
  const blob = blobReader(tarPath, entries);
  const { digest, index } = imageIndexOf(JSON.parse(readTarEntry(tarPath, top).toString('utf8')) as unknown, (d) => JSON.parse(blob(d).toString('utf8')) as unknown);

  return { digest, index, blob };
}

export interface OfficialImage {
  readonly manifest: unknown;
  readonly config: unknown;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * Docker Hub 공개 이미지의 blob(익명 읽기). imagetools의 설정 출력은 OCI 칸만 남겨 Healthcheck 같은 Docker 칸이 빠지므로 원본을 받는다.
 * 받은 내용은 다이제스트와 대조한다
 */
export async function hubBlob(image: string, digest: string, fetcher: typeof fetch = fetch): Promise<Buffer> {
  const repository = /^docker\.io\/([a-z0-9]+(?:[._-][a-z0-9]+)*\/[a-z0-9]+(?:[._-][a-z0-9]+)*)$/.exec(image)?.[1];
  if (repository === undefined || !DIGEST.test(digest)) {
    throw new Error('Docker Hub 이미지·다이제스트 형식이 아닙니다.');
  }
  const signal = (): AbortSignal => AbortSignal.timeout(30_000);
  const auth = await fetcher(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repository}:pull`, { signal: signal() });
  const token = auth.ok ? ((await auth.json()) as { token?: unknown }).token : undefined;
  if (typeof token !== 'string') {
    throw new Error(`Docker Hub 읽기 토큰을 받지 못했습니다(HTTP ${String(auth.status)}).`);
  }
  const response = await fetcher(`https://registry-1.docker.io/v2/${repository}/blobs/${digest}`, { signal: signal(), headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`Docker Hub blob을 받지 못했습니다(HTTP ${String(response.status)}).`);
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > MAX_CONFIG_BYTES || `sha256:${createHash('sha256').update(data).digest('hex')}` !== digest) {
    throw new Error('Docker Hub blob 크기나 다이제스트가 맞지 않습니다.');
  }

  return data;
}

/** 공식 이미지의 플랫폼별 manifest와 설정(레지스트리에서 읽기만) */
export async function officialImage(image: string, indexDigest: string, platform: Platform): Promise<OfficialImage> {
  const inspect = (digest: string): unknown => JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', '--raw', `${image}@${digest}`], { timeoutMs: 60_000 })) as unknown;
  const entry = platformManifests(inspect(indexDigest)).find((item) => item.platform === platform);
  if (entry === undefined) {
    throw new Error(`공식 이미지에 ${platform}가 없습니다.`);
  }
  const manifest = inspect(entry.digest);
  const configDigest = (manifest as { config?: { digest?: unknown } } | null)?.config?.digest;
  if (typeof configDigest !== 'string') {
    throw new Error(`공식 ${platform} manifest에 설정 다이제스트가 없습니다.`);
  }

  return { manifest, config: JSON.parse((await hubBlob(image, configDigest)).toString('utf8')) as unknown };
}

/**
 * 공개판 OCI 묶음 검증. 문제가 없으면 빈 배열.
 * expected는 manifest.json이 아니라 그 커밋의 state.json에서 와야 한다(manifest는 검증 대상이다). fetchOfficial도 expected.baseIndex로 부른다
 */
export async function verifyPublicImage(dir: string, fetchOfficial: (platform: Platform) => Promise<OfficialImage>, expected: { readonly baseIndex: string; readonly version: string }): Promise<string[]> {
  const tarPath = join(dir, 'image.oci.tar');
  const layout = readLayout(tarPath);
  const refs = platformManifests(layout.index);
  const manifests = new Map(refs.map(({ digest }) => [digest, JSON.parse(layout.blob(digest).toString('utf8')) as unknown]));
  const facts = {
    index: layout.digest,
    platforms: Object.fromEntries(refs.map(({ platform, digest }) => [platform, { manifest: digest, config: String((manifests.get(digest) as { config?: { digest?: unknown } } | undefined)?.config?.digest) }])),
    ociSha256: await sha256File(tarPath),
  };
  const manifestText = existsSync(join(dir, 'manifest.json')) ? readFileSync(join(dir, 'manifest.json'), 'utf8') : 'null';
  const manifestProblems = manifestIssues(JSON.parse(manifestText) as unknown, facts, expected);
  const official = new Map<Platform, OfficialImage>();
  for (const platform of PLATFORMS) {
    official.set(platform, await fetchOfficial(platform));
  }
  const issues = [...manifestProblems, ...indexIssues({ index: layout.index, manifests, official: new Map([...official].map(([platform, item]) => [platform, item.manifest])) })];
  for (const { platform, digest } of refs) {
    const base = official.get(platform as Platform);
    const ours = manifests.get(digest);
    if (base === undefined) {
      continue;
    }
    // 실행 설정(Entrypoint·Env·User 등)이 바뀌면 허용 경로 검사만으로는 막지 못한다(보안 검토 2026-10-18)
    const configDigest = (ours as { config?: { digest?: unknown } } | undefined)?.config?.digest;
    if (typeof configDigest !== 'string') {
      issues.push(`${platform}: 설정 다이제스트 없음`);
    } else {
      issues.push(...configIssues(JSON.parse(layout.blob(configDigest).toString('utf8')) as unknown, base.config).map((issue) => `${platform}: ${issue}`));
    }
    for (const layer of overlayLayers(ours, base.manifest)) {
      issues.push(...layerIssues(listTar(layout.blob(layer.digest)), ALLOWED_PUBLIC_PATHS).map((issue) => `${platform}: ${issue}`));
    }
  }

  return issues;
}

function writeManifest(dir: string, manifest: PublicManifest): void {
  const partial = join(dir, `.manifest.json.${randomBytes(8).toString('hex')}.partial`);
  const fd = openSync(partial, 'wx', 0o640);
  try {
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
    fchmodSync(fd, 0o640);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, join(dir, 'manifest.json'));
}

/**
 * ref 커밋으로 공개판을 만든다. 같은 이름의 완성본이 있으면 그것을 돌려준다.
 * 순서: 게이트 → 플랫폼별 공식 소스 동일성 → 문맥(git archive + 기본 언어 파일) → buildx 두 플랫폼 OCI → manifest
 */
export async function buildPublicImage(options: { readonly repo: string; readonly ref: string; readonly code: string; readonly out: string; readonly now?: () => Date }): Promise<PublicManifest> {
  const git = (args: readonly string[], maxBuffer = 16 * 1024 * 1024): Buffer => {
    const result = spawnSync('git', ['-C', options.repo, ...args], { windowsHide: true, timeout: 120_000, maxBuffer });
    if (result.status !== 0) {
      throw new Error(`git ${args[0] ?? ''} 실패`);
    }

    return result.stdout;
  };
  const commit = git(['rev-parse', `${options.ref}^{commit}`]).toString('utf8').trim();
  const state = parseState(JSON.parse(git(['show', `${commit}:i18n/state.json`]).toString('utf8')) as unknown);
  const baseImage = imageRef(state);
  const objectIds = IMAGE_INPUTS.map((path) => git(['rev-parse', `${commit}:${path}`]).toString('utf8').trim());
  const lang = publicLangFile(options.repo, commit, options.code);
  const key = publicKey(state.upstream.version, baseImage, objectIds, lang.sha256);
  const dir = join(options.out, key);
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, 'utf8')) as Partial<PublicManifest>;
    if (existing.schema === 1 && existing.key === key && typeof existing.ociSha256 === 'string') {
      return existing as PublicManifest;
    }
  }

  const context = git(['archive', '--format=tar', commit, '--', ...IMAGE_INPUTS], 512 * 1024 * 1024);
  const args = buildArgs(state);
  runGates(context, args, (capMs) => capMs);

  const scratch = mkdtempSync(join(tmpdir(), 'coolify-ko-public-'));
  try {
    const hashes = PLATFORMS.map((platform) => {
      const dest = join(scratch, platform.replace('/', '-'));
      run('docker', ['buildx', 'build', '-q', '--platform', platform, ...args, '--target', 'source-hashes-report', '--output', `type=local,dest=${dest}`, '-'], { input: context, timeoutMs: STEP_MS });

      return readFileSync(join(dest, 'hashes.txt'), 'utf8');
    });
    const drift = sourceDrift(hashes[0] ?? '', hashes[1] ?? '');
    if (drift.length > 0) {
      throw new Error(`공식 이미지의 플랫폼별 소스가 ${String(drift.length)}개 다릅니다(공개판을 만들지 않음): ${drift.slice(0, 5).join(', ')}`);
    }

    // 문맥: 그 커밋의 입력 경로 + 기본 언어 파일. 상대 경로로 푼다(GNU tar는 "C:..."를 원격 호스트로 읽는다)
    const contextDir = join(scratch, 'context');
    mkdirSync(join(contextDir, 'lang-default'), { recursive: true });
    run('tar', ['-xf', '-'], { input: context, cwd: contextDir, timeoutMs: 5 * 60_000 });
    writeFileSync(join(contextDir, 'lang-default', `${options.code}.json`), lang.text);

    mkdirSync(dir, { recursive: true });
    const partial = join(dir, `.image.oci.tar.${randomBytes(8).toString('hex')}.partial`);
    try {
      run('docker', ['buildx', 'build', '-q', '--platform', PLATFORMS.join(','), ...args, '--target', 'public', '--provenance=mode=min', '--label', `org.opencontainers.image.revision=${commit}`, '--output', `type=oci,dest=${partial}`, contextDir], { timeoutMs: STEP_MS });
      renameSync(partial, join(dir, 'image.oci.tar'));
    } catch (error: unknown) {
      rmSync(partial, { force: true });
      throw error;
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const tarPath = join(dir, 'image.oci.tar');
  const layout = readLayout(tarPath);
  const platforms = Object.fromEntries(
    platformManifests(layout.index).map(({ platform, digest }) => {
      const config = (JSON.parse(layout.blob(digest).toString('utf8')) as { config?: { digest?: unknown } }).config?.digest;
      if (typeof config !== 'string' || !DIGEST.test(config)) {
        throw new Error(`${platform} manifest에 설정 다이제스트가 없습니다.`);
      }

      return [platform, { manifest: digest, config }];
    }),
  ) as Record<Platform, { manifest: string; config: string }>;
  const manifest: PublicManifest = {
    schema: 1,
    kind: 'ko',
    version: state.upstream.version,
    key,
    commit,
    code: options.code,
    baseIndex: state.upstream.digest,
    index: layout.digest,
    platforms,
    langSha256: lang.sha256,
    ociSha256: await sha256File(tarPath),
    bytes: statSync(tarPath).size,
    builtAt: (options.now?.() ?? new Date()).toISOString(),
  };
  writeManifest(dir, manifest);

  return manifest;
}
