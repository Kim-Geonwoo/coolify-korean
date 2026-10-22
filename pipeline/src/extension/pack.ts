import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import ts from 'typescript';
import type { ExtensionDictionary } from '../../../extension/src/engine.ts';
import { parseOrigin, originPattern } from '../../../extension/src/origins.ts';
import { parseExclusions } from '../i18n/exclusions.ts';
import { langPaths, primaryLanguage } from '../i18n/languages.ts';
import type { CatalogLite } from '../i18n/memory.ts';
import { buildDictionary, mergeLang } from './dictionary.ts';

/**
 * 확장 팩(방법 C). 각 스크립트를 TypeScript transpileModule로 바꾸고, `./x.ts` import를 그 자리에서 풀어
 * 하나의 IIFE로 묶는다(번들러 의존성 없음). manifest를 합치고 레포 번역 묶음으로 만든 사전을 넣어 폴더와 zip을 만든다.
 */
export type Target = 'chrome' | 'firefox';

const root = join(import.meta.dirname, '..', '..', '..');
const extensionDir = join(root, 'extension');
const sourceDir = join(extensionDir, 'src');
/** 툴바·확장 목록·스토어 아이콘(extension/static/icons, 원본 디자인) */
const ICON_SIZES = [16, 32, 48, 128] as const;
const ENTRIES = ['content', 'background', 'popup'] as const;
const LOCAL_IMPORT = /^import\s+[^'";]*?\s+from\s+'\.\/([\w-]+)\.ts';[ \t]*$/gm;
const EXPORT_KEYWORD = /^export\s+(?=(?:async\s+)?function\b|const\b|let\b|class\b)/gm;
const LEFTOVER = /\b(?:import|export)\b/;

function transpile(dir: string, name: string): { code: string; deps: string[] } {
  const file = join(dir, `${name}.ts`);
  const output = ts.transpileModule(readFileSync(file, 'utf8'), {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, removeComments: true, verbatimModuleSyntax: true, isolatedModules: true },
  });
  const problems = output.diagnostics ?? [];
  if (problems.length > 0) {
    throw new Error(`${name}.ts 변환 실패: ${ts.flattenDiagnosticMessageText(problems[0]?.messageText ?? '', ' ')}`);
  }
  const deps: string[] = [];
  const code = output.outputText.replace(LOCAL_IMPORT, (_line, dep: string) => {
    deps.push(dep);

    return '';
  });

  return { code: code.replace(EXPORT_KEYWORD, '').replace(/^export\s*\{\s*\};?[ \t]*$/gm, ''), deps };
}

/** entry와 그것이 import한 로컬 모듈을 의존 순서로 이어 하나의 IIFE로 만든다. import·export가 남으면 던진다 */
export function bundleEntry(dir: string, entry: string): string {
  const order: string[] = [];
  const bodies = new Map<string, string>();
  const visit = (name: string, path: readonly string[]): void => {
    if (bodies.has(name)) {
      return;
    }
    if (path.includes(name)) {
      throw new Error(`순환 import: ${[...path, name].join(' → ')}`);
    }
    const { code, deps } = transpile(dir, name);
    for (const dep of deps) {
      visit(dep, [...path, name]);
    }
    bodies.set(name, code.trim());
    order.push(name);
  };
  visit(entry, []);
  const code = `(() => {\n'use strict';\n${order.map((name) => bodies.get(name) ?? '').join('\n')}\n})();\n`;
  if (LEFTOVER.test(code)) {
    throw new Error(`${entry}: 묶은 뒤에도 import·export가 남았습니다(로컬 ./x.ts 모듈만 쓸 수 있습니다).`);
  }

  return code;
}

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'));

function manifest(target: Target, e2eOrigin: string | undefined): Record<string, unknown> {
  const merged: Record<string, unknown> = {
    ...(readJson(join(extensionDir, 'manifest.base.json')) as Record<string, unknown>),
    ...(readJson(join(extensionDir, `manifest.${target}.json`)) as Record<string, unknown>),
  };
  if (e2eOrigin !== undefined) {
    // e2e 전용: 시험 주소 하나만 설치 때 허락해 둔다(사용자 판에는 없다)
    merged['host_permissions'] = [originPattern(e2eOrigin, target === 'firefox')];
  }

  return merged;
}

/** 사전 버전 기본값: 카탈로그(상류) 버전 + HEAD 커밋 시각(UTC, 분) */
function defaultVersion(catalogVersion: string): string {
  const result = spawnSync('git', ['-C', root, 'log', '-1', '--format=%cd', '--date=format-local:%Y%m%d%H%M'], { encoding: 'utf8', windowsHide: true, timeout: 30_000, env: { ...process.env, TZ: 'UTC' } });
  const stamp = result.stdout.trim();
  if (result.status !== 0 || !/^\d{12}$/.test(stamp)) {
    throw new Error('사전 버전을 정하지 못했습니다(git 커밋 시각). --version을 주세요.');
  }

  return `${catalogVersion}.${stamp}`;
}

/** 레포 번역 묶음으로 사전을 만든다(reviewed > 초안, 제외·확인 문구 반영) */
export function repoDictionary(version?: string): ExtensionDictionary {
  const catalog = readJson(join(root, 'i18n', 'catalog.json')) as CatalogLite;
  const verbatim = (readJson(join(root, 'i18n', 'verbatim.json')) as { literals: string[] }).literals;
  // 언어별 파일 이름은 i18n/languages.json에서 켜진 언어로 만든다(5단계 다국어 준비)
  const { code } = primaryLanguage(root);
  const paths = langPaths(code);
  const lang = mergeLang({
    catalog,
    reviewed: readJson(join(root, paths.reviewed)) as Record<string, string>,
    drafts: readJson(join(root, paths.drafts)) as Record<string, string>,
    exclusions: parseExclusions(readJson(join(root, 'i18n', 'exclude.json'))),
    verbatim,
  });

  return buildDictionary({ catalog, lang, verbatim, code, version: version ?? defaultVersion(catalog.version) });
}

/** 압축(deflate) zip. 시각은 1980-01-01로 고정해 같은 내용이면 같은 바이트다 */
export function zip(files: readonly (readonly [string, Buffer])[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, packed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + packed.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, directory, end]);
}

/** target 판을 out 폴더에 쓰고 `${out}.zip`도 만든다 */
export function pack(target: Target, out: string, options: { readonly version?: string; readonly e2eOrigin?: string } = {}): void {
  const { e2eOrigin } = options;
  if (e2eOrigin !== undefined && parseOrigin(e2eOrigin) !== e2eOrigin) {
    throw new Error(`e2e 주소는 http(s) origin만 됩니다: ${e2eOrigin}`);
  }
  const files: [string, Buffer][] = [
    ['manifest.json', Buffer.from(`${JSON.stringify(manifest(target, e2eOrigin), null, 2)}\n`)],
    ['dictionary.json', Buffer.from(`${JSON.stringify(repoDictionary(options.version))}\n`)],
    ...ENTRIES.map((entry): [string, Buffer] => [`${entry}.js`, Buffer.from(bundleEntry(sourceDir, entry))]),
    ['popup.html', readFileSync(join(extensionDir, 'static', 'popup.html'))],
    ...ICON_SIZES.map((size): [string, Buffer] => [`icons/icon-${String(size)}.png`, readFileSync(join(extensionDir, 'static', 'icons', `icon-${String(size)}.png`))]),
  ];
  mkdirSync(out, { recursive: true });
  for (const [name, data] of files) {
    mkdirSync(dirname(join(out, name)), { recursive: true });
    writeFileSync(join(out, name), data);
  }
  writeFileSync(`${out}.zip`, zip(files));
}
