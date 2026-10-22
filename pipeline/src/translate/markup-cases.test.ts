import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hardIssues } from './validate.ts';

// PHP 헬퍼 시험(codemod/tests/Unit/Overlay/MarkupCasesTest.php)과 같은 사례 파일을 읽는다.
const root = join(import.meta.dirname, '..', '..', '..');
const { cases } = JSON.parse(readFileSync(join(root, 'codemod', 'tests', 'fixtures', 'markup-cases.json'), 'utf8')) as {
  cases: { source: string; translation: string; valid: boolean }[];
};

describe('numbered tag rules shared with the PHP helpers', () => {
  it.each(cases)('$translation → valid=$valid', ({ source, translation, valid }) => {
    expect(hardIssues({ source, kind: 'text', placeholders: [] }, translation).includes('tag-structure')).toBe(!valid);
  });
});
