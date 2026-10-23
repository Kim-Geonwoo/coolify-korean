import type { Candidate } from '../publish/candidates.ts';
import type { SyncState } from './state.ts';
import { recordFailure, recordSuccess, type JobEvent, type JobStatus } from './status.ts';
import type { UpstreamDecision } from './upstream.ts';

const MIN_MEMORY_GIB = 10;
const MIN_DISK_GIB = 40;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SUNDAY = 0;

export interface DraftSummary {
  readonly added: number;
  readonly changed: number;
  readonly removed: number;
  readonly drafted: number;
  readonly fallbacks: number;
  readonly normalized: number;
  /** 마감으로 멈춰 다음 밤에 이어 할 키 */
  readonly pending: number;
}

/** 밤 작업이 바깥과 만나는 곳. 서버에서는 git·rootless Docker·llama-server·Gemini·Discord로, 시험에서는 가짜로 채운다 */
export interface NightDeps {
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly readStatus: () => JobStatus;
  readonly writeStatus: (status: JobStatus) => void;
  readonly readState: () => SyncState;
  readonly writeState: (state: SyncState) => void;
  /** fetch → reset --hard origin/dev → clean -fdx */
  readonly resetWorkcopy: () => Promise<void>;
  readonly resources: () => Promise<{ readonly memFreeGiB: number; readonly diskFreeGiB: number }>;
  readonly upstream: (state: SyncState) => Promise<UpstreamDecision>;
  /** state의 버전으로 추출해 i18n/catalog.json·en.json을 바꾼다(카탈로그 버전 확인 포함) */
  readonly extract: (state: SyncState) => Promise<void>;
  /** 번역 메모리 → 엔진(원장 이어 쓰기) → 초안 저장 */
  readonly drafts: () => Promise<DraftSummary>;
  /** 지금 카탈로그에서 엔진이 아직 처리하지 않은 키 수. 0보다 크면 새 버전이 아닌 밤에도 초안을 잇는다 */
  readonly pendingDrafts?: () => Promise<number>;
  /** 하루 한도 안에서 Flash 검토, 판정은 캐시에 쌓고 초안 메타에 다시 얹는다 */
  readonly review: () => Promise<{ readonly reviewed: number; readonly queueEmpty: boolean }>;
  /** Weblate 다리(원문·초안·제안 올리기, 승인 내려받기). 실패해도 밤 작업은 계속한다 */
  readonly weblate?: () => Promise<{ readonly changed: boolean; readonly rejected: readonly string[] }>;
  /** PaaS용 한국어판 이미지를 dev 상태로 만들어 전달 폴더에 둔다(같은 이미지가 있으면 건너뜀, 4단계). 실패해도 결과는 바뀌지 않는다.
   * ready = 게이트를 통과한 이미지가 있음, skipped = 전달 폴더 없음·시간 부족으로 보지 않음 */
  readonly releaseImage?: () => Promise<'ready' | 'skipped'>;
  /** 공개판 후보·상류 후크 판정(비치명, 5단계). 게이트 결과는 그 밤의 한국어판 이미지 단계에서 온다 */
  readonly publishPlan?: (input: { readonly upstream: { readonly version: string; readonly seenAt: string }; readonly gates: 'passed' | 'failed' | 'unknown' }) => Promise<PublishPlan>;
  /** 시험 인스턴스 스크린샷을 Weblate에 올린다(새 버전일 때만 찍는 판단은 deps 쪽). 실패해도 결과는 바뀌지 않는다 */
  readonly screenshots?: () => Promise<void>;
  readonly hasChanges: () => Promise<boolean>;
  readonly verify: () => Promise<void>;
  /** 봇 저자로 커밋하고 bot/* 로만 푸시한다. PR을 열었으면 그 주소를 돌려준다 */
  readonly commitAndPush: (message: string) => Promise<string | undefined>;
  readonly notify: (event: JobEvent) => Promise<void>;
  readonly compareUrl: string;
  /** 잡 전 자원 하한(없으면 노드 MemFree 10GiB·SSD 여유 40GiB). 리허설은 높여서 부족을 흉내 낸다 */
  readonly limits?: { readonly memoryGiB: number; readonly diskGiB: number };
}

/** 공개판 발행 후보·상류 후크 판정 결과(5단계). 발행은 하지 않는다 */
export interface PublishPlan {
  readonly candidate: Candidate;
  readonly hookIssues: readonly string[];
  readonly hookFingerprint: string;
  /** release.json의 publish가 켜졌을 때만 후보를 알린다 */
  readonly announce: boolean;
}

export type NightOutcome = 'pushed' | 'reviewed' | 'nothing' | 'waiting' | 'postponed' | 'failed';

class StageFailure extends Error {
  readonly stage: string;
  readonly code: string;

  constructor(stage: string, code: string) {
    super(`${stage}: ${code}`);
    this.stage = stage;
    this.code = code;
  }
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;

  return typeof code === 'string' && /^[a-z0-9-]{1,40}$/.test(code) ? code : 'error';
}

function kstWeekday(date: Date): number {
  return new Date(date.getTime() + KST_OFFSET_MS).getUTCDay();
}

/**
 * 하룻밤 작업. 단계가 실패하면 짧은 코드로 기록하고 알린 뒤 멈춘다. 같은 실패가 3번 이어지면 그 단계를 끈다.
 * 검토 판정만 바뀐 날은 커밋하지 않고, 일요일(KST)이나 대기열이 빈 날에 묶어 올린다.
 */
export async function runNight(deps: NightDeps): Promise<NightOutcome> {
  let status = deps.readStatus();
  const at = (): string => deps.now().toISOString();
  const enabled = (stage: string): boolean => !status.disabled.includes(stage);
  const guard = async <T>(stage: string, work: () => Promise<T>): Promise<T> => {
    try {
      return await work();
    } catch (error: unknown) {
      throw new StageFailure(stage, codeOf(error));
    }
  };

  try {
    await guard('workcopy', deps.resetWorkcopy);
    const resources = await guard('resources', deps.resources);
    const minMemory = deps.limits?.memoryGiB ?? MIN_MEMORY_GIB;
    const minDisk = deps.limits?.diskGiB ?? MIN_DISK_GIB;
    if (resources.memFreeGiB < minMemory || resources.diskFreeGiB < minDisk) {
      const code = resources.memFreeGiB < minMemory ? 'low-memory' : 'low-disk';
      status = recordFailure(status, 'resources', code, at());
      // 자원 부족은 단계를 끄지 않는다(다음 밤에 다시 본다)
      status = { ...status, disabled: status.disabled.filter((stage) => stage !== 'resources') };
      await deps.notify({ type: 'failure', stage: 'resources', code, count: status.failures.resources?.count ?? 1, disabled: false });

      return 'postponed';
    }

    let processed: { version: string; summary: DraftSummary; continued: boolean } | undefined;
    let waiting = false;
    if (enabled('upstream')) {
      const current = deps.readState();
      const decision = await guard('upstream', () => deps.upstream(current));
      // 상류 안정판을 처음 본 시각(같은 버전이면 그대로 둔다). 거꾸로 가거나 다이제스트가 바뀐 밤에는 바꾸지 않는다
      const seen = decision.action === 'wait' || decision.action === 'new' ? decision.version : decision.action === 'same' ? current.upstream.version : undefined;
      if (seen !== undefined && status.upstreamSeen?.version !== seen) {
        status = { ...status, upstreamSeen: { version: seen, at: at() } };
      }
      if (decision.action === 'stop') {
        status = recordFailure(status, 'upstream', decision.reason, at());
        await deps.notify({ type: 'stop', reason: decision.reason, detail: decision.detail });
      } else if (decision.action === 'wait') {
        waiting = true;
        deps.log(`업스트림 ${decision.version} 대기: ${decision.reason}`);
      } else if (decision.action === 'new') {
        const next: SyncState = { upstream: { ...current.upstream, version: decision.version, digest: decision.digest } };
        deps.writeState(next);
        await guard('extract', () => deps.extract(next));
        const summary = await guard('drafts', deps.drafts);
        status = recordSuccess(status, 'upstream', at());
        processed = { version: decision.version, summary, continued: false };
      } else {
        status = recordSuccess(status, 'upstream', at());
        // 지난밤 마감으로 남긴 키를 잇는다. 남은 것이 없으면 엔진을 띄우지 않는다
        if (deps.pendingDrafts !== undefined && enabled('drafts') && (await guard('drafts', deps.pendingDrafts)) > 0) {
          processed = { version: current.upstream.version, summary: await guard('drafts', deps.drafts), continued: true };
        }
      }
    }

    let queueEmpty = false;
    let reviewed = 0;
    if (enabled('review')) {
      const result = await guard('review', deps.review);
      queueEmpty = result.queueEmpty;
      reviewed = result.reviewed;
      status = recordSuccess(status, 'review', at());
    }

    let reviewedChanged = false;
    let weblateOk = false;
    if (deps.weblate !== undefined && enabled('weblate')) {
      try {
        const result = await deps.weblate();
        reviewedChanged = result.changed;
        weblateOk = true;
        status = recordSuccess(status, 'weblate', at());
        // 같은 키 묶음은 한 번만 알린다(고칠 때까지 매일 반복하지 않게). 다 고쳐지면 기억을 지운다
        const rejected = [...result.rejected].sort();
        if (rejected.length > 0 && rejected.join('\n') !== (status.rejected ?? []).join('\n')) {
          await deps.notify({ type: 'rejected', keys: rejected });
        }
        status = { ...status, rejected };
      } catch (error: unknown) {
        // 비치명 단계: Weblate가 내려가 있어도 그날 새 초안은 올린다
        const code = codeOf(error);
        status = recordFailure(status, 'weblate', code, at());
        await deps.notify({ type: 'failure', stage: 'weblate', code, count: status.failures.weblate?.count ?? 1, disabled: status.disabled.includes('weblate') });
      }
    }

    const reviewDay = kstWeekday(deps.now()) === SUNDAY || queueEmpty;
    let outcome: NightOutcome = processed !== undefined ? 'pushed' : reviewed > 0 ? 'reviewed' : waiting ? 'waiting' : 'nothing';
    let review: string | undefined;
    // 사람이 승인한 검수 결과는 그날 바로 올린다(검토자 판정만 바뀐 날은 일요일이나 대기열이 빈 날에 묶는다)
    if ((processed !== undefined || reviewDay || reviewedChanged) && enabled('push') && (await guard('push', deps.hasChanges))) {
      await guard('verify', deps.verify);
      const message = processed !== undefined ? `i18n: ${processed.version} 초안${processed.continued ? ' 이어서' : ''}` : reviewedChanged ? 'i18n: 검수 결과' : 'i18n: 검토 결과';
      review = await guard('push', () => deps.commitAndPush(message));
      outcome = 'pushed';
      status = recordSuccess(status, 'push', at());
    } else if (outcome === 'pushed') {
      outcome = 'nothing';
    }
    if (processed !== undefined) {
      await deps.notify({ type: 'version', version: processed.version, ...processed.summary, compare: review ?? deps.compareUrl });
    }

    // 한국어판 이미지(비치명): 병합된 dev만 쓰므로 Weblate 단계와 상관없다. PaaS 반영이 스크린샷보다 급해 먼저 한다
    let gates: 'passed' | 'failed' | 'unknown' = 'unknown';
    if (deps.releaseImage !== undefined && enabled('release-image')) {
      try {
        gates = (await deps.releaseImage()) === 'ready' ? 'passed' : 'unknown';
        status = recordSuccess(status, 'release-image', at());
      } catch (error: unknown) {
        gates = 'failed';
        const code = codeOf(error);
        status = recordFailure(status, 'release-image', code, at());
        await deps.notify({ type: 'failure', stage: 'release-image', code, count: status.failures['release-image']?.count ?? 1, disabled: status.disabled.includes('release-image') });
      }
    }

    // 공개판 후보·상류 후크(비치명, 5단계): 발행은 사람이 PC에서 한다. 후크 문제는 처음 생긴 날 한 번 알린다(PaaS 업데이트에도 영향)
    if (deps.publishPlan !== undefined && enabled('publish-plan') && status.upstreamSeen !== undefined) {
      try {
        const plan = await deps.publishPlan({ upstream: { version: status.upstreamSeen.version, seenAt: status.upstreamSeen.at }, gates });
        status = recordSuccess(status, 'publish-plan', at());
        const issues = [...plan.hookIssues].sort();
        if (issues.length > 0 && issues.join('\n') !== (status.hooks?.issues ?? []).join('\n')) {
          await deps.notify({ type: 'hooks', issues });
        } else if (issues.length === 0 && status.hooks !== undefined && status.hooks.fingerprint !== plan.hookFingerprint) {
          await deps.notify({ type: 'hooks-changed' });
        }
        status = { ...status, hooks: { fingerprint: plan.hookFingerprint, issues } };
        const { candidate } = plan;
        if (plan.announce && candidate.kind !== 'none' && `${candidate.kind}:${candidate.version}` !== status.candidate) {
          await deps.notify({ type: 'candidate', kind: candidate.kind, version: candidate.version });
          status = { ...status, candidate: `${candidate.kind}:${candidate.version}` };
        }
      } catch (error: unknown) {
        const code = codeOf(error);
        status = recordFailure(status, 'publish-plan', code, at());
        await deps.notify({ type: 'failure', stage: 'publish-plan', code, count: status.failures['publish-plan']?.count ?? 1, disabled: status.disabled.includes('publish-plan') });
      }
    }

    // 스크린샷(비치명): 푸시 뒤에 둬 그날 초안·검수 결과가 늦어지지 않게 한다. 찍을지(버전·남은 시간)는 deps가 정한다
    // Weblate 단계가 그날 성공했을 때만 찍는다. 실패한 밤에는 새 키가 Weblate에 없어 이어지지 않은 채 그 버전이 '찍음'으로 굳는다
    if (deps.screenshots !== undefined && enabled('screenshots') && weblateOk) {
      try {
        await deps.screenshots();
        status = recordSuccess(status, 'screenshots', at());
      } catch (error: unknown) {
        const code = codeOf(error);
        status = recordFailure(status, 'screenshots', code, at());
        await deps.notify({ type: 'failure', stage: 'screenshots', code, count: status.failures.screenshots?.count ?? 1, disabled: status.disabled.includes('screenshots') });
      }
    }

    return outcome;
  } catch (error: unknown) {
    if (!(error instanceof StageFailure)) {
      throw error;
    }
    status = recordFailure(status, error.stage, error.code, at());
    const failure = status.failures[error.stage];
    deps.log(`실패: ${error.stage} (${error.code})`);
    await deps.notify({ type: 'failure', stage: error.stage, code: error.code, count: failure?.count ?? 1, disabled: status.disabled.includes(error.stage) });

    return 'failed';
  } finally {
    deps.writeStatus(status);
  }
}
