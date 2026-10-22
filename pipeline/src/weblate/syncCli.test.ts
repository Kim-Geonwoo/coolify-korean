import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJson, sourceHash } from '../i18n/integrity.ts';
import { previousReviewed, reviewedShrinksTooMuch, weblateSync } from './syncCli.ts';

interface ServerUnit {
  id: number;
  context: string;
  source: string;
  target: string;
  state: number;
  extra_flags?: string;
  explanation?: string;
}

interface Upload {
  readonly component: string;
  readonly lang: string;
  readonly method: string;
  readonly auth: string;
  readonly json: Record<string, string>;
}

/** 단위 목록과 파일 올리기만 아는 가짜 Weblate(로컬 HTTP). 올린 초안(fuzzy)은 단위에 반영한다 */
async function fakeWeblate(units: Record<string, ServerUnit[]>, options: { readonly patchStatus?: number } = {}): Promise<{ url: string; uploads: Upload[]; patches: { id: number; body: Record<string, unknown> }[]; server: Server }> {
  const uploads: Upload[] = [];
  const patches: { id: number; body: Record<string, unknown> }[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const url = new URL(req.url ?? '/', 'http://fake');
        const [, , kind, project, component = '', lang = '', tail] = url.pathname.split('/');
        const send = (status: number, body: unknown): void => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.method === 'PATCH' && kind === 'units') {
          const id = Number(project);
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
          patches.push({ id, body });
          const unit = Object.values(units).flat().find((u) => u.id === id);
          if (options.patchStatus === undefined && unit !== undefined && typeof body['explanation'] === 'string') {
            unit.explanation = body['explanation'];
          }
          send(options.patchStatus ?? (unit === undefined ? 404 : 200), {});
          return;
        }
        if (kind !== 'translations' || project !== 'coolify-ko') {
          send(404, { detail: 'Not found.' });
          return;
        }
        const list = units[`${component}/${lang}`];
        if (req.method === 'GET' && tail === 'units' && list !== undefined) {
          send(200, { next: null, results: list.map((u) => ({ id: u.id, context: [u.context][0], source: [u.source], target: [u.target], state: u.state, ...(u.extra_flags === undefined ? {} : { extra_flags: u.extra_flags }), ...(u.explanation === undefined ? {} : { explanation: u.explanation }) })) });
          return;
        }
        if (req.method === 'POST' && tail === 'file') {
          const form = await new Request('http://fake/', { method: 'POST', headers: { 'content-type': req.headers['content-type'] ?? '' }, body: Buffer.concat(chunks) }).formData();
          const file = form.get('file');
          const json = JSON.parse(file instanceof Blob ? await file.text() : '{}') as Record<string, string>;
          const methodField = form.get('method');
          const method = typeof methodField === 'string' ? methodField : '';
          uploads.push({ component, lang, method, auth: req.headers.authorization ?? '', json });
          if (method === 'fuzzy') {
            for (const unit of list ?? []) {
              const value = json[unit.context];
              if (value !== undefined) {
                unit.target = value;
                unit.state = 10;
              }
            }
          }
          send(200, { accepted: Object.keys(json).length, skipped: 0, not_found: 0, total: Object.keys(json).length, result: true });
          return;
        }
        send(404, { detail: 'Not found.' });
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  return { url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`, uploads, patches, server };
}

const dotKey = '. Email is managed by your SSO provider.';
const catalog = {
  version: '4.4.6',
  keys: {
    Save: { english: 'Save', kinds: ['text'], placeholders: [], occurrences: [{ file: 'resources/views/components/forms/button.blade.php', line: 12, kind: 'text' }] },
    Cancel: { english: 'Cancel', kinds: ['text'], placeholders: [] },
    'Delete :name?': { english: 'Delete :name?', kinds: ['text'], placeholders: ['name'] },
    'Remove :count items': { english: 'Remove :count items', kinds: ['text'], placeholders: ['count'] },
    nginx: { english: 'nginx', kinds: ['prop-text'], placeholders: [] },
    [dotKey]: { english: dotKey, kinds: ['text'], placeholders: [] },
  },
};

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'weblate-sync-'));
  const write = (path: string, value: unknown): void => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  };
  write('i18n/state.json', { upstream: { version: '4.4.6', image: 'ghcr.io/coollabsio/coolify', digest: `sha256:${'0'.repeat(64)}` } });
  write('i18n/catalog.json', catalog);
  write('i18n/en.json', Object.fromEntries(Object.entries(catalog.keys).map(([key, entry]) => [key, entry.english])));
  write('i18n/exclude.json', { keys: { nginx: '예시 값' } });
  write('i18n/glossary.ko.json', { terms: [{ en: 'Server', ko: '서버' }], brands: ['Coolify'] });
  write('i18n/drafts/ko.json', { Cancel: '취소', 'Delete :name?': ':name을(를) 삭제하시겠습니까?', Save: '저장' });
  write('i18n/drafts/ko.meta.json', {
    Cancel: { run: 'r1', sourceHash: sourceHash('Cancel'), via: 'engine', review: { verdict: 'minor', reason: '버튼', fix: '취소하기', run: 'f1' } },
    'Delete :name?': { run: 'r1', sourceHash: sourceHash('Delete :name?'), via: 'engine' },
    Save: { run: 'r1', sourceHash: sourceHash('Save'), via: 'engine' },
  });
  write('i18n/drafts/runs.json', { r1: { engine: 'index', prompt: 'p', glossary: 'g' } });
  write('tokens/weblate-bridge.token', 'wlu_bridge\n');
  write('tokens/weblate-flash.token', 'wlu_flash\n');

  return root;
}

const servers: Server[] = [];
const roots: string[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('weblateSync', () => {
  it('uploads source, untouched drafts and Flash fixes, brings back approved strings and the glossary, and does nothing new on a second run', async () => {
    const root = fixtureRoot();
    roots.push(root);
    const { url, uploads, patches, server } = await fakeWeblate({
      'dashboard/en': ['Save', 'Cancel', 'Delete :name?', 'Remove :count items', 'nginx'].map((key, i) => ({ id: 101 + i, context: key, source: key, target: key, state: 100 })),
      'dashboard/ko': [
        { id: 1, context: 'Save', source: 'Save', target: '', state: 0 },
        { id: 2, context: 'Cancel', source: 'Cancel', target: '', state: 0 },
        { id: 3, context: 'Delete :name?', source: 'Delete :name?', target: ':name을(를) 삭제할까요?', state: 30 },
        { id: 4, context: 'Remove :count items', source: 'Remove :count items', target: '항목 삭제', state: 30 },
        { id: 5, context: 'nginx', source: 'nginx', target: '', state: 100 },
      ],
      'glossary/ko': [
        { id: 10, context: '', source: 'Server', target: '서버(검수)', state: 30 },
        { id: 11, context: '', source: 'Coolify', target: 'Coolify', state: 20, extra_flags: 'read-only' },
        { id: 12, context: '', source: 'Proxy', target: '프록시', state: 30 },
      ],
    });
    servers.push(server);
    const options = { root, baseUrl: url, tokenDir: join(root, 'tokens'), cacheDir: join(root, 'cache') };

    const first = await weblateSync(options);
    expect({ ...first, rejected: first.rejected.map((r) => r.key) }).toEqual({ sourceUploaded: true, draftsUploaded: 2, suggestionsUploaded: 1, reviewed: 1, pending: 0, rejected: ['Remove :count items'], glossaryChanged: true, changed: true, explanations: 5, skippedKeys: [dotKey] });
    expect(uploads.map((u) => [u.lang, u.method, u.auth, Object.keys(u.json).sort()])).toEqual([
      ['en', 'replace', 'Token wlu_bridge', ['Cancel', 'Delete :name?', 'Remove :count items', 'Save', 'nginx']],
      ['ko', 'fuzzy', 'Token wlu_bridge', ['Cancel', 'Save']],
      ['ko', 'suggest', 'Token wlu_flash', ['Cancel']],
    ]);
    expect(uploads[2]?.json).toEqual({ Cancel: '취소하기' });
    // 원문 단위 설명란: 쓰인 곳(업스트림 링크)·종류·번역 제외 이유
    expect(patches.find((p) => p.id === 101)?.body['explanation']).toContain('(https://github.com/coollabsio/coolify/blob/v4.4.6/resources/views/components/forms/button.blade.php#L12)');
    expect(patches.find((p) => p.id === 105)?.body['explanation']).toContain('**번역 제외**: 예시 값');
    expect(readFileSync(join(root, 'i18n/reviewed/ko.json'), 'utf8')).toBe(canonicalJson({ 'Delete :name?': ':name을(를) 삭제할까요?' }));
    expect(readFileSync(join(root, 'i18n/reviewed/ko.meta.json'), 'utf8')).toBe(canonicalJson({ 'Delete :name?': { sourceHash: sourceHash('Delete :name?') } }));
    expect(existsSync(join(root, 'i18n/pending/ko.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, 'i18n/glossary.ko.json'), 'utf8'))).toEqual({ terms: [{ en: 'Server', ko: '서버(검수)' }, { en: 'Proxy', ko: '프록시' }], brands: ['Coolify'] });

    uploads.length = 0;
    const second = await weblateSync(options);
    expect({ ...second, rejected: second.rejected.map((r) => r.key) }).toEqual({ sourceUploaded: false, draftsUploaded: 0, suggestionsUploaded: 0, reviewed: 1, pending: 0, rejected: ['Remove :count items'], glossaryChanged: false, changed: false, explanations: 0, skippedKeys: [dotKey] });
    expect(uploads).toEqual([]);
  });

  it('keeps going when Weblate refuses explanation changes, and says so in the report', async () => {
    const root = fixtureRoot();
    roots.push(root);
    const { url, server } = await fakeWeblate(
      { 'dashboard/en': [{ id: 101, context: 'Save', source: 'Save', target: 'Save', state: 100 }], 'dashboard/ko': [{ id: 3, context: 'Delete :name?', source: 'Delete :name?', target: ':name을(를) 삭제할까요?', state: 30 }], 'glossary/ko': [] },
      { patchStatus: 403 },
    );
    servers.push(server);

    const report = await weblateSync({ root, baseUrl: url, tokenDir: join(root, 'tokens'), cacheDir: join(root, 'cache') });
    expect(report.explanations).toBe(0);
    expect(report.explanationsError).toContain('403');
    expect(report.reviewed).toBe(1);
  });

  it('refuses to replace the Weblate source with an older version (it would delete newer strings and their human translations)', async () => {
    const root = fixtureRoot();
    roots.push(root);
    const { url, uploads, server } = await fakeWeblate({ 'dashboard/ko': [{ id: 1, context: 'Save', source: 'Save', target: '', state: 0 }], 'glossary/ko': [] });
    servers.push(server);
    const options = { root, baseUrl: url, tokenDir: join(root, 'tokens'), cacheDir: join(root, 'cache') };
    await weblateSync(options);

    // 옛 버전 브랜치(리허설·수동 실행)의 원문
    const older = { ...catalog, version: '4.4.5', keys: { Save: catalog.keys.Save } };
    writeFileSync(join(root, 'i18n/catalog.json'), JSON.stringify(older));
    writeFileSync(join(root, 'i18n/en.json'), JSON.stringify({ Save: 'Save' }));
    writeFileSync(join(root, 'i18n/state.json'), JSON.stringify({ upstream: { version: '4.4.5', image: 'ghcr.io/coollabsio/coolify', digest: `sha256:${'0'.repeat(64)}` } }));
    uploads.length = 0;

    await expect(weblateSync(options)).rejects.toThrow('4.4.5');
    expect(uploads).toEqual([]);
  });
});

describe('previousReviewed', () => {
  it('also reads the reviewed files of the last commit, so an approval pruned tonight still counts as the old one', () => {
    const root = mkdtempSync(join(tmpdir(), 'weblate-prev-'));
    roots.push(root);
    const git = (...args: string[]): void => {
      const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: root, windowsHide: true });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} 실패`);
      }
    };
    mkdirSync(join(root, 'i18n', 'reviewed'), { recursive: true });
    writeFileSync(join(root, 'i18n/reviewed/ko.json'), canonicalJson({ 'auth.throttle': '시도가 너무 많습니다.', Save: '저장' }));
    writeFileSync(join(root, 'i18n/reviewed/ko.meta.json'), canonicalJson({ 'auth.throttle': { sourceHash: 'old' }, Save: { sourceHash: 'h' } }));
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    // 오늘 밤 정리 단계가 낡은 승인을 작업 파일에서 뺐다
    writeFileSync(join(root, 'i18n/reviewed/ko.json'), canonicalJson({ Save: '저장' }));
    writeFileSync(join(root, 'i18n/reviewed/ko.meta.json'), canonicalJson({ Save: { sourceHash: 'h' } }));

    expect(previousReviewed(root)).toEqual({ reviewed: { 'auth.throttle': '시도가 너무 많습니다.', Save: '저장' }, meta: { 'auth.throttle': { sourceHash: 'old' }, Save: { sourceHash: 'h' } } });
  });

  it('falls back to the working files outside a git checkout', () => {
    const root = fixtureRoot();
    roots.push(root);

    expect(previousReviewed(root)).toEqual({ reviewed: {}, meta: {} });
  });
});

describe('reviewedShrinksTooMuch', () => {
  it('stops when approved strings suddenly drop a lot (a recreated component or an old backup), not on small changes', () => {
    expect(reviewedShrinksTooMuch(30, 0)).toBe(true);
    expect(reviewedShrinksTooMuch(30, 23)).toBe(true);
    expect(reviewedShrinksTooMuch(30, 24)).toBe(false);
    expect(reviewedShrinksTooMuch(5, 0)).toBe(false);
    expect(reviewedShrinksTooMuch(30, 40)).toBe(false);
  });
});
