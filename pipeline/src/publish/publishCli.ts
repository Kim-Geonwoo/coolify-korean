import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UPDATE_PUBLIC_KEY } from '../../../extension/src/updateKey.ts';
import { verifyBytes } from '../extension/signing.ts';
import { primaryLanguage } from '../i18n/languages.ts';
import { loadState, parseState } from '../sync/state.ts';
import { parseStableVersion, type Fetcher } from '../sync/upstream.ts';
import { buildPublicImage, officialImage, verifyPublicImage, type PublicManifest } from './build.ts';
import { decideCandidate } from './candidates.ts';
import { fetchHookFiles, hookIssues } from './hooks.ts';
import { latestPublished, parsePublished, type PublishedLedger } from './ledger.ts';
import { buildMirror, mirrorIssues } from './mirror.ts';
import { buildSite, refreshVersions, versionsPath, writeSite, type SiteInput } from './site.ts';
import { INTERNAL_NAMES_FILE, loadInternalNames } from '../../../scripts/repo-guard.ts';
import { exportSource } from './source.ts';
import { parseLoadedId, parsePushDigest, pushDecision, recordPublished, remoteIssues } from './push.ts';
import { IMAGE_REPO } from './site.ts';
import { publicLangFile } from '../release/publicLang.ts';

/**
 * 공개판 발행 준비 명령(5단계, 사용자 PC에서). 레지스트리 push·서명·미러 게시는 공개 계획에서 더한다.
 *   plan: 지금 후보와 근거, build: 공개판 OCI 묶음, verify: 묶음 검증, mirror: versions.json 미러 파일
 */
export interface PublishIo {
  readonly root: string;
  readonly fetcher: Fetcher;
  readonly log: (line: string) => void;
  readonly now: () => Date;
}

const USAGE = '사용법: cli.ts publish plan [--seen-at ISO] | build [--ref origin/dev] [--out .work/publish] | verify <폴더> | mirror --out <파일> [--seen-at ISO] | site --out <폴더> [--commit REV] [--cosign-pub 파일] [--extension 폴더] [--refresh-versions] | source --to <공개 레포 폴더> [--commit REV] | push <폴더> [--repo REPO] | record <폴더>';
const VERSIONS_URL = 'https://cdn.coollabs.io/coolify/versions.json';
const TIMEOUT_MS = 20_000;

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

async function officialVersions(io: PublishIo): Promise<unknown> {
  const response = await io.fetcher(VERSIONS_URL, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'coolify-ko-publish', accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`versions.json을 받지 못했습니다(HTTP ${String(response.status)}).`);
  }

  return (await response.json()) as unknown;
}

const ledger = (root: string): PublishedLedger => parsePublished(JSON.parse(readFileSync(join(root, 'releases', 'published.json'), 'utf8')) as unknown);

const seenAt = (argv: readonly string[], io: PublishIo): string => {
  const value = option(argv, 'seen-at') ?? io.now().toISOString();
  if (Number.isNaN(Date.parse(value))) {
    throw new Error('--seen-at이 날짜가 아닙니다.');
  }

  return value;
};

async function plan(argv: readonly string[], io: PublishIo): Promise<number> {
  const stable = parseStableVersion(await officialVersions(io));
  const state = loadState(join(io.root, 'i18n', 'state.json'));
  const head = spawnSync('git', ['-C', io.root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const commit = head.status === 0 ? head.stdout.trim() : '';
  const published = ledger(io.root);
  const issues = hookIssues(await fetchHookFiles(stable, io.fetcher));
  // PC에서는 게이트 결과를 모른다: 빌드(publish build)가 게이트를 다시 돈다
  const candidate = decideCandidate({ upstream: { version: stable, seenAt: seenAt(argv, io) }, dev: { version: state.upstream.version, commit, gates: 'passed' }, hooksOk: issues.length === 0, published, now: io.now() });
  io.log(`상류 안정판 ${stable} · 작업 사본 ${state.upstream.version}(${commit.slice(0, 7)}) · 최신 발행 ${latestPublished(published) ?? '없음'}`);
  io.log(issues.length === 0 ? '상류 후크: 정상' : `상류 후크 문제: ${issues.join(' · ')}`);
  io.log(candidate.kind === 'none' ? `후보 없음(${candidate.reason})` : candidate.kind === 'ko' ? `후보: 한국어판 ${candidate.version} → node pipeline/src/cli.ts publish build` : `후보: 통과 태그 ${candidate.version}(공식 이미지 그대로)`);

  return 0;
}

async function build(argv: readonly string[], io: PublishIo): Promise<number> {
  const manifest = await buildPublicImage({ repo: io.root, ref: option(argv, 'ref') ?? 'origin/dev', code: primaryLanguage(io.root).code, out: option(argv, 'out') ?? join(io.root, '.work', 'publish') });
  io.log(`공개판 ${manifest.key}: index ${manifest.index} · ${String(Math.round(manifest.bytes / 1024 / 1024))}MB · dev ${manifest.commit.slice(0, 7)}`);
  io.log(`다음: node pipeline/src/cli.ts publish verify ${join(option(argv, 'out') ?? join(io.root, '.work', 'publish'), manifest.key)}`);

  return 0;
}

async function verify(dir: string, io: PublishIo): Promise<number> {
  // 비교 기준(공식 이미지·버전)은 검증 대상인 manifest.json이 아니라 그 커밋의 state.json에서 읽는다
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as Partial<PublicManifest>;
  const commit = typeof manifest.commit === 'string' && /^[0-9a-f]{40}$/.test(manifest.commit) ? manifest.commit : undefined;
  const shown = commit === undefined ? undefined : spawnSync('git', ['-C', io.root, 'show', `${commit}:i18n/state.json`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  if (shown?.status !== 0) {
    throw new Error('manifest.json의 커밋에서 state.json을 읽지 못했습니다.');
  }
  const { image, digest, version } = parseState(JSON.parse(shown.stdout) as unknown).upstream;
  const issues = await verifyPublicImage(dir, (platform) => officialImage(image, digest, platform), { baseIndex: digest, version });
  io.log(issues.length === 0 ? `검증 통과: ${dir}` : `검증 문제 ${String(issues.length)}건: ${issues.slice(0, 10).join(' / ')}`);

  return issues.length === 0 ? 0 : 1;
}

async function mirror(argv: readonly string[], io: PublishIo, out: string): Promise<number> {
  const cdn = await officialVersions(io);
  const published = ledger(io.root);
  let built: Record<string, unknown>;
  try {
    built = buildMirror({ cdn, published, upstreamSeenAt: seenAt(argv, io), now: io.now() });
  } catch (error: unknown) {
    io.log(`미러를 만들지 않음: ${error instanceof Error ? error.message : String(error)}`);

    return 1;
  }
  const issues = mirrorIssues(built, cdn, published);
  if (issues.length > 0) {
    io.log(`미러 검사 문제: ${issues.join(' / ')}`);

    return 1;
  }
  const text = `${JSON.stringify(built, null, 2)}\n`;
  const partial = `${out}.partial`;
  writeFileSync(partial, text);
  renameSync(partial, out);
  io.log(`미러: ${out} sha256 ${createHash('sha256').update(text).digest('hex')}`);

  return 0;
}

/** 그 커밋의 파일(없으면 undefined) */
function showAt(root: string, commit: string, path: string): string | undefined {
  const result = spawnSync('git', ['-C', root, 'show', `${commit}:${path}`], { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });

  return result.status === 0 ? result.stdout : undefined;
}

/**
 * 확장 발행 폴더: dictionary.json, 사람이 서명한 dictionary.json.sig, addons.mozilla.org가 서명한 .xpi(있으면 하나).
 * 확장에 든 공개 키로 서명이 풀리는지 먼저 본다(풀리지 않는 사전을 올리면 모든 확장이 갱신을 거부한다)
 */
async function extensionFiles(dir: string): Promise<NonNullable<SiteInput['extension']>> {
  const dictionary = readFileSync(join(dir, 'dictionary.json'));
  const signature = readFileSync(join(dir, 'dictionary.json.sig'), 'utf8');
  if (!(await verifyBytes(UPDATE_PUBLIC_KEY, dictionary, signature))) {
    throw new Error(`${dir}의 dictionary.json 서명이 확장의 공개 키로 풀리지 않습니다. 다시 서명해 주세요.`);
  }
  const xpis = readdirSync(dir).filter((name) => name.endsWith('.xpi'));
  if (xpis.length > 1) {
    throw new Error(`${dir}에 .xpi가 여럿입니다: ${xpis.join(', ')}`);
  }
  const [xpi] = xpis;

  return { dictionary: dictionary.toString('utf8'), signature, ...(xpi === undefined ? {} : { xpi: readFileSync(join(dir, xpi)) }) };
}

/**
 * 미러 사이트. 전체 생성은 사람이 발행할 때(PC), --refresh-versions는 서버가 6시간마다 versions.json만 갱신할 때 쓴다.
 * 발행 기록·언어 파일·스크립트는 작업 사본이 아니라 그 커밋(기본 HEAD)에서 읽는다
 */
async function site(argv: readonly string[], io: PublishIo, out: string): Promise<number> {
  const rev = option(argv, 'commit') ?? 'HEAD';
  const resolved = spawnSync('git', ['-C', io.root, 'rev-parse', `${rev}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
  const commit = resolved.status === 0 ? resolved.stdout.trim() : '';
  const publishedText = commit === '' ? undefined : showAt(io.root, commit, 'releases/published.json');
  if (publishedText === undefined) {
    throw new Error(`${rev}에서 releases/published.json을 읽지 못했습니다.`);
  }
  const published = parsePublished(JSON.parse(publishedText) as unknown);
  const cdn = await officialVersions(io);
  if (argv.includes('--refresh-versions')) {
    const result = refreshVersions(out, { cdn, published, now: io.now() });
    io.log(result.issues.length > 0 ? `versions.json을 쓰지 않음: ${result.issues.join(' / ')}` : result.changed ? 'versions.json 갱신' : 'versions.json 그대로');

    return result.issues.length > 0 ? 1 : 0;
  }
  const { code } = primaryLanguage(io.root);
  const lang = publicLangFile(io.root, commit, code);
  const catalogVersion = (JSON.parse(showAt(io.root, commit, 'i18n/catalog.json') ?? '{}') as { version?: unknown }).version;
  const script = showAt(io.root, commit, 'scripts/coolify-ko.sh');
  if (typeof catalogVersion !== 'string' || script === undefined) {
    throw new Error(`${rev}에 카탈로그나 설치 스크립트가 없습니다.`);
  }
  const previous = ((): unknown => {
    try {
      return JSON.parse(readFileSync(versionsPath(out), 'utf8')) as unknown;
    } catch {
      return undefined;
    }
  })();
  const cosignPath = option(argv, 'cosign-pub');
  const extensionDir = option(argv, 'extension');
  const extension = extensionDir === undefined ? undefined : await extensionFiles(extensionDir);
  const files = buildSite({
    cdn,
    published,
    now: io.now(),
    previousVersions: previous,
    lang: { code, text: lang.text, catalogVersion, commit },
    script,
    ...(cosignPath === undefined ? {} : { cosignPub: readFileSync(cosignPath, 'utf8') }),
    ...(extension === undefined ? {} : { extension }),
  });
  writeSite(out, files);
  io.log(`미러 사이트: ${out} (${String(files.size)}개 파일, dev ${commit.slice(0, 7)})`);

  return 0;
}

const REPO = /^[a-z0-9.-]+(:\d{1,5})?(\/[a-z0-9._-]+)+$/;

function docker(args: readonly string[], timeoutMs = 30 * 60_000): { readonly ok: boolean; readonly out: string } {
  const result = spawnSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });

  return { ok: result.status === 0, out: `${result.stdout}\n${result.stderr}` };
}

/** 레지스트리 태그의 index 다이제스트(없으면 undefined) */
function remoteDigest(ref: string): string | undefined {
  const result = docker(['buildx', 'imagetools', 'inspect', ref], 60_000);
  if (!result.ok) {
    if (/not found|manifest unknown|name unknown|denied/i.test(result.out)) {
      return undefined;
    }
    throw new Error(`레지스트리를 읽지 못했습니다: ${result.out.trim().split('\n').slice(-1).join(' ').slice(0, 200)}`);
  }

  return /Digest:\s+(sha256:[0-9a-f]{64})/.exec(result.out)?.[1];
}

/**
 * 검증한 공개판을 레지스트리에 올린다. 먼저 다시 검증하고, 같은 버전 태그가 다른 내용이면 멈춘다.
 * 올린 뒤 레지스트리의 index가 검증한 플랫폼 manifest를 그대로 가리키는지 본다. 서명(cosign)은 사람이 암호를 넣어 한다
 */
async function push(dir: string, argv: readonly string[], io: PublishIo): Promise<number> {
  if ((await verify(dir, io)) !== 0) {
    return 1;
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PublicManifest;
  const repo = option(argv, 'repo') ?? IMAGE_REPO;
  if (!REPO.test(repo)) {
    throw new Error(`레지스트리 저장소 형식이 아닙니다: ${repo}`);
  }
  const tag = `${repo}:${manifest.version}`;
  const decision = pushDecision(remoteDigest(tag), manifest.index);
  if (decision === 'conflict') {
    io.log(`멈춤: ${tag}가 이미 다른 내용을 가리킵니다(발행한 태그는 옮기지 않습니다).`);

    return 1;
  }
  if (decision === 'push') {
    const loaded = docker(['load', '-i', join(dir, 'image.oci.tar')]);
    if (!loaded.ok || parseLoadedId(loaded.out) !== manifest.index) {
      throw new Error('docker load 결과가 검증한 index와 다릅니다.');
    }
    const tagged = docker(['tag', manifest.index, tag], 60_000);
    const pushed = tagged.ok ? docker(['push', tag]) : tagged;
    if (!pushed.ok || parsePushDigest(pushed.out) !== manifest.index) {
      throw new Error(`docker push가 검증한 index를 올리지 못했습니다: ${pushed.out.trim().split('\n').slice(-1).join(' ').slice(0, 200)}`);
    }
  }
  const raw = docker(['buildx', 'imagetools', 'inspect', '--raw', `${repo}@${manifest.index}`], 60_000);
  const issues = raw.ok ? remoteIssues(JSON.parse(raw.out) as unknown, manifest.platforms) : ['레지스트리에서 index를 읽지 못함'];
  if (issues.length > 0) {
    io.log(`레지스트리 검사 문제: ${issues.join(' / ')}`);

    return 1;
  }
  io.log(`${decision === 'already' ? '이미 있음' : '올림'}: ${tag} (${manifest.index})`);
  io.log(`다음(사람): cosign sign --key %USERPROFILE%\\.coolify-ko\\cosign.key ${repo}@${manifest.index}`);
  io.log(`그다음: node pipeline/src/cli.ts publish record ${dir}`);

  return 0;
}

/** 발행 기록(releases/published.json)에 한 줄을 더한다. 작업 사본 파일을 바꾸고 커밋은 사람이 한다 */
function record(dir: string, io: PublishIo): number {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as PublicManifest;
  const next = recordPublished(ledger(io.root), { version: manifest.version, kind: manifest.kind, index: manifest.index, commit: manifest.commit, at: io.now() });
  writeFileSync(join(io.root, 'releases', 'published.json'), `${JSON.stringify(next, null, 2)}\n`);
  io.log(`발행 기록: ${manifest.version} ${manifest.index}`);

  return 0;
}

export async function publishCommand(argv: readonly string[], io: PublishIo): Promise<number> {
  const out = option(argv, 'out');
  switch (argv[1]) {
    case 'plan':
      return plan(argv, io);
    case 'build':
      return build(argv, io);
    case 'push':
    case 'record': {
      const dir = argv[2];
      if (dir !== undefined && !dir.startsWith('--')) {
        return argv[1] === 'push' ? push(dir, argv, io) : record(dir, io);
      }
      break;
    }
    case 'verify': {
      const dir = argv[2];
      if (dir !== undefined && !dir.startsWith('--')) {
        return verify(dir, io);
      }
      break;
    }
    case 'source': {
      // 공개 소스 레포 작업 사본을 그 커밋의 내보낼 경로로 바꾼다. 커밋·push는 사람이 확인한 뒤 한다
      const to = option(argv, 'to');
      if (to !== undefined) {
        const rev = option(argv, 'commit') ?? 'HEAD';
        const resolved = spawnSync('git', ['-C', io.root, 'rev-parse', `${rev}^{commit}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
        if (resolved.status !== 0) {
          throw new Error(`커밋을 찾지 못했습니다: ${rev}`);
        }
        const commit = resolved.stdout.trim();
        // 내부 이름 목록은 레포 밖에만 있다. 없으면 이름을 확인할 수 없으니 내보내지 않는다(2026-10-22 보안 점검)
        const internalNames = loadInternalNames();
        if (internalNames === undefined || internalNames.length === 0) {
          throw new Error(`내부 이름 목록이 없어 공개 소스를 내보내지 않습니다: ${INTERNAL_NAMES_FILE}`);
        }
        const result = exportSource({ repo: io.root, commit, to, internalNames });
        io.log(`공개 소스: ${to} (${String(result.files)}개 파일)`);
        io.log(`다음: 그 폴더에서 pnpm install --frozen-lockfile && pnpm verify, 커밋 메시지 "sync: ${commit.slice(0, 12)}"`);

        return 0;
      }
      break;
    }
    case 'site':
      if (out !== undefined) {
        return site(argv, io, out);
      }
      break;
    case 'mirror':
      if (out !== undefined) {
        return mirror(argv, io, out);
      }
      break;
    default:
      break;
  }
  io.log(USAGE);

  return 2;
}
