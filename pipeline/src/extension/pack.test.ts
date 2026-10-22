import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isDictionary } from '../../../extension/src/engine.ts';
import { bundleEntry, pack } from './pack.ts';

const work = mkdtempSync(join(tmpdir(), 'coolify-ko-pack-'));
const out = (name: string): string => join(work, name);
const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
const TOKEN = /\b(?:import|export)\b/;

/** zip 중앙 디렉터리를 읽어 항목 이름과 내용을 돌려준다(시험용 최소 판독기) */
function unzip(path: string): Map<string, Buffer> {
  const zip = readFileSync(path);
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const files = new Map<string, Buffer>();
  for (let index = 0; index < count; index++) {
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(dataAt, dataAt + size);
    const data = method === 8 ? inflateRawSync(raw) : raw;
    if (crc32(data) !== crc) {
      throw new Error(`crc mismatch: ${name}`);
    }
    files.set(name, data);
    at += 46 + nameLength + extraLength + commentLength;
  }

  return files;
}

beforeAll(() => {
  pack('chrome', out('chrome'), { version: '4.4.6.1' });
  pack('firefox', out('firefox'), { version: '4.4.6.1' });
  pack('chrome', out('e2e'), { version: '4.4.6.1', e2eOrigin: 'http://127.0.0.1:18090' });
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('pack', () => {
  it('asks for hosts only as optional permissions in the Chrome build', () => {
    const manifest = readJson(join(out('chrome'), 'manifest.json'));

    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['optional_host_permissions']).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest).not.toHaveProperty('host_permissions');
    expect(manifest['permissions']).toEqual(expect.arrayContaining(['storage', 'scripting']));
    expect(manifest['background']).toEqual({ service_worker: 'background.js' });
  });

  it('gives the Firefox build its gecko id, data-collection declaration and event-page background', () => {
    const manifest = readJson(join(out('firefox'), 'manifest.json'));
    const gecko = (manifest['browser_specific_settings'] as { gecko: Record<string, unknown> }).gecko;

    expect(gecko['id']).toBe('coolify-ko@unofficial');
    expect(gecko['data_collection_permissions']).toEqual({ required: ['none'] });
    // AMO 경고(2026-10-20): data_collection_permissions는 Android 142부터라 Android 최소 버전을 따로 둔다
    expect(gecko['strict_min_version']).toBe('140.0');
    expect((manifest['browser_specific_settings'] as { gecko_android?: unknown }).gecko_android).toEqual({ strict_min_version: '142.0' });
    expect(manifest['background']).toEqual({ scripts: ['background.js'] });
    expect(manifest['optional_host_permissions']).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest).not.toHaveProperty('host_permissions');
  });

  it('grants only the test origin up front in the e2e build', () => {
    const manifest = readJson(join(out('e2e'), 'manifest.json'));

    expect(manifest['host_permissions']).toEqual(['http://127.0.0.1:18090/*']);
    expect(manifest['optional_host_permissions']).toEqual(['http://*/*', 'https://*/*']);
  });

  it('writes each script as one IIFE with no import or export left, and valid syntax', () => {
    for (const name of ['content.js', 'background.js', 'popup.js']) {
      const code = readFileSync(join(out('chrome'), name), 'utf8');

      expect(code, name).not.toMatch(TOKEN);
      expect(code.startsWith('(() => {'), name).toBe(true);
      expect(code.trimEnd().endsWith('})();'), name).toBe(true);
      expect(() => new Script(code, { filename: name }), name).not.toThrow();
    }
    expect(readFileSync(join(out('chrome'), 'content.js'), 'utf8')).toContain('function translateText(');
  });

  it('puts the dictionary built from the repo next to the scripts', () => {
    const dictionary = readJson(join(out('chrome'), 'dictionary.json'));

    expect(isDictionary(dictionary)).toBe(true);
    expect(dictionary['version']).toBe('4.4.6.1');
    expect((dictionary['exact'] as Record<string, string>)['Save']).toBe('저장');
  });

  it('zips exactly the folder files, readable and checksummed', () => {
    const files = unzip(`${out('firefox')}.zip`);

    expect([...files.keys()].sort()).toEqual(['background.js', 'content.js', 'dictionary.json', 'icons/icon-128.png', 'icons/icon-16.png', 'icons/icon-32.png', 'icons/icon-48.png', 'manifest.json', 'popup.html', 'popup.js']);
    expect(files.get('manifest.json')?.toString('utf8')).toBe(readFileSync(join(out('firefox'), 'manifest.json'), 'utf8'));
  });

  // 스토어 등록(2026-10-20): 아이콘이 없으면 브라우저가 기본 퍼즐 아이콘을 보인다
  it('ships square PNG icons that the manifest and the toolbar button point to', () => {
    const manifest = readJson(join(out('chrome'), 'manifest.json'));
    const icons = { '16': 'icons/icon-16.png', '32': 'icons/icon-32.png', '48': 'icons/icon-48.png', '128': 'icons/icon-128.png' };

    expect(manifest['icons']).toEqual(icons);
    expect((manifest['action'] as Record<string, unknown>)['default_icon']).toEqual({ '16': icons['16'], '32': icons['32'] });
    for (const [size, path] of Object.entries(icons)) {
      const png = readFileSync(join(out('chrome'), ...path.split('/')));

      expect(png.subarray(1, 4).toString('latin1'), path).toBe('PNG');
      expect([png.readUInt32BE(16), png.readUInt32BE(20)], path).toEqual([Number(size), Number(size)]);
    }
  });

  it('refuses an e2e origin that is not a bare http(s) origin', () => {
    expect(() => {
      pack('chrome', out('bad'), { version: '4.4.6.1', e2eOrigin: 'http://127.0.0.1:18090/path' });
    }).toThrow();
    expect(existsSync(join(out('bad'), 'manifest.json'))).toBe(false);
  });
});

describe('bundleEntry', () => {
  it('inlines local imports in dependency order and throws on any other import', () => {
    const dir = out('bundle');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.ts'), "export function a(): number {\n  return 1;\n}\n");
    writeFileSync(join(dir, 'b.ts'), "import { a } from './a.ts';\nexport const b = (): number => a() + 1;\n");
    writeFileSync(join(dir, 'main.ts'), "import { a } from './a.ts';\nimport { b } from './b.ts';\nconsole.log(a() + b());\n");
    writeFileSync(join(dir, 'bad.ts'), "import { readFileSync } from 'node:fs';\nconsole.log(readFileSync);\n");

    const code = bundleEntry(dir, 'main');
    const logged: unknown[] = [];
    new Script(code).runInNewContext({ console: { log: (value: unknown) => logged.push(value) } });

    expect(code).not.toMatch(TOKEN);
    expect(code.indexOf('function a(')).toBeLessThan(code.indexOf('const b ='));
    expect(code.match(/function a\(/g)).toHaveLength(1);
    expect(logged).toEqual([3]);
    expect(() => bundleEntry(dir, 'bad')).toThrow();
  });
});
