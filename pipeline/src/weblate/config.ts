import { primaryLanguage } from '../i18n/languages.ts';

/**
 * 운영 Weblate의 이름과 검사 설정. 값은 2026-10-18 PoC(8/8)로 확인했다.
 * - 프로젝트는 ops/weblate/bootstrap.py가 만든다(비공개, 검수 켬). API로 프로젝트를 만들려면 사이트 관리자 권한이 필요하다.
 * - 역할은 Weblate가 프로젝트마다 자동으로 만드는 팀에 대응한다: 검수자 = Translate + Review(승인 가능), 기여자 = Translate(번역·제안, 승인 거부).
 *   사람을 더하는 것은 관리자가 Weblate 화면(프로젝트 → 관리 → 사용자)에서 한다.
 */
export const WEBLATE = {
  project: 'coolify-ko',
  component: 'dashboard',
  glossary: 'glossary',
  // 번역 언어는 i18n/languages.json에서 켜진 하나(5단계 다국어 준비)
  lang: primaryLanguage().code,
  // 레포 hardIssues와 같은 규칙: Laravel 자리표시자(앞이 영숫자·_·슬래시가 아님)와 번호 태그. 강제 검사로 저장을 막는다(상태 11).
  // Weblate는 이 정규식을 Python으로 돌린다. Python의 \w는 한글도 포함해 "총:count개"의 자리표시자를 못 보므로 ASCII로 쓴다
  flags: String.raw`placeholders:r"(?<![A-Za-z0-9_/]):[A-Za-z_][A-Za-z0-9_]*|</?\d+/?>"`,
  enforcedChecks: ['placeholders'],
} as const;

export const ROLES = {
  reviewer: ['Translate', 'Review'],
  contributor: ['Translate'],
} as const;
