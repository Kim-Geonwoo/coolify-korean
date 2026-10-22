import { describe, expect, it } from 'vitest';
import type { Glossary } from '../translate/glossary.ts';
import type { WeblateClient } from './client.ts';
import { WEBLATE } from './config.ts';
import { setupWeblate } from './setup.ts';

interface FakeUnit {
  id: number;
  key: string;
  source: string;
  target: string;
  state: number;
  extraFlags: string;
}

/** 메모리 안의 Weblate(프로젝트 하나). 쓰기 호출만 writes에 남긴다 */
function fakeWeblate(options: { project?: Record<string, unknown> | null; glossaryKo?: readonly { source: string; target: string; extraFlags?: string }[]; dashboardFlags?: string } = {}): { client: WeblateClient; writes: string[] } {
  const writes: string[] = [];
  let nextId = 1;
  const project = options.project === undefined ? { slug: 'coolify-ko', translation_review: true, enforced_2fa: false } : options.project;
  const components = new Map<string, Map<string, FakeUnit[]>>([['glossary', new Map([['en', []]])]]);
  const componentFlags = new Map<string, string>();
  if (options.dashboardFlags !== undefined) {
    components.set('dashboard', new Map([['en', []], ['ko', []]]));
    componentFlags.set('dashboard', options.dashboardFlags);
  }
  const unit = (key: string, source: string, target: string, state: number, extraFlags = ''): FakeUnit => ({ id: nextId++, key, source, target, state, extraFlags });
  if (options.glossaryKo !== undefined) {
    components.get('glossary')?.set(
      'ko',
      options.glossaryKo.map((t) => unit('', t.source, t.target, 20, t.extraFlags)),
    );
  }
  const all = (): FakeUnit[] => [...components.values()].flatMap((langs) => [...langs.values()].flat());
  const unused = (): Promise<never> => Promise.reject(new Error('setup이 쓰지 않는 호출'));
  const client: WeblateClient = {
    units: (_project, component, lang) => Promise.resolve((components.get(component)?.get(lang) ?? []).map((u) => ({ ...u }))),
    createComponent: (_project, spec) => {
      writes.push(`createComponent ${spec.slug} ${spec.checkFlags ?? ''} ${JSON.stringify(spec.enforcedChecks ?? [])} ${JSON.stringify(Object.keys(spec.sourceJson))}`);
      components.set(spec.slug, new Map([['en', Object.entries(spec.sourceJson).map(([key, value]) => unit(key, value, value, 30))]]));
      componentFlags.set(spec.slug, spec.checkFlags ?? '');

      return Promise.resolve();
    },
    addTranslation: (_project, component, lang) => {
      writes.push(`addTranslation ${component} ${lang}`);
      const langs = components.get(component);
      langs?.set(lang, (langs.get('en') ?? []).map((u) => unit(u.key, u.source, '', 0)));

      return Promise.resolve();
    },
    patchUnit: (id, fields) => {
      const target = all().find((u) => u.id === id);
      writes.push(`patchUnit ${target?.source ?? String(id)} ${JSON.stringify(fields)}`);
      if (target !== undefined && typeof fields['extra_flags'] === 'string') {
        target.extraFlags = fields['extra_flags'];
        // 원문 단위의 읽기 전용은 번역 단위를 읽기 전용(100)으로 만든다
        for (const translated of components.get('dashboard')?.get('ko') ?? []) {
          if (translated.key === target.key && fields['extra_flags'].includes('read-only')) {
            translated.state = 100;
          }
        }
      }

      return Promise.resolve();
    },
    patchProject: (slug, fields) => {
      writes.push(`patchProject ${slug} ${JSON.stringify(fields)}`);
      if (project !== null) {
        Object.assign(project, fields);
      }

      return Promise.resolve();
    },
    patchComponent: (_project, component, fields) => {
      writes.push(`patchComponent ${component} ${JSON.stringify(fields)}`);
      if (typeof fields['check_flags'] === 'string') {
        componentFlags.set(component, fields['check_flags']);
      }

      return Promise.resolve();
    },
    raw: (method, path, json) => {
      const body = json as { language_code?: string; source?: string[]; target?: string[] } | undefined;
      const [, , kind, , component, lang] = path.split('/');
      if (method === 'GET' && path === `/api/projects/${WEBLATE.project}/`) {
        return Promise.resolve(project === null ? { status: 404, data: { detail: 'Not found.' } } : { status: 200, data: { ...project } });
      }
      if (method === 'GET' && kind === 'components') {
        return Promise.resolve({ status: components.has(component ?? '') ? 200 : 404, data: { check_flags: componentFlags.get(component ?? '') ?? '' } });
      }
      if (method === 'GET' && kind === 'translations') {
        const units = components.get(component ?? '')?.get(lang ?? '');

        return Promise.resolve(units === undefined ? { status: 404, data: {} } : { status: 200, data: { total: units.length } });
      }
      if (method === 'POST' && path === `/api/components/${WEBLATE.project}/${WEBLATE.glossary}/translations/`) {
        writes.push(`addGlossaryTranslation ${body?.language_code ?? ''}`);
        components.get('glossary')?.set(body?.language_code ?? '', []);

        return Promise.resolve({ status: 201, data: {} });
      }
      if (method === 'POST' && path === `/api/translations/${WEBLATE.project}/${WEBLATE.glossary}/${WEBLATE.lang}/units/`) {
        const added = unit('', body?.source?.[0] ?? '', body?.target?.[0] ?? '', 20);
        writes.push(`addTerm ${added.source} ${added.target}`);
        components.get('glossary')?.get(WEBLATE.lang)?.push(added);

        return Promise.resolve({ status: 200, data: { id: added.id } });
      }

      return Promise.resolve({ status: 404, data: {} });
    },
    uploadFile: unused,
    downloadFile: unused,
    screenshots: unused,
    createScreenshot: unused,
    replaceScreenshotImage: unused,
    linkScreenshot: unused,
    unlinkScreenshot: unused,
  };

  return { client, writes };
}

const en = { Save: 'Save', localhost: 'localhost', '. Email is managed by your SSO provider.': '. Email is managed by your SSO provider.' };
const exclusions = new Map([
  ['localhost', '예시 값'],
  ['gone', '카탈로그에서 사라진 키'],
]);
const glossary: Glossary = { terms: [{ en: 'Server', ko: '서버' }], brands: ['Coolify'] };

describe('WEBLATE.flags', () => {
  it('does not use \\w in the placeholder rule: Weblate runs it in Python, where \\w also matches Hangul and would hide a placeholder right after Korean text', () => {
    expect(WEBLATE.flags).not.toContain(String.raw`\w`);
    expect(WEBLATE.flags).toContain('(?<![A-Za-z0-9_/])');
  });
});

describe('setupWeblate', () => {
  it('creates what is missing, marks excluded keys read-only, seeds the glossary, and changes nothing on a second run', async () => {
    const { client, writes } = fakeWeblate();

    const first = await setupWeblate(client, { en, exclusions, glossary });
    expect(writes).toEqual([
      'patchProject coolify-ko {"enforced_2fa":true}',
      `createComponent dashboard ${WEBLATE.flags} ["placeholders"] ["Save","localhost"]`,
      'addTranslation dashboard ko',
      'patchUnit localhost {"extra_flags":"read-only"}',
      'addGlossaryTranslation ko',
      'addTerm Server 서버',
      'addTerm Coolify Coolify',
      'patchUnit Coolify {"extra_flags":"read-only"}',
    ]);
    expect(first).toEqual({ created: ['component', 'translation', 'glossary-translation'], project: ['enforced_2fa'], component: [], readOnly: 1, terms: 2, skipped: ['. Email is managed by your SSO provider.'] });

    writes.length = 0;
    const second = await setupWeblate(client, { en, exclusions, glossary });
    expect(writes).toEqual([]);
    expect(second).toEqual({ created: [], project: [], component: [], readOnly: 0, terms: 0, skipped: ['. Email is managed by your SSO provider.'] });
  });

  it('keeps glossary terms that already exist, even when a person changed them in Weblate', async () => {
    const { client, writes } = fakeWeblate({ glossaryKo: [{ source: 'Server', target: '서버(검수함)' }, { source: 'Coolify', target: 'Coolify', extraFlags: 'read-only' }] });

    const report = await setupWeblate(client, { en, exclusions, glossary });
    expect(writes.filter((w) => w.startsWith('addTerm') || w.startsWith('addGlossary') || w.includes('Coolify'))).toEqual([]);
    expect(report.terms).toBe(0);
  });

  it('brings the check flags of an already created component up to date, once', async () => {
    const { client, writes } = fakeWeblate({ dashboardFlags: 'placeholders:r"old"' });

    await setupWeblate(client, { en, exclusions, glossary });
    expect(writes.filter((w) => w.startsWith('patchComponent'))).toEqual([`patchComponent dashboard ${JSON.stringify({ check_flags: WEBLATE.flags })}`]);
    writes.length = 0;
    await setupWeblate(client, { en, exclusions, glossary });
    expect(writes.filter((w) => w.startsWith('patchComponent'))).toEqual([]);
  });

  it('stops before changing anything when the project does not exist yet', async () => {
    const { client, writes } = fakeWeblate({ project: null });

    await expect(setupWeblate(client, { en, exclusions, glossary })).rejects.toThrow('Weblate 프로젝트 coolify-ko가 없습니다');
    expect(writes).toEqual([]);
  });
});
