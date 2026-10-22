import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadGlossary, parseGlossary, termsIn } from './glossary.ts';

const root = join(import.meta.dirname, '..', '..', '..');

describe('parseGlossary', () => {
  it('accepts terms and brands', () => {
    const glossary = parseGlossary({ terms: [{ en: 'Server', ko: '서버' }], brands: ['Docker'] });

    expect(glossary.terms).toEqual([{ en: 'Server', ko: '서버' }]);
    expect(glossary.brands).toEqual(['Docker']);
  });

  it('rejects duplicates and empty values', () => {
    expect(() => parseGlossary({ terms: [{ en: 'Server', ko: '서버' }, { en: 'server', ko: '서버' }], brands: [] })).toThrow(/중복/);
    expect(() => parseGlossary({ terms: [{ en: 'Server', ko: ' ' }], brands: [] })).toThrow();
    expect(() => parseGlossary({ terms: 'x', brands: [] })).toThrow();
  });
});

describe('termsIn', () => {
  const glossary = parseGlossary({
    terms: [
      { en: 'Environment Variables', ko: '환경 변수' },
      { en: 'Environment', ko: '환경' },
      { en: 'Deploy', ko: '배포', forms: ['deploys', 'deploying', 'deployment', 'deployments'] },
      { en: 'Repository', ko: '저장소', forms: ['repositories'] },
    ],
    brands: ['GitHub'],
  });

  it('matches whole words, plurals and listed forms, longest first', () => {
    expect(termsIn('Edit environment variables of this Environment', glossary).map((t) => t.en)).toEqual(['Environment Variables', 'Environment']);
    expect(termsIn('Deployments and repositories', glossary).map((t) => t.en)).toEqual(['Deploy', 'Repository']);
    expect(termsIn('Redeploy the environmental thing', glossary)).toEqual([]);
  });
});

describe('i18n/glossary.ko.json', () => {
  it('loads and covers every brand in the codemod rules', () => {
    const glossary = loadGlossary(join(root, 'i18n', 'glossary.ko.json'));
    const rules = readFileSync(join(root, 'codemod', 'rules', 'coolify.php'), 'utf8');
    const block = /'brands'\s*=>\s*\[([\s\S]*?)\],/.exec(rules)?.[1] ?? '';
    const brands = [...block.matchAll(/'((?:[^'\\]|\\.)*)'|"([^"]*)"/g)].map((m) => (m[1] ?? m[2] ?? '').replace(/\\'/g, "'"));

    expect(brands.length).toBeGreaterThan(50);
    expect(glossary.brands).toEqual(expect.arrayContaining(brands));
    expect(glossary.terms.find((t) => t.en === 'Repository')?.ko).toBe('저장소');
    expect(glossary.terms.find((t) => t.en === 'Destination')?.ko).toBe('배포 대상');
    expect(glossary.terms.find((t) => t.en === 'Health check')?.ko).toBe('헬스 체크');
    expect(glossary.terms.find((t) => t.en === 'Private Key')?.ko).toBe('프라이빗 키');
  });
});
