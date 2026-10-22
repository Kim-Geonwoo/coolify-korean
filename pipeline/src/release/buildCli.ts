import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DraftMeta } from '../i18n/drafts.ts';
import { langPaths } from '../i18n/languages.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { postDiscord } from '../sync/discord.ts';
import { reviewedFromUnits } from '../weblate/bridge.ts';
import { reviewedShrinksTooMuch } from '../weblate/syncCli.ts';
import { createClient, type WeblateUnit } from '../weblate/client.ts';
import { WEBLATE } from '../weblate/config.ts';
import { writeHandoff, type LangManifest } from './handoff.ts';
import { buildReleaseImage, readTrustCommand, trustMessage } from './image.ts';
import { selectKo, type SelectCounts } from './select.ts';
import { fetchDev, readDevFile } from './source.ts';

/**
 * 번역 묶기(4단계 설계 5.1, 5분 타이머). Weblate 승인·미승인 수정과 레포 dev의 초안을 ko.json으로 묶어 전달 폴더에 둔다.
 * Weblate·GitHub를 읽지 못하거나 결과가 이상하면(단위가 모자람, 승인이 크게 줄어듦) 직전 파일을 그대로 두고 실패 수를 센다.
 * 실패 수는 일을 시작하기 전에 먼저 올려 둔다: 시간 제한으로 강제 종료돼도 실패로 남고, 다음 회차가 알린다(검토 2026-10-18 I2)
 */
export interface ReleaseState {
  readonly lastChange: string;
  readonly devCommit: string;
  readonly builtAt: string;
  readonly failures: number;
  /** 이번 연속 실패를 Discord로 알렸는지(성공하면 지운다) */
  readonly notified?: boolean;
}

export interface ReleaseDeps {
  readonly now: () => Date;
  readonly fetchDev: () => string;
  /** Weblate ko 번역의 마지막 변경 시각(없으면 '') */
  readonly lastChange: () => Promise<string>;
  readonly units: () => Promise<readonly WeblateUnit[]>;
  /** 받은 dev 커밋의 파일(그 커밋에 없으면 undefined). 커밋으로 읽어야 기록한 커밋과 읽은 파일이 어긋나지 않는다 */
  readonly readDev: (commit: string, path: string) => string | undefined;
  /** 직전에 낸 묶음의 승인 수(없으면 undefined) */
  readonly previousApproved: () => number | undefined;
  /** 승인이 크게 줄어도 한 번 내보낸다(사람이 확인한 뒤, 다리의 --allow-shrink와 같음) */
  readonly allowShrink?: boolean;
  readonly write: (ko: Readonly<Record<string, string>>, info: Omit<LangManifest, 'schema' | 'sha256' | 'builtAt'>) => 'written' | 'same';
  readonly readState: () => ReleaseState | undefined;
  readonly writeState: (state: ReleaseState) => void;
  readonly notify: (message: string) => Promise<void>;
}

export type ReleaseResult = { readonly kind: 'skipped' } | { readonly kind: 'written' | 'same'; readonly counts: SelectCounts } | { readonly kind: 'kept'; readonly reason: string };

// 아무것도 안 바뀐 것 같아도 이만큼 지나면 다시 묶는다(변경 감지를 last_change 하나에만 기대지 않게, 검토 경미 13)
const REBUILD_MS = 60 * 60_000;
const NOTIFY_AFTER = 3;

/** 상태 파일이 깨졌으면 없는 것으로 본다 */
function validState(raw: ReleaseState | undefined): ReleaseState | undefined {
  if (raw === undefined || typeof raw !== 'object') {
    return undefined;
  }
  const { lastChange, devCommit, builtAt, failures, notified } = raw as unknown as Record<string, unknown>;
  if (typeof lastChange !== 'string' || typeof devCommit !== 'string' || typeof builtAt !== 'string' || typeof failures !== 'number' || !Number.isInteger(failures) || failures < 0) {
    return undefined;
  }

  return { lastChange, devCommit, builtAt, failures, notified: notified === true };
}

export async function runReleaseBuild(deps: ReleaseDeps): Promise<ReleaseResult> {
  const before = validState(deps.readState());
  const now = deps.now();
  const failing: ReleaseState = { ...(before ?? { lastChange: '', devCommit: '', builtAt: '' }), failures: (before?.failures ?? 0) + 1, notified: before?.notified ?? false };
  deps.writeState(failing);
  try {
    const devCommit = deps.fetchDev();
    const lastChange = await deps.lastChange();
    if (before !== undefined && before.failures === 0 && before.lastChange === lastChange && before.devCommit === devCommit && now.getTime() - Date.parse(before.builtAt) < REBUILD_MS) {
      deps.writeState(before);

      return { kind: 'skipped' };
    }
    const json = (path: string): unknown => {
      const text = deps.readDev(devCommit, path);
      if (text === undefined) {
        throw new Error(`레포 dev에 ${path}가 없습니다.`);
      }

      return JSON.parse(text) as unknown;
    };
    const optional = <T>(path: string, fallback: T): T => (deps.readDev(devCommit, path) === undefined ? fallback : (json(path) as T));
    const catalog = json('i18n/catalog.json') as CatalogLite;
    const drafts = (json('i18n/release.json') as { mode?: unknown }).mode === 'drafts';
    const exclusions = new Map(Object.entries((json('i18n/exclude.json') as { keys: Record<string, string> }).keys));
    const verbatim = (json('i18n/verbatim.json') as { literals: string[] }).literals;
    const paths = langPaths(WEBLATE.lang);
    const store = { drafts: drafts ? (json(paths.drafts) as Record<string, string>) : {}, meta: json(paths.draftsMeta) as Record<string, DraftMeta> };
    const previous = { reviewed: optional<Record<string, string>>(paths.reviewed, {}), meta: optional<Record<string, { sourceHash: string }>>(paths.reviewedMeta, {}) };
    const units = await deps.units();
    // 컴포넌트를 다시 만들었거나 일부만 읽혔을 때(검토 I3): 운영 화면을 기계 초안·영어로 바꾸지 않고 멈춘다
    const catalogKeys = Object.keys(catalog.keys).length;
    if (units.length < catalogKeys / 2) {
      throw new Error(`Weblate 단위가 ${String(units.length)}개뿐입니다(카탈로그 ${String(catalogKeys)}키). 컴포넌트를 확인하세요.`);
    }
    const fromWeblate = reviewedFromUnits({ units, catalog, exclusions, verbatim, previous });
    // reviewed 모드(3단계 노출 스위치)는 승인본만, drafts 모드는 승인 ∪ 미승인 수정 ∪ 초안
    const selection = selectKo({ catalog, store, exclusions, verbatim, weblate: { reviewed: fromWeblate.reviewed, pending: drafts ? fromWeblate.pending : {} } });
    if (selection === null) {
      throw new Error('번역을 고르지 못했습니다.');
    }
    const approvedBefore = deps.previousApproved();
    if (deps.allowShrink !== true && approvedBefore !== undefined && reviewedShrinksTooMuch(approvedBefore, selection.counts.approved)) {
      throw new Error(`승인이 ${String(approvedBefore)} → ${String(selection.counts.approved)}개로 크게 줄어 멈춥니다(확인 뒤 --allow-shrink로 한 번 내보냄).`);
    }
    const written = deps.write(selection.ko, { catalogVersion: catalog.version, devCommit, weblateLastChange: lastChange, counts: selection.counts });
    deps.writeState({ lastChange, devCommit, builtAt: now.toISOString(), failures: 0 });

    return { kind: written, counts: selection.counts };
  } catch (error: unknown) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    if (failing.failures >= NOTIFY_AFTER && failing.notified !== true) {
      await deps.notify(`coolify-ko 번역 묶기가 ${String(failing.failures)}번 이어서 실패했습니다(PaaS는 직전 번역 그대로): ${reason}`);
      deps.writeState({ ...failing, notified: true });
    }

    return { kind: 'kept', reason };
  }
}

const USAGE = '사용법: cli.ts release build [--token-dir D(기본 $CREDENTIALS_DIRECTORY)] [--base-url http://127.0.0.1:8792] [--git-dir D] [--remote URL] [--out D] [--state 파일] | release image [--repo D] [--out D] [--ref origin/dev]';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

export async function releaseCommand(argv: readonly string[]): Promise<void> {
  if (argv[1] === 'image') {
    // 밤 작업과 같은 한국어판 이미지를 손으로 만든다(리허설·재시도). 새로 만들면 승인 명령을 찍고, 웹훅이 있으면 Discord로도 보낸다
    const result = await buildReleaseImage({ repo: option(argv, 'repo') ?? process.cwd(), out: option(argv, 'out') ?? '/srv/handoff/coolify-ko/images', ref: option(argv, 'ref') ?? 'origin/dev' });
    if (result.kind === 'built' && result.manifest !== undefined) {
      const message = trustMessage(result.manifest.version, result.manifest.configDigest, result.manifest.commit, readTrustCommand());
      console.log(`한국어판 이미지: 새로 만듦 ${result.key} (${String(Math.round(result.manifest.bytes / 1024 / 1024))}MB)\n${message}`);
      const credentials = process.env['CREDENTIALS_DIRECTORY'];
      if (credentials !== undefined) {
        await postDiscord(join(credentials, 'discord-webhook'), message);
      }
    } else {
      console.log(`한국어판 이미지: 그대로(${result.key})`);
    }

    return;
  }
  const tokenDir = option(argv, 'token-dir') ?? process.env['CREDENTIALS_DIRECTORY'];
  if (argv[1] !== 'build' || tokenDir === undefined) {
    throw new Error(USAGE);
  }
  const base = option(argv, 'base-url') ?? process.env['COOLIFY_KO_WEBLATE_URL'] ?? 'http://127.0.0.1:8792';
  // 토큰을 보내는 곳이라 같은 호스트의 Weblate만 받는다(밤 작업과 같은 검사)
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(base)) {
    throw new Error('Weblate 주소는 http://127.0.0.1:<포트>여야 합니다.');
  }
  const gitDir = option(argv, 'git-dir') ?? '/srv/coolify-ko/cache/release-src.git';
  const remote = option(argv, 'remote') ?? 'git@github.com:Kim-Geonwoo/coolify-ko.git';
  const out = option(argv, 'out') ?? '/srv/handoff/coolify-ko/lang';
  const statePath = option(argv, 'state') ?? '/srv/coolify-ko/cache/release.state.json';
  // 다리 봇 토큰을 읽기에만 쓴다. 따로 읽기 전용 봇을 두지 않는다: 같은 유닉스 계정이 모든 토큰 파일을 읽을 수 있어 나눠도 격리가 되지 않는다
  const token = readFileSync(join(tokenDir, 'weblate-bridge.token'), 'utf8').trim();
  if (token === '') {
    throw new Error('Weblate 토큰 파일이 비어 있습니다: weblate-bridge.token');
  }
  // 요청마다 15초. 유닛 상한(4분) 안에서 실패로 끝나야 센다(검토 I2)
  const client = createClient({ baseUrl: base, token, timeoutMs: 15_000 });
  const translation = `/api/translations/${encodeURIComponent(WEBLATE.project)}/${encodeURIComponent(WEBLATE.component)}/${encodeURIComponent(WEBLATE.lang)}/`;

  const result = await runReleaseBuild({
    now: () => new Date(),
    fetchDev: () => fetchDev(gitDir, remote),
    lastChange: async () => {
      const { status, data } = await client.raw('GET', translation);
      if (status !== 200) {
        throw new Error(`Weblate 번역 정보를 읽지 못했습니다(HTTP ${String(status)}).`);
      }
      const value = (data as { last_change?: unknown }).last_change;

      return typeof value === 'string' ? value : '';
    },
    units: () => client.units(WEBLATE.project, WEBLATE.component, WEBLATE.lang),
    readDev: (commit, path) => readDevFile(gitDir, path, commit),
    previousApproved: () => {
      try {
        const approved = (JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8')) as { counts?: { approved?: unknown } }).counts?.approved;

        return typeof approved === 'number' ? approved : undefined;
      } catch {
        return undefined;
      }
    },
    allowShrink: argv.includes('--allow-shrink'),
    write: (ko, info) => writeHandoff(out, ko, info, new Date()),
    readState: () => {
      try {
        return JSON.parse(readFileSync(statePath, 'utf8')) as ReleaseState;
      } catch {
        return undefined;
      }
    },
    writeState: (state) => {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(`${statePath}.partial`, `${JSON.stringify(state, null, 2)}\n`);
      renameSync(`${statePath}.partial`, statePath);
    },
    notify: (message) => postDiscord(join(tokenDir, 'discord-webhook'), message),
  });
  const counts = 'counts' in result ? ` · 승인 ${String(result.counts.approved)} · 미승인 수정 ${String(result.counts.pending)} · 초안 ${String(result.counts.drafts)} · 영어 ${String(result.counts.english)}` : '';
  const label = { skipped: '바뀐 것 없음', written: '새로 씀', same: '내용 같음', kept: '직전 파일 유지' }[result.kind];
  console.log(`번역 묶기: ${label}${counts}${result.kind === 'kept' ? ` (${result.reason})` : ''}`);
}
