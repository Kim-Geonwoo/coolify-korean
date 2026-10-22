import type { WeblateUnit } from './client.ts';

const STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'empty',
  10: 'needs-editing',
  11: 'needs-rewriting',
  12: 'needs-checking',
  20: 'translated',
  30: 'approved',
  100: 'read-only',
};

/** 상태별 단위 수(첫 적재 보고용) */
export function stateCounts(units: readonly WeblateUnit[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const unit of units) {
    const name = STATE_NAMES[unit.state] ?? `state-${String(unit.state)}`;
    out[name] = (out[name] ?? 0) + 1;
  }

  return out;
}

// Weblate 강제 검사(config.ts flags)와 같은 규칙. 이것이 있는 문자열은 깨진 번역을 Weblate가 먼저 막는다(상태 11)
const PLACEHOLDER_OR_TAG = /(?<![\w/]):[A-Za-z_]|<\/?\d+\/?>/;

/**
 * "레포 검사에 걸린 승인" 리허설용: 확인 문구(verbatim)가 든 문자열 하나와, 그 문구를 뺀 번역.
 * Weblate의 강제 검사는 통과하고(자리표시자·태그 없음) 레포의 확인 문구 검사에만 걸린다. 읽기 전용은 고를 수 없다
 */
export function brokenApproval(units: readonly WeblateUnit[], verbatim: readonly string[]): { readonly unit: WeblateUnit; readonly target: string } | undefined {
  const unit = [...units]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .find((u) => u.state !== 100 && !PLACEHOLDER_OR_TAG.test(u.source) && verbatim.some((literal) => u.source.includes(literal)));

  return unit === undefined ? undefined : { unit, target: '확인하려면 아래에 정리 문구를 입력하세요(리허설: 확인 문구를 뺀 번역).' };
}
