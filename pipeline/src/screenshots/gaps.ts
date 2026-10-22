import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

/**
 * 찍기 보조: 화면에 보이지만 키 표식이 없는 영어(오버레이가 감싸지 못한 글) 판별과, 무엇으로 찍었는지 남기는 완료 표시.
 */
const GIT_ID = /^[0-9a-f]{40}$/;

// 같은 버전이라도 이것들이 바뀌면 다시 찍는다: 찍기 코드, 변환기(감싼 글이 늘어남), 오버레이, 카탈로그(새 키)
export const CAPTURE_INPUTS = ['pipeline/src/screenshots', 'codemod', 'overlay', 'i18n/catalog.json'] as const;

/** 찍기 완료 표시: 버전 + 찍기 입력(git 객체 id)의 해시 12자 */
export function screensDoneKey(version: string, objectIds: readonly string[]): string {
  if (!objectIds.every((id) => GIT_ID.test(id))) {
    throw new Error('git 객체 id 형식이 아닙니다.');
  }

  return `${version}+${createHash('sha256').update(objectIds.join('\n')).digest('hex').slice(0, 12)}`;
}

/** 레포 HEAD의 찍기 입력으로 만든 완료 표시(밤 작업이 비교하고 찍기가 끝나면 쓴다) */
export function captureDoneKey(repo: string, version: string): string {
  const ids = CAPTURE_INPUTS.map((path) => {
    const result = spawnSync('git', ['-C', repo, 'rev-parse', `HEAD:${path}`], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(`찍기 입력을 읽지 못했습니다: ${path}`);
    }

    return result.stdout.trim();
  });

  return screensDoneKey(version, ids);
}

// 데이터·식별자로 보이는 글: 주소, 경로, 메일, 버전·숫자, 저장소·이미지 이름, 시험 인스턴스의 예시 리소스
const DATA = [
  /^https?:\/\//,
  /^\//,
  /^[\w.+-]+@[\w-]+\./,
  /^v?\d+(?:[.:]\d+)+/,
  /^[\d\s.,:%+-]+$/,
  /^[\w.-]+\/[\w.-]+$/,
  /^[\w.-]+:[\w.-]+$/,
  /^demo[-\s]/i,
  /^(?:localhost|coolify-ko[\w-]*)$/,
];

/** 오버레이가 감싸지 못한 화면 글로 볼지: 데이터가 아니고, 띄어쓴 영어 문장이거나 대문자로 시작하는 낱말(… 허용) */
export function looksUntranslated(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length < 2 || DATA.some((pattern) => pattern.test(value)) || !/[A-Za-z]{3,}/.test(value)) {
    return false;
  }

  return value.includes(' ') || /^[A-Z][a-z]+(?:\.\.\.|…)?$/.test(value);
}
