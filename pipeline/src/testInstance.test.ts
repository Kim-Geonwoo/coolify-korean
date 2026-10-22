import { describe, expect, it } from 'vitest';
import { buildTestEnv, isErrorPage, isInsideTranslation, pseudoTranslations, smokeTotals, summarizeTexts } from './testInstance.ts';

describe('pseudoTranslations', () => {
  it('wraps the English text of every key, keeping placeholders and tags', () => {
    expect(
      pseudoTranslations({ General: 'General', 'auth.login': 'Login', 'Use <0>this</0> :name': 'Use <0>this</0> :name' }),
    ).toEqual({ General: '⟦General⟧', 'auth.login': '⟦Login⟧', 'Use <0>this</0> :name': '⟦Use <0>this</0> :name⟧' });
  });
});

describe('buildTestEnv', () => {
  const fixedBytes = (size: number): Buffer => Buffer.alloc(size, 7);

  it('writes the variables the instance needs and disables background workers', () => {
    const env = buildTestEnv({ port: 18080, email: 'coolify-ko-test@geonwoo.dev', randomBytes: fixedBytes });
    const lines = new Map(env.trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

    expect(lines.get('APP_KEY')).toBe(`base64:${Buffer.alloc(32, 7).toString('base64')}`);
    expect(lines.get('ROOT_USER_EMAIL')).toBe('coolify-ko-test@geonwoo.dev');
    expect(lines.get('SCHEDULER_ENABLED')).toBe('false');
    expect(lines.get('HORIZON_ENABLED')).toBe('false');
    expect(lines.get('APP_PORT')).toBe('18080');
    for (const key of ['DB_USERNAME', 'DB_PASSWORD', 'REDIS_PASSWORD', 'PUSHER_APP_ID', 'PUSHER_APP_KEY', 'PUSHER_APP_SECRET', 'ROOT_USERNAME']) {
      expect(lines.get(key), key).toMatch(/\S/);
    }
  });

  it('creates a root password that satisfies the seeder policy', () => {
    const env = buildTestEnv({ port: 18080, email: 'a@b.dev', randomBytes: fixedBytes });
    const password = /^ROOT_USER_PASSWORD=(.*)$/m.exec(env)?.[1] ?? '';

    expect(password.length).toBeGreaterThanOrEqual(20);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[0-9]/);
    expect(password).toMatch(/[^A-Za-z0-9]/);
    expect(password).not.toMatch(/[\s#"'$`\\=]/);
  });

  it('rejects ports outside the unprivileged range', () => {
    expect(() => buildTestEnv({ port: 80, email: 'a@b.dev', randomBytes: fixedBytes })).toThrow();
  });
});

describe('summarizeTexts', () => {
  it('counts text pieces with letters and how many sit inside translated sentences', () => {
    expect(
      summarizeTexts([
        { text: '⟦General⟧', insideTranslation: true },
        { text: 'Coolify', insideTranslation: false },
        { text: 'GitHub Sponsors', insideTranslation: true },
        { text: '12', insideTranslation: false },
        { text: 'Deploy now', insideTranslation: false },
        { text: '', insideTranslation: false },
        { text: '. Your support helps.⟧', insideTranslation: false },
      ]),
    ).toEqual({ total: 5, translated: 3, untranslated: ['Coolify', 'Deploy now'] });
  });
});

describe('isErrorPage', () => {
  it('counts pages without a response, 5xx and Laravel error screens', () => {
    expect(isErrorPage({ status: 0, title: '', body: '' })).toBe(true);
    expect(isErrorPage({ status: 503, title: 'Coolify', body: '' })).toBe(true);
    expect(isErrorPage({ status: 200, title: 'Whoops!', body: '' })).toBe(true);
    expect(isErrorPage({ status: 200, title: 'Coolify', body: 'Undefined variable $x' })).toBe(true);
  });

  it('accepts normal pages and client errors', () => {
    expect(isErrorPage({ status: 200, title: 'Servers | Coolify', body: 'Servers' })).toBe(false);
    expect(isErrorPage({ status: 404, title: 'Not Found', body: '' })).toBe(false);
  });
});

describe('smokeTotals', () => {
  it('adds up errors, script errors and texts', () => {
    expect(
      smokeTotals([
        { error: false, jsErrors: 0, texts: { total: 10, translated: 4 } },
        { error: true, jsErrors: 2, texts: { total: 5, translated: 5 } },
      ]),
    ).toEqual({ pages: 2, errors: 1, jsErrors: 2, textTotal: 15, textTranslated: 9 });
  });
});

describe('isInsideTranslation', () => {
  it('finds a text piece wrapped by markers at some ancestor level', () => {
    expect(isInsideTranslation([{ lastBefore: '⟦', firstAfter: '⟧' }])).toBe(true);
    expect(isInsideTranslation([{ lastBefore: '', firstAfter: '' }, { lastBefore: '⟦', firstAfter: '⟧' }])).toBe(true);
  });

  it('needs both an opening marker before and a closing marker after', () => {
    expect(isInsideTranslation([{ lastBefore: '⟦', firstAfter: '' }])).toBe(false);
    expect(isInsideTranslation([{ lastBefore: '⟧', firstAfter: '⟧' }])).toBe(false);
    expect(isInsideTranslation([{ lastBefore: '⟦', firstAfter: '⟦' }])).toBe(false);
    expect(isInsideTranslation([])).toBe(false);
  });
});
