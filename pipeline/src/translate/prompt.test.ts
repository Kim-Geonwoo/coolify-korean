import { describe, expect, it } from 'vitest';
import { parseGlossary } from './glossary.ts';
import { buildPrompt, parseTranslations, textType, type PromptItem } from './prompt.ts';

const glossary = parseGlossary({ terms: [{ en: 'Container', ko: '컨테이너' }, { en: 'Server', ko: '서버' }], brands: ['Docker'] });
const items: PromptItem[] = [
  { id: 'a1', text: 'Restart the container on {{name}}.', kind: 'toast', file: 'app/Livewire/Server/Show.php' },
  { id: 'b2', text: 'Save', kind: 'text', file: 'resources/views/livewire/server/show.blade.php' },
];

describe('buildPrompt', () => {
  it('generic prompt carries style, token rules, relevant glossary and the items', () => {
    const prompt = buildPrompt('generic', items, glossary);

    expect(prompt.system).toContain('합니다');
    expect(prompt.system).toContain('{{name}}');
    expect(prompt.system).toContain('을(를)');
    expect(prompt.user).toContain('Container → 컨테이너');
    expect(prompt.user).not.toContain('Server → 서버');
    expect(JSON.parse(prompt.user.slice(prompt.user.indexOf('['))) as unknown).toEqual([
      { id: 'a1', kind: 'toast', file: 'app/Livewire/Server/Show.php', text: 'Restart the container on {{name}}.' },
      { id: 'b2', kind: 'text', file: 'resources/views/livewire/server/show.blade.php', text: 'Save' },
    ]);
  });

  it('uses the official Hy-MT2 and Index-Translate formats', () => {
    const hy = buildPrompt('hy-mt2', items, glossary);
    const index = buildPrompt('index', items, glossary);

    expect(hy.system).toBeUndefined();
    expect(hy.user).toContain('Reference the following translations:\nContainer translates to 컨테이너');
    expect(hy.user).toContain('Translate the user-facing text within the following JSON data into Korean.');
    // "end with 합니다"를 글자 그대로 따라 문장 끝에 "합니다."를 덧붙인 일이 있어(100개 중 19개), 끝말을 지시하지 않는다
    expect(hy.user).not.toMatch(/end with/);
    expect(hy.user).toContain('- a1: sentence');
    expect(hy.user).toContain('- b2: short label or button');
    expect(index.system).toBeUndefined();
    expect(index.user).toContain('请将以下英语');
    expect(index.user).toContain('韩语');
    expect(index.user).toContain('Container→컨테이너');
  });
});

describe('buildPrompt glossary selection', () => {
  const registry = parseGlossary({ terms: [{ en: 'Registry', ko: '레지스트리' }], brands: ['GitHub'] });
  const login: PromptItem[] = [{ id: 'r1', text: 'Log in to {{registry}} with {{github_user}}', kind: 'prop-text', file: 'x.blade.php' }];

  it('does not take glossary terms or brands from placeholder names', () => {
    for (const style of ['generic', 'hy-mt2', 'index'] as const) {
      const prompt = buildPrompt(style, login, registry);

      expect(prompt.user).not.toContain('레지스트리');
      expect(prompt.user).not.toMatch(/Keep in English: GitHub|Keep these names in English: GitHub|以下名称保持英文：GitHub/);
    }
  });

  it('treats a key as a sentence when any of its uses is a message', () => {
    const shared: PromptItem[] = [{ id: 'm1', text: 'Backup started', kind: 'prop-literal', kinds: ['prop-literal', 'toast'], file: 'x.php' }];

    expect(buildPrompt('index', shared, glossary).user).toMatch(/句子[^\n]*m1/);
  });

  it('treats long texts without a final period as sentences and leaves middle-length ones to the engine', () => {
    const texts: PromptItem[] = [
      { id: 'l1', text: 'Collapse the sidebar on pages that have a settings menu', kind: 'prop-text', file: 'x.blade.php' },
      { id: 'm1', text: 'Disabling the tunnel can interrupt access', kind: 'prop-text', file: 'x.blade.php' },
      { id: 's1', text: 'DNS entries for {{name}}', kind: 'prop-text', file: 'x.blade.php' },
    ];

    expect(textType(texts[0] as PromptItem)).toBe('sentence');
    expect(textType(texts[1] as PromptItem)).toBe('either');
    expect(textType(texts[2] as PromptItem)).toBe('label');
    const index = buildPrompt('index', texts, glossary, { version: 1 }).user;
    expect(index).toMatch(/名词形式：s1\n/);
    expect(index).toMatch(/句子：l1\n/);
    expect(buildPrompt('hy-mt2', texts, glossary).user).toContain('- m1: label or sentence (decide from the wording)');
  });

  it('tells Index-Translate which items are labels and which are sentences', () => {
    const prompt = buildPrompt('index', items, glossary);

    expect(prompt.user).toMatch(/名词形式[^\n]*b2/);
    expect(prompt.user).toMatch(/句子[^\n]*a1/);
  });
});

describe('prompt v2', () => {
  it('asks for 하세요 requests and declarative descriptions, and v1 stays as measured in 2a', () => {
    for (const style of ['generic', 'hy-mt2', 'index'] as const) {
      const v2 = buildPrompt(style, items, glossary);
      const v1 = buildPrompt(style, items, glossary, { version: 1 });
      const all = (p: { system?: string; user: string }): string => `${p.system ?? ''}\n${p.user}`;

      expect(all(v2), style).toContain('하세요');
      expect(all(v2), style).toContain('하십시오');
      expect(all(v1), style).not.toContain('하십시오');
      expect(all(v2).length, style).toBeGreaterThan(all(v1).length);
    }
  });
});

describe('parseTranslations', () => {
  it('reads plain or fenced JSON and keeps only known ids', () => {
    const text = '```json\n{"translations":[{"id":"a1","ko":"재시작"},{"id":"zz","ko":"x"}]}\n```';

    expect(parseTranslations(text, ['a1', 'b2'])).toEqual(new Map([['a1', '재시작']]));
    expect(parseTranslations('{"a1":"재시작","b2":"저장"}', ['a1', 'b2'])).toEqual(new Map([['a1', '재시작'], ['b2', '저장']]));
  });

  it('finds the JSON object inside surrounding chatter', () => {
    expect(parseTranslations('Here you go:\n{"a1":"재시작 {{name}}"}\nDone.', ['a1'])).toEqual(new Map([['a1', '재시작 {{name}}']]));
  });

  it('rejects text that is not the expected JSON', () => {
    expect(() => parseTranslations('not json', ['a1'])).toThrow();
    expect(() => parseTranslations('{"translations":[{"id":"a1","ko":3}]}', ['a1'])).toThrow();
  });
});
