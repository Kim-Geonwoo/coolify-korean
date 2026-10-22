import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEBLATE } from '../weblate/config.ts';
import { enabledLanguages, langPaths, loadLanguages, parseLanguages, primaryLanguage } from './languages.ts';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const ko = { code: 'ko', name: '한국어', enabled: true, rules: 'ko' };

describe('parseLanguages', () => {
  it('reads the language list', () => {
    expect(parseLanguages({ languages: [ko] })).toEqual([ko]);
  });

  it.each([
    ['source language', { languages: [{ ...ko, code: 'en' }] }, 'code'],
    ['path-like code', { languages: [{ ...ko, code: '../x' }] }, 'code'],
    ['duplicate code', { languages: [ko, ko] }, 'code'],
    ['nothing enabled', { languages: [{ ...ko, enabled: false }] }, 'enabled'],
    ['unknown rules', { languages: [{ ...ko, rules: 'ja' }] }, 'rules'],
    ['empty name', { languages: [{ ...ko, name: '' }] }, 'name'],
    ['not a list', { languages: {} }, 'languages'],
  ])('rejects %s', (_label, data, field) => {
    expect(() => parseLanguages(data)).toThrow(field);
  });
});

describe('langPaths', () => {
  it('derives every per-language file from the code', () => {
    expect(langPaths('ja')).toEqual({
      drafts: 'i18n/drafts/ja.json',
      draftsMeta: 'i18n/drafts/ja.meta.json',
      reviewed: 'i18n/reviewed/ja.json',
      reviewedMeta: 'i18n/reviewed/ja.meta.json',
      pending: 'i18n/pending/ja.json',
      glossary: 'i18n/glossary.ja.json',
    });
  });

  it('refuses a code that is not a language tag', () => {
    expect(() => langPaths('ko/../x')).toThrow();
  });
});

describe('repository languages', () => {
  it('enables Korean only at this stage', () => {
    expect(enabledLanguages(loadLanguages(root)).map((language) => language.code)).toEqual(['ko']);
    expect(primaryLanguage(root).code).toBe('ko');
  });

  it('feeds the Weblate translation language', () => {
    expect(WEBLATE.lang).toBe(primaryLanguage(root).code);
  });

  // 언어별 파일 이름은 langPaths만 안다(PaaS 호스트 계약인 전달 폴더 ko.json과 3단계 PoC 기록은 예외)
  it('keeps hard-coded Korean file names out of pipeline code', () => {
    const allowed = new Set(['pipeline/src/i18n/languages.ts', 'pipeline/src/release/handoff.ts', 'pipeline/src/weblate/poc.ts']);
    const pattern = /\bko(?:\.meta)?\.json\b|glossary\.ko\.json|lang:\s*'ko'/;
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        const name = relative(root, path).split('\\').join('/');
        if (entry.isDirectory()) {
          walk(path);
        } else if (name.endsWith('.ts') && !name.endsWith('.test.ts') && !allowed.has(name)) {
          readFileSync(path, 'utf8')
            .split('\n')
            .forEach((line, index) => {
              const code = line.trim();
              if (!code.startsWith('*') && !code.startsWith('/*') && !code.startsWith('//') && pattern.test(line)) {
                offenders.push(`${name}:${String(index + 1)}`);
              }
            });
        }
      }
    };
    walk(join(root, 'pipeline', 'src'));
    expect(offenders).toEqual([]);
  });
});
