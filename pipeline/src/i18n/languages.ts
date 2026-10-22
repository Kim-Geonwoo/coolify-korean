import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 번역 언어 목록(`i18n/languages.json`). 언어별 파일 이름은 여기서만 만든다(5단계 다국어 준비).
 * 이번 단계는 한국어만 켠다: 프롬프트·정규화(합니다체·조사 병기)는 ko 규칙뿐이라, 다른 규칙 이름은 받지 않는다(검토 10)
 */
export interface Language {
  readonly code: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly rules: 'ko';
}

/** 레포 최상위 기준 POSIX 경로 */
export interface LangPaths {
  readonly drafts: string;
  readonly draftsMeta: string;
  readonly reviewed: string;
  readonly reviewedMeta: string;
  readonly pending: string;
  readonly glossary: string;
}

// BCP 47의 언어(+지역·문자) 꼴만. 원문 언어 en은 번역 언어가 아니다
const CODE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;
const RULES: readonly string[] = ['ko'];
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function fail(field: string, detail: string): never {
  throw new Error(`languages.json의 ${field}: ${detail}`);
}

export function parseLanguages(data: unknown): Language[] {
  const list: unknown = (data as { languages?: unknown } | null)?.languages;
  if (!Array.isArray(list)) {
    fail('languages', '목록이 아닙니다.');
  }
  const seen = new Set<string>();
  const languages = list.map((item: unknown, index): Language => {
    const { code, name, enabled, rules } = (item ?? {}) as Record<string, unknown>;
    if (typeof code !== 'string' || !CODE.test(code) || code === 'en' || seen.has(code)) {
      fail('code', `${String(index)}번째 값이 맞지 않습니다(형식, en, 중복).`);
    }
    seen.add(code);
    if (typeof name !== 'string' || name.trim() === '') {
      fail('name', `${code}의 이름이 비었습니다.`);
    }
    if (typeof enabled !== 'boolean') {
      fail('enabled', `${code}의 값이 참·거짓이 아닙니다.`);
    }
    if (typeof rules !== 'string' || !RULES.includes(rules)) {
      fail('rules', `${code}의 규칙(${String(rules)})은 아직 없습니다.`);
    }

    return { code, name, enabled, rules: 'ko' };
  });
  if (!languages.some((language) => language.enabled)) {
    fail('enabled', '켜진 언어가 없습니다.');
  }

  return languages;
}

export function loadLanguages(root: string): Language[] {
  return parseLanguages(JSON.parse(readFileSync(join(root, 'i18n', 'languages.json'), 'utf8')) as unknown);
}

export function enabledLanguages(languages: readonly Language[]): Language[] {
  return languages.filter((language) => language.enabled);
}

/** 이번 단계의 실행은 켜진 언어 하나만 다룬다. 둘 이상이면 언어별로 도는 코드가 생길 때까지 멈춘다 */
export function primaryLanguage(root = REPO_ROOT): Language {
  const enabled = enabledLanguages(loadLanguages(root));
  const [first] = enabled;
  if (first === undefined || enabled.length > 1) {
    throw new Error('언어가 둘 이상인 실행은 아직 지원하지 않습니다.');
  }

  return first;
}

export function langPaths(code: string): LangPaths {
  if (!CODE.test(code)) {
    throw new Error(`언어 코드가 아닙니다: ${code.slice(0, 20)}`);
  }

  return {
    drafts: `i18n/drafts/${code}.json`,
    draftsMeta: `i18n/drafts/${code}.meta.json`,
    reviewed: `i18n/reviewed/${code}.json`,
    reviewedMeta: `i18n/reviewed/${code}.meta.json`,
    pending: `i18n/pending/${code}.json`,
    glossary: `i18n/glossary.${code}.json`,
  };
}
