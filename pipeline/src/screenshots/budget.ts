const CLEANUP_MS = 5 * 60_000;
const MIN_STEP_MS = 2 * 60_000;

/**
 * 한 단계의 시간 제한: 단계 상한과 "전체 마감 − 정리 5분" 중 작은 쪽. 정리(시험 인스턴스 내리기)할 시간이 늘 남게 해,
 * 바깥(밤 작업)의 시간 초과로 이 프로세스가 끊겨 컨테이너가 남는 일을 막는다(검토 2026-10-18 Important 1)
 */
export function stepTimeout(capMs: number, deadline: number, now: number): number {
  const left = deadline - now - CLEANUP_MS;
  if (left < MIN_STEP_MS) {
    throw new Error('스크린샷에 쓸 시간이 모자라 멈춥니다(정리할 시간을 남긴다).');
  }

  return Math.min(capMs, left);
}
