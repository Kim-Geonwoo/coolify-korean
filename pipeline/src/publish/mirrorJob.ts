import { latestPublished, type PublishedLedger } from './ledger.ts';

/**
 * 서버의 미러 자동 갱신(5단계 공개 계획 P2, 사용자 결정 (가)). 6시간마다 versions.json만 다시 만들어 미러 레포 main에 push한다.
 * Cloudflare Workers(정적 자산)가 그 레포의 public 폴더를 낸다. 서버 자격은 미러 레포 하나의 배포 키뿐이고, 서명 키는 없다(언어 파일·확장 파일은 사람이 PC에서 발행).
 * 첫 발행 전(사이트가 비었거나 발행 기록이 없음)에는 아무것도 하지 않는다
 */
export interface MirrorStatus {
  readonly failures: number;
  readonly lastSuccess?: string;
  /** 이번 연속 실패를 알렸는지(성공하면 지운다) */
  readonly notified?: boolean;
  /** 마지막으로 알린 태그 불일치(같은 불일치는 다시 알리지 않는다. 성공하면 지운다) */
  readonly alert?: string;
}

export interface MirrorJobDeps {
  readonly now: () => Date;
  readonly log: (line: string) => void;
  /** 미러 레포를 받아 origin/main으로 맞춘다(없으면 clone) */
  readonly sync: () => Promise<void>;
  /** 사이트에 versions.json이 있는지(사람의 첫 발행이 끝났는지) */
  readonly siteReady: () => boolean;
  /** 작업 레포 origin/dev의 releases/published.json */
  readonly published: () => PublishedLedger;
  /** 레지스트리에서 그 버전 태그가 지금 가리키는 index 다이제스트(태그가 없으면 undefined, 확인 못 하면 던짐) */
  readonly registry: (version: string) => Promise<string | undefined>;
  readonly cdn: () => Promise<unknown>;
  readonly refresh: (input: { readonly cdn: unknown; readonly published: PublishedLedger; readonly now: Date }) => { readonly changed: boolean; readonly issues: readonly string[] };
  /** versions.json을 커밋해 main에 push한다. 앞서간 커밋이 있으면 rejected */
  readonly push: () => Promise<'pushed' | 'rejected'>;
  /** 잠시 뒤 사이트가 push한 내용을 내는지 */
  readonly served: () => Promise<boolean>;
  readonly readStatus: () => MirrorStatus;
  readonly writeStatus: (status: MirrorStatus) => void;
  readonly notify: (message: string) => Promise<void>;
}

export type MirrorOutcome = 'skipped' | 'unchanged' | 'pushed' | 'failed';

const NOTIFY_AFTER = 3;

class TagMismatch extends Error {}

const short = (digest: string): string => digest.slice('sha256:'.length, 'sha256:'.length + 12);

/** 발행 기록의 모든 태그가 레지스트리에서 기록한 index 그대로인지. 다르거나 없으면 TagMismatch */
async function checkTags(published: PublishedLedger, registry: MirrorJobDeps['registry']): Promise<void> {
  const mismatches: string[] = [];
  for (const [version, entry] of Object.entries(published.versions)) {
    const actual = await registry(version);
    if (actual !== entry.index) {
      mismatches.push(`${version}: ${actual === undefined ? '태그 없음' : `기록 ${short(entry.index)} ≠ 레지스트리 ${short(actual)}`}`);
    }
  }
  if (mismatches.length > 0) {
    throw new TagMismatch(mismatches.join(', '));
  }
}

export async function runMirrorJob(deps: MirrorJobDeps): Promise<MirrorOutcome> {
  const before = deps.readStatus();
  // 강제 종료돼도 실패로 남도록 먼저 올려 둔다(번역 묶기와 같은 방식)
  const failing: MirrorStatus = { ...before, failures: before.failures + 1 };
  deps.writeStatus(failing);
  const succeed = (outcome: MirrorOutcome): MirrorOutcome => {
    deps.writeStatus({ failures: 0, lastSuccess: deps.now().toISOString() });

    return outcome;
  };
  try {
    await deps.sync();
    const published = deps.siteReady() ? deps.published() : undefined;
    if (published === undefined || latestPublished(published) === undefined) {
      deps.log('미러: 첫 발행 전이라 건너뜁니다.');

      return succeed('skipped');
    }
    await checkTags(published, deps.registry);
    const cdn = await deps.cdn();
    const attempt = async (): Promise<'unchanged' | 'pushed' | 'rejected'> => {
      const result = deps.refresh({ cdn, published, now: deps.now() });
      if (result.issues.length > 0) {
        throw new Error(result.issues.join(' / '));
      }

      return result.changed ? deps.push() : 'unchanged';
    };
    let result = await attempt();
    if (result === 'rejected') {
      // 사람이 PC에서 막 발행했다: 받아서 그 위에 다시 만든다
      await deps.sync();
      result = await attempt();
      if (result === 'rejected') {
        throw new Error('미러 push가 두 번 거부됐습니다.');
      }
    }
    if (result === 'unchanged') {
      deps.log('미러: versions.json 그대로');

      return succeed('unchanged');
    }
    // push가 끝났으면 성공이다. 사이트 확인은 알림용이라 실패해도(DNS·시간 초과) 실패로 세지 않는다
    const served = await deps.served().catch((error: unknown) => {
      deps.log(`미러: push했지만 사이트를 확인하지 못했습니다(${(error instanceof Error ? error.message : String(error)).slice(0, 200)}).`);

      return undefined;
    });
    if (served === false) {
      deps.log('미러: push했지만 사이트가 아직 예전 내용을 냅니다(다음 회차에 다시 봅니다).');
    }

    return succeed('pushed');
  } catch (error: unknown) {
    const reason = (error instanceof Error ? error.message : String(error)).slice(0, 200);
    deps.log(`미러 갱신 실패: ${reason}`);
    if (error instanceof TagMismatch) {
      // 공급망 신호라 세 번을 기다리지 않는다. versions.json은 바꾸지 않았다
      if (before.alert !== reason) {
        await deps.notify(`coolify-ko 보안: 발행한 이미지 태그가 발행 기록과 다릅니다. 미러 갱신을 멈췄습니다(사용자 서버는 직전 versions.json을 씁니다). ${reason}`);
      }
      deps.writeStatus({ ...failing, notified: true, alert: reason });

      return 'failed';
    }
    if (failing.failures >= NOTIFY_AFTER && failing.notified !== true) {
      await deps.notify(`coolify-ko 미러 갱신이 ${String(failing.failures)}번 이어서 실패했습니다(사용자 서버는 직전 versions.json을 씁니다): ${reason}`);
      deps.writeStatus({ ...failing, notified: true });
    }

    return 'failed';
  }
}
