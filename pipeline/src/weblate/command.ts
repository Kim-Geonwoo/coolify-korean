import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadExclusions } from '../i18n/exclusions.ts';
import { langPaths } from '../i18n/languages.ts';
import { canonicalJson } from '../i18n/integrity.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { loadGlossary } from '../translate/glossary.ts';
import { createClient } from './client.ts';
import { setupWeblate } from './setup.ts';
import { pruneWeblateOutputs } from './prune.ts';
import { weblateSyncCommand, writeIfChanged } from './syncCli.ts';
import { WEBLATE } from './config.ts';

const USAGE = '사용법: cli.ts weblate setup [--url http://127.0.0.1:8792] [--token-file 파일(기본: $CREDENTIALS_DIRECTORY/weblate-bridge.token)] | weblate sync [--base-url URL] [--token-dir D] [--cache-dir D] [--report 파일] | weblate prune';

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  const value = index >= 0 ? argv[index + 1] : undefined;

  return value === undefined || value.startsWith('--') ? undefined : value;
}

/** 토큰은 파일(systemd LoadCredential)로만 받는다. 인자·환경 변수에 비밀값을 두지 않는다 */
function bridgeToken(argv: readonly string[]): string {
  const credentials = process.env['CREDENTIALS_DIRECTORY'];
  const path = option(argv, 'token-file') ?? (credentials === undefined ? undefined : join(credentials, 'weblate-bridge.token'));
  if (path === undefined) {
    throw new Error('Weblate 토큰 파일이 없습니다(--token-file 또는 LoadCredential weblate-bridge.token).');
  }
  const token = readFileSync(path, 'utf8').trim();
  if (token === '') {
    throw new Error('Weblate 토큰 파일이 비어 있습니다.');
  }

  return token;
}

export async function weblateCommand(argv: readonly string[], root: string): Promise<void> {
  switch (argv[1]) {
    case 'setup': {
      const baseUrl = option(argv, 'url') ?? process.env['COOLIFY_KO_WEBLATE_URL'] ?? 'http://127.0.0.1:8792';
      const client = createClient({ baseUrl, token: bridgeToken(argv) });
      const report = await setupWeblate(client, {
        en: JSON.parse(readFileSync(join(root, 'i18n', 'en.json'), 'utf8')) as Record<string, string>,
        exclusions: loadExclusions(join(root, 'i18n', 'exclude.json')),
        glossary: loadGlossary(join(root, langPaths(WEBLATE.lang).glossary)),
      });
      const list = (items: readonly string[]): string => (items.length === 0 ? '없음' : items.join('·'));
      console.log(`Weblate 설정: 만듦 ${list(report.created)} · 프로젝트 설정 ${list(report.project)} · 컴포넌트 설정 ${list(report.component)} · 읽기 전용 ${String(report.readOnly)} · 용어 ${String(report.terms)} · 올리지 않은 키 ${String(report.skipped.length)}`);
      return;
    }
    case 'sync':
      await weblateSyncCommand(argv, root);
      return;
    case 'prune': {
      // 새 버전 추출 뒤 밤 작업이 부른다. Weblate·토큰 없이 레포의 검수 결과에서 낡은 것만 뺀다
      const i18n = join(root, 'i18n');
      const read = <T>(path: string, fallback: T): T => (existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T) : fallback);
      const files = langPaths(WEBLATE.lang);
      const paths = { reviewed: join(root, files.reviewed), meta: join(root, files.reviewedMeta), pending: join(root, files.pending) };
      const out = pruneWeblateOutputs({
        catalog: read<CatalogLite>(join(i18n, 'catalog.json'), { version: '', keys: {} }),
        exclusions: loadExclusions(join(i18n, 'exclude.json')),
        verbatim: read<{ literals: string[] }>(join(i18n, 'verbatim.json'), { literals: [] }).literals,
        reviewed: read<Record<string, string>>(paths.reviewed, {}),
        meta: read<Record<string, { sourceHash: string }>>(paths.meta, {}),
        pending: read<Record<string, string>>(paths.pending, {}),
      });
      const empty = (value: object): boolean => Object.keys(value).length === 0;
      writeIfChanged(paths.reviewed, canonicalJson(out.reviewed), empty(out.reviewed));
      writeIfChanged(paths.meta, canonicalJson(out.meta), empty(out.meta));
      writeIfChanged(paths.pending, canonicalJson(out.pending), empty(out.pending));
      console.log(`검수 결과 정리: 뺀 것 ${String(out.removed.length)}${out.removed.length === 0 ? '' : ` (${out.removed.slice(0, 5).join(', ')}${out.removed.length > 5 ? ' …' : ''})`}`);
      return;
    }
    default:
      throw new Error(USAGE);
  }
}
