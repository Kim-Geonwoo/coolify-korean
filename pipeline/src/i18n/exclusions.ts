import { readFileSync } from 'node:fs';

/**
 * 번역하지 않고 영어 그대로 두는 키(`i18n/exclude.json`): 입력란 예시 값, 키 이름, 상태 표기처럼
 * 기계 번역에 보내면 낱말로 바뀌어 버리는 것. 키마다 이유를 단다.
 */
export function parseExclusions(data: unknown): Map<string, string> {
  const keys: unknown = (data as { keys?: unknown } | null)?.keys;
  if (typeof keys !== 'object' || keys === null || Array.isArray(keys)) {
    throw new Error('exclude.json은 { keys: { 키: 이유 } } 형식이어야 합니다.');
  }
  const out = new Map<string, string>();
  for (const [key, reason] of Object.entries(keys)) {
    if (typeof reason !== 'string' || reason.trim() === '') {
      throw new Error(`exclude.json의 ${key}에 이유가 없습니다.`);
    }
    out.set(key, reason);
  }

  return out;
}

export function loadExclusions(path: string): Map<string, string> {
  return parseExclusions(JSON.parse(readFileSync(path, 'utf8')) as unknown);
}
