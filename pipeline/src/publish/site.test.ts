import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoDictionary, zip } from '../extension/pack.ts';
import type { PublishedLedger } from './ledger.ts';
import { buildSite, CHROME_STORE_URL, CONTACT_EMAIL, DEMO_PHRASES, refreshVersions, SITE_URL, SOURCE_REPO, writeSite, type SiteFiles, type SiteInput } from './site.ts';

const cdn = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures', 'versions.json'), 'utf8')) as Record<string, unknown>;
const published: PublishedLedger = { schema: 1, versions: { '4.4.6': { kind: 'ko', index: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), publishedAt: '2026-10-19T00:00:00.000Z' } } };
const now = new Date('2026-10-20T00:00:00.000Z');
const input: SiteInput = {
  cdn,
  published,
  now,
  lang: { code: 'ko', text: '{"Save":"저장"}\n', catalogVersion: '4.4.6', commit: 'c'.repeat(40) },
  script: '#!/usr/bin/env bash\necho coolify-ko\n',
};
const sha = (text: string | Uint8Array): string => createHash('sha256').update(text).digest('hex');
const text = (files: SiteFiles, path: string): string => {
  const value = files.get(path);
  if (typeof value !== 'string') {
    throw new Error(`${path}: 글 파일이 아님`);
  }

  return value;
};
const signedXpi = (version: string): Buffer =>
  zip([
    ['manifest.json', Buffer.from(JSON.stringify({ manifest_version: 3, version, browser_specific_settings: { gecko: { id: 'coolify-ko@unofficial' } } }))],
    ['META-INF/cose.sig', Buffer.from('sig')],
  ]);

describe('buildSite', () => {
  it('lays out the mirror site', () => {
    expect([...buildSite(input).keys()].sort()).toEqual(['public/_headers', 'public/coolify-ko.sh', 'public/coolify-ko.sh.sha256', 'public/demo.html', 'public/index.html', 'public/lang/ko.json', 'public/lang/manifest.json', 'public/privacy.html', 'public/versions.json', 'wrangler.jsonc']);
  });

  // 2026-10-20: 레포 루트를 낼 때 미러 레포의 .git과 자동 생성된 wrangler 설정이 공개됐다
  it('deploys only the public folder as the mirror Worker and keeps its logs', () => {
    const config = JSON.parse(text(buildSite(input), 'wrangler.jsonc')) as Record<string, unknown>;

    expect(config).toMatchObject({ name: 'coolify-ko-mirror', assets: { directory: './public' } });
    expect(config['compatibility_date']).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(config['observability']).toEqual({
      logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true, persist: true },
      traces: { enabled: false, head_sampling_rate: 1, persist: true },
    });
    expect(config).not.toHaveProperty('main');
  });

  it('adds the signing key, the signed dictionary and an empty update list before Firefox signs the add-on', () => {
    const files = buildSite({ ...input, cosignPub: '-----BEGIN PUBLIC KEY-----\nx\n-----END PUBLIC KEY-----\n', extension: { dictionary: '{}', signature: 'sig' } });

    expect([...files.keys()].filter((path) => path === 'public/cosign.pub' || path.startsWith('public/extension/')).sort()).toEqual(['public/cosign.pub', 'public/extension/dictionary.json', 'public/extension/dictionary.json.sig', 'public/extension/updates.json']);
    expect(JSON.parse(text(files, 'public/extension/updates.json'))).toEqual({ addons: { 'coolify-ko@unofficial': { updates: [] } } });
  });

  it('hosts the signed Firefox add-on and points the update list at it with its hash', () => {
    const xpi = signedXpi('0.1.1');
    const files = buildSite({ ...input, extension: { dictionary: '{}', signature: 'sig', xpi } });

    expect(files.get('public/extension/coolify-ko-0.1.1.xpi')).toEqual(xpi);
    expect(JSON.parse(text(files, 'public/extension/updates.json'))).toEqual({
      addons: { 'coolify-ko@unofficial': { updates: [{ version: '0.1.1', update_link: `${SITE_URL}/extension/coolify-ko-0.1.1.xpi`, update_hash: `sha256:${sha(xpi)}` }] } },
    });
    expect(text(files, 'public/index.html')).toContain('href="extension/coolify-ko-0.1.1.xpi"');
  });

  // 2026-10-22 사용자: 다른 배포 사이트처럼 내려받기 링크 옆에 해시를 보인다
  it('shows the Firefox file with its version, size and SHA-256, and serves a checksum file', () => {
    const xpi = signedXpi('0.1.1');
    const files = buildSite({ ...input, extension: { dictionary: '{}', signature: 'sig', xpi } });
    const page = text(files, 'public/index.html');

    expect(text(files, 'public/extension/coolify-ko-0.1.1.xpi.sha256')).toBe(`${sha(xpi)}  coolify-ko-0.1.1.xpi\n`);
    expect(page).toContain(sha(xpi));
    expect(page).toContain('href="extension/coolify-ko-0.1.1.xpi.sha256"');
    expect(page).toContain('0.1.1');
    expect(page).toMatch(/\d+(\.\d)? KB/);
  });

  it.each([
    ['an unsigned add-on', zip([['manifest.json', Buffer.from(JSON.stringify({ version: '0.1.1', browser_specific_settings: { gecko: { id: 'coolify-ko@unofficial' } } }))]])],
    ['another add-on', zip([['manifest.json', Buffer.from(JSON.stringify({ version: '0.1.1', browser_specific_settings: { gecko: { id: 'other@example' } } }))], ['META-INF/cose.sig', Buffer.from('sig')]])],
  ])('refuses to host %s', (_label, xpi) => {
    expect(() => buildSite({ ...input, extension: { dictionary: '{}', signature: 'sig', xpi } })).toThrow();
  });

  it('serves the checked mirror, the language file with its hash and the script with its hash', () => {
    const files = buildSite(input);
    const versions = JSON.parse(text(files, 'public/versions.json')) as { coolify: { v4: { version: string } }; 'coolify-ko': { upstreamSeenAt: string } };

    expect(versions.coolify.v4.version).toBe('4.4.6');
    expect(versions['coolify-ko'].upstreamSeenAt).toBe(now.toISOString());
    expect(files.get('public/lang/manifest.json')).toBe(`${JSON.stringify({ schema: 1, code: 'ko', catalogVersion: '4.4.6', commit: 'c'.repeat(40), sha256: sha(input.lang.text) }, null, 2)}\n`);
    expect(files.get('public/coolify-ko.sh.sha256')).toBe(`${sha(input.script)}  coolify-ko.sh\n`);
  });

  it('allows cross-origin reads and marks the extension package type', () => {
    const headers = text(buildSite(input), 'public/_headers');

    expect(headers).toContain('/*\n  Access-Control-Allow-Origin: *');
    expect(headers).toContain('/extension/*.xpi\n  Content-Type: application/x-xpinstall');
  });

  it('explains install, revert, signature checks and contact on a page without scripts', () => {
    const page = text(buildSite(input), 'public/index.html');

    expect(page).toContain(`curl -fsSL ${SITE_URL}/coolify-ko.sh`);
    expect(page).toContain('sudo bash /data/coolify/source/coolify-ko.sh uninstall');
    expect(page).toContain(`cosign verify --key ${SITE_URL}/cosign.pub`);
    expect(page).toContain(SOURCE_REPO);
    expect(page).toContain('href="privacy.html"');
    expect(page).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(page).not.toContain('.xpi');
    expect(page).not.toMatch(/<script/i);
  });

  // 2026-10-22 사용자: Chrome 웹 스토어 승인, 문의는 개발자 문의 한 줄과 그 영어 줄
  it('links the Chrome Web Store and gives one developer contact in Korean and English', () => {
    const page = text(buildSite(input), 'public/index.html');
    const contact = page.slice(page.indexOf('<h2>문의</h2>'));

    expect(page).toContain(`href="${CHROME_STORE_URL}"`);
    expect(contact).toContain('개발자 문의');
    expect(contact).toContain('Developer contact');
    expect(contact).not.toContain('개인정보');
    expect(contact).not.toContain('privacy.html');
  });

  it('refuses to build before anything is published', () => {
    expect(() => buildSite({ ...input, published: { schema: 1, versions: {} } })).toThrow();
  });

  it('produces the same bytes for the same input', () => {
    expect([...buildSite(input)]).toEqual([...buildSite(input)]);
  });
});

// 스토어 등록(2026-10-20 사용자): 처리방침은 법정 기재 사항(개인정보 보호법 제30조, 시행령 제31조)을 모두 담는다
describe('privacy page', () => {
  const page = text(buildSite(input), 'public/privacy.html');

  it.each([
    '처리하는 개인정보 항목',
    '처리 목적',
    '처리 및 보유 기간',
    '제3자 제공',
    '처리 위탁과 국외 이전',
    '파기 절차와 방법',
    '이용자의 권리와 행사 방법',
    '안전성 확보 조치',
    '자동으로 수집하는 장치',
    '개인정보 보호책임자',
    '권익침해 구제 방법',
    '처리방침의 변경',
  ])('has a section on %s', (heading) => {
    expect(page).toMatch(new RegExp(`<h2>\\d+\\. ${heading}`));
  });

  it('names the overseas recipient, the contact address and the effective date', () => {
    expect(page).toContain('Cloudflare, Inc.');
    expect(page).toContain('PrivacyQuestions@cloudflare.com');
    expect(page).toContain(`mailto:${CONTACT_EMAIL}`);
    expect(page).toMatch(/시행일: \d{4}년 \d{1,2}월 \d{1,2}일/);
  });

  it('lists the relief agencies with their numbers', () => {
    for (const agency of ['1833-6972', '118', '1301', '182']) {
      expect(page).toContain(agency);
    }
  });

  it('states the same local limits as the extension code', () => {
    const content = readFileSync(join(import.meta.dirname, '..', '..', '..', 'extension', 'src', 'content.ts'), 'utf8');
    const engine = readFileSync(join(import.meta.dirname, '..', '..', '..', 'extension', 'src', 'engine.ts'), 'utf8');
    const limit = Number(/const MISSED_LIMIT = (\d+);/.exec(content)?.[1]);
    const longest = Number(/const MISSED_MAX = (\d+);/.exec(engine)?.[1]);

    expect(page).toContain(`최대 ${limit.toLocaleString('en-US')}개`);
    expect(page).toContain(`${String(longest)}자 이하`);
  });

  it('carries an English summary for store reviewers and no scripts', () => {
    expect(page).toContain('does not sell');
    expect(page).not.toMatch(/<script/i);
  });

  // 처리방침 검토(2026-10-20, Haiku 5.5 1개 + 확인): Chrome 제한적 사용 진술, 보존 기간 상한, 거부 방법, 요청에 담지 않는 데이터
  it('states Limited Use compliance, the retention ceiling, how to refuse and what requests carry', () => {
    expect(page).toContain('including the Limited Use requirements');
    expect(page).toContain('제한적 사용 요건');
    expect(page).toContain('최대 7일');
    expect(page).not.toContain('7일이 지나면');
    expect(page).toContain('거부 방법:');
    expect(page).toContain('이용자 데이터를 담지 않습니다');
    expect(page).toContain('https://www.cloudflare.com/network/');
  });
});

describe('demo page', () => {
  it('shows only phrases that the extension dictionary translates', () => {
    const exact = repoDictionary('4.4.6.1').exact;
    const page = text(buildSite(input), 'public/demo.html');

    expect(DEMO_PHRASES.length).toBeGreaterThanOrEqual(10);
    for (const phrase of DEMO_PHRASES) {
      expect(exact[phrase], phrase).toBeTypeOf('string');
      expect(page).toContain(phrase.replaceAll('&', '&amp;'));
    }
    expect(page).toContain('이 주소에서 켜기');
    expect(page).not.toMatch(/<script/i);
  });
});

describe('writeSite and refreshVersions', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const site = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'coolify-ko-site-'));
    dirs.push(dir);

    return dir;
  };

  it('replaces the whole site but keeps the git folder', () => {
    const dir = site();
    mkdirSync(join(dir, '.git'));
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    writeFileSync(join(dir, 'stale.txt'), 'old');
    writeSite(dir, buildSite(input));

    expect(existsSync(join(dir, 'stale.txt'))).toBe(false);
    expect(existsSync(join(dir, '.git', 'HEAD'))).toBe(true);
    expect(readFileSync(join(dir, 'public', 'lang', 'ko.json'), 'utf8')).toBe(input.lang.text);
  });

  it('only rewrites versions.json and keeps the first-seen time of the same upstream version', () => {
    const dir = site();
    writeSite(dir, buildSite(input));
    const before = statSync(join(dir, 'public', 'lang', 'ko.json')).mtimeMs;
    const later = new Date('2026-10-21T00:00:00.000Z');

    expect(refreshVersions(dir, { cdn, published, now: later })).toEqual({ changed: true, issues: [] });
    const versions = JSON.parse(readFileSync(join(dir, 'public', 'versions.json'), 'utf8')) as { 'coolify-ko': { upstreamSeenAt: string; refreshedAt: string } };
    expect(versions['coolify-ko']).toMatchObject({ upstreamSeenAt: now.toISOString(), refreshedAt: later.toISOString() });
    expect(statSync(join(dir, 'public', 'lang', 'ko.json')).mtimeMs).toBe(before);
  });

  it('starts a new first-seen time when the upstream version moves', () => {
    const dir = site();
    writeSite(dir, buildSite(input));
    const newer = structuredClone(cdn) as { coolify: { v4: { version: string } } };
    newer.coolify.v4.version = '4.4.7';
    const later = new Date('2026-10-21T00:00:00.000Z');
    refreshVersions(dir, { cdn: newer, published, now: later });

    expect((JSON.parse(readFileSync(join(dir, 'public', 'versions.json'), 'utf8')) as { 'coolify-ko': { upstreamSeenAt: string } })['coolify-ko'].upstreamSeenAt).toBe(later.toISOString());
  });

  it('writes nothing when the official file went backwards', () => {
    const dir = site();
    writeSite(dir, buildSite(input));
    const before = readFileSync(join(dir, 'public', 'versions.json'), 'utf8');
    const older = structuredClone(cdn) as { coolify: { v4: { version: string } } };
    older.coolify.v4.version = '4.4.5';

    expect(refreshVersions(dir, { cdn: older, published, now })).toMatchObject({ changed: false });
    expect(refreshVersions(dir, { cdn: older, published, now }).issues.length).toBeGreaterThan(0);
    expect(readFileSync(join(dir, 'public', 'versions.json'), 'utf8')).toBe(before);
  });
});
