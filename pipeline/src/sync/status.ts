/** 서버 캐시의 `status.json`: 마지막 성공, 단계별 연속 실패, 꺼 둔 단계 */
export interface JobStatus {
  readonly lastSuccess?: string;
  readonly failures: Readonly<Record<string, { readonly code: string; readonly count: number; readonly since: string }>>;
  /** 같은 실패가 연속 3번이면 끈다. 사람이 status.json에서 지워야 다시 돈다 */
  readonly disabled: readonly string[];
  /** 마지막으로 알린 "승인됐지만 검사에 걸려 뺀" 키(같은 묶음을 매일 다시 알리지 않게) */
  readonly rejected?: readonly string[];
  /** 지금 상류 안정판과 그것을 처음 본 시각(공개판 통과 태그의 지연 상한 기준, 5단계) */
  readonly upstreamSeen?: { readonly version: string; readonly at: string };
  /** 상류 설치 후크의 마지막 지문과 문제(같은 문제를 매일 다시 알리지 않게) */
  readonly hooks?: { readonly fingerprint: string; readonly issues: readonly string[] };
  /** 마지막으로 알린 공개판 후보(종류:버전) */
  readonly candidate?: string;
}

const DISABLE_AFTER = 3;
const MESSAGE_LIMIT = 300;

export function emptyStatus(): JobStatus {
  return { failures: {}, disabled: [] };
}

export function recordFailure(status: JobStatus, stage: string, code: string, at: string): JobStatus {
  const previous = status.failures[stage];
  const count = previous?.code === code ? previous.count + 1 : 1;
  const since = previous?.code === code ? previous.since : at;
  const disabled = count >= DISABLE_AFTER && !status.disabled.includes(stage) ? [...status.disabled, stage] : status.disabled;

  return { ...status, failures: { ...status.failures, [stage]: { code, count, since } }, disabled };
}

export function recordSuccess(status: JobStatus, stage: string, at: string): JobStatus {
  const failures = Object.fromEntries(Object.entries(status.failures).filter(([name]) => name !== stage));

  return { ...status, failures, lastSuccess: at };
}

export type JobEvent =
  | { readonly type: 'version'; readonly version: string; readonly added: number; readonly changed: number; readonly removed: number; readonly drafted: number; readonly fallbacks: number; readonly normalized: number; readonly pending: number; readonly compare: string }
  | { readonly type: 'failure'; readonly stage: string; readonly code: string; readonly count: number; readonly disabled: boolean }
  | { readonly type: 'stop'; readonly reason: string; readonly detail: string }
  | { readonly type: 'rejected'; readonly keys: readonly string[] }
  | { readonly type: 'hooks'; readonly issues: readonly string[] }
  | { readonly type: 'hooks-changed' }
  | { readonly type: 'candidate'; readonly kind: 'ko' | 'passthrough'; readonly version: string };

/** Discord 알림 문구. 명령 인자·로그 원문은 넣지 않고, 길이도 자른다 */
export function discordMessage(event: JobEvent): string {
  let text: string;
  switch (event.type) {
    case 'version':
      text = `coolify-ko ${event.version} 처리: 새 키 ${String(event.added)} · 바뀐 키 ${String(event.changed)} · 없어진 키 ${String(event.removed)} · 초안 ${String(event.drafted)}(폴백 ${String(event.fallbacks)}, 정규화 ${String(event.normalized)})${event.pending > 0 ? ` · 남은 키 ${String(event.pending)}(다음 밤에 이어서)` : ''}\n받을 결과: ${event.compare}`;
      break;
    case 'failure':
      text = `coolify-ko 밤 작업 실패: ${event.stage} (${event.code}), ${String(event.count)}번째.${event.disabled ? ' 이 단계를 껐습니다. 확인이 필요합니다.' : ''}`;
      break;
    case 'stop':
      text = `coolify-ko 업스트림 이상: ${event.reason} (${event.detail}). 사람이 확인할 때까지 처리하지 않습니다.`;
      break;
    case 'rejected':
      text = `coolify-ko 승인됐지만 검사에 걸려 뺀 번역 ${String(event.keys.length)}개: ${event.keys.slice(0, 3).join(' · ')}${event.keys.length > 3 ? ' …' : ''}`;
      break;
    case 'hooks':
      text = `coolify-ko 상류 설치 후크가 바뀌어 공개판 후보를 멈췄습니다(PaaS 업데이트도 확인 필요): ${event.issues.slice(0, 3).join(' · ')}`;
      break;
    case 'hooks-changed':
      text = 'coolify-ko 상류 설치 후크 줄이 바뀌었습니다(검사는 통과). upgrade.sh·compose 변경을 확인해 주세요.';
      break;
    case 'candidate':
      text = `coolify-ko 공개판 후보: ${event.version} (${event.kind === 'ko' ? '한국어판' : '통과 태그(공식 이미지 그대로)'}). PC에서 확인: node pipeline/src/cli.ts publish plan`;
      break;
  }

  return text.length <= MESSAGE_LIMIT ? text : `${text.slice(0, MESSAGE_LIMIT - 1)}…`;
}
