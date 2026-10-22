import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCaptured, readCapturedList, readImage } from './pages.ts';

const keys = ['Cancel', 'Save'];
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

describe('parseCaptured', () => {
  it('reads what the capture container wrote, mapping ids back to keys', () => {
    expect(parseCaptured([{ path: '/servers', file: '000.png', ids: ['1', '0', 'zz'] }], keys)).toEqual([{ path: '/servers', file: '000.png', keys: ['Save', 'Cancel'] }]);
  });

  it('refuses entries that could make the host read other files or carry odd text (the container is not trusted)', () => {
    for (const bad of [
      { path: '/servers', file: '../../secrets/weblate-bridge.token', ids: ['0'] },
      { path: '/servers', file: 'a.png', ids: ['0'] },
      { path: 'servers', file: '000.png', ids: ['0'] },
      { path: '/x\n/y', file: '000.png', ids: ['0'] },
      { path: '/servers', file: '000.png', ids: ['../0'] },
      { path: '/servers', file: '000.png', ids: 'all' },
    ]) {
      expect(() => parseCaptured([bad], keys)).toThrow('스크린샷 목록');
    }
    expect(() => parseCaptured({ pages: [] }, keys)).toThrow('스크린샷 목록');
  });

  it('reads the tile number of a long page cut into parts, and leaves it off for the first part', () => {
    expect(parseCaptured([{ path: '/servers', part: 2, file: '001.png', ids: ['0'] }], keys)).toEqual([{ path: '/servers', part: 2, file: '001.png', keys: ['Cancel'] }]);
    expect(parseCaptured([{ path: '/servers', part: 1, file: '000.png', ids: ['0'] }], keys)).toEqual([{ path: '/servers', file: '000.png', keys: ['Cancel'] }]);
    for (const part of [0, 21, 1.5, '2']) {
      expect(() => parseCaptured([{ path: '/servers', part, file: '000.png', ids: ['0'] }], keys)).toThrow('스크린샷 목록');
    }
  });

  it('reads the button name of an opened dialog, and refuses an empty, long or odd one', () => {
    expect(parseCaptured([{ path: '/servers', modal: 'Add', file: '002.png', ids: ['1'] }], keys)).toEqual([{ path: '/servers', modal: 'Add', file: '002.png', keys: ['Save'] }]);
    for (const modal of ['', 'x'.repeat(81), 'a\nb', 7]) {
      expect(() => parseCaptured([{ path: '/servers', modal, file: '002.png', ids: ['1'] }], keys)).toThrow('스크린샷 목록');
    }
  });

  it('accepts WebP shots by name and nothing else', () => {
    expect(parseCaptured([{ path: '/servers', file: '003.webp', ids: ['1'] }], keys)).toEqual([{ path: '/servers', file: '003.webp', keys: ['Save'] }]);
    expect(() => parseCaptured([{ path: '/servers', file: '003.gif', ids: ['1'] }], keys)).toThrow('스크린샷 목록');
  });

  it('takes a day of several hundred tiles but not more files than three-digit names allow', () => {
    const entry = (n: number): unknown => ({ path: `/p${String(n)}`, file: `${String(n % 1000).padStart(3, '0')}.png`, ids: ['0'] });

    expect(parseCaptured(Array.from({ length: 600 }, (_, n) => entry(n)), keys)).toHaveLength(600);
    expect(() => parseCaptured(Array.from({ length: 1001 }, (_, n) => entry(n)), keys)).toThrow('스크린샷 목록');
  });
});

describe('readImage', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const outDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'screens-out-'));
    dirs.push(dir);

    return dir;
  };

  it('reads a regular PNG file inside the output folder', () => {
    const out = outDir();
    writeFileSync(join(out, '000.png'), PNG);

    expect(readImage(out, '000.png')).toEqual(PNG);
  });

  it('refuses a file that is not a PNG', () => {
    const out = outDir();
    writeFileSync(join(out, '000.png'), 'wlu_secret_token');

    expect(() => readImage(out, '000.png')).toThrow('PNG');
  });

  it('reads a WebP shot, and refuses a .webp name holding something else', () => {
    const out = outDir();
    const webp = Uint8Array.from([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0]);
    writeFileSync(join(out, '000.webp'), webp);
    writeFileSync(join(out, '001.webp'), PNG);

    expect(readImage(out, '000.webp')).toEqual(webp);
    expect(() => readImage(out, '001.webp')).toThrow('WebP');
  });

  it('refuses a symbolic link even when it points at a PNG', () => {
    const out = outDir();
    const elsewhere = outDir();
    writeFileSync(join(elsewhere, 'real.png'), PNG);
    mkdirSync(join(out, 'sub'));
    try {
      symlinkSync(join(elsewhere, 'real.png'), join(out, '001.png'));
    } catch {
      // Windows에서 심볼릭 링크 권한이 없으면 이 경우는 건너뛴다(서버는 Linux)
      return;
    }

    expect(() => readImage(out, '001.png')).toThrow('일반 파일');
  });
});

describe('readCapturedList', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const outDir = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'screens-list-'));
    dirs.push(dir);

    return dir;
  };

  it('reads pages.json written by the container', () => {
    const out = outDir();
    writeFileSync(join(out, 'pages.json'), JSON.stringify([{ path: '/team', file: '000.png', ids: ['1'] }]));

    expect(readCapturedList(out, keys)).toEqual([{ path: '/team', file: '000.png', keys: ['Save'] }]);
  });

  it('returns nothing when the container wrote no list', () => {
    expect(readCapturedList(outDir(), keys)).toEqual([]);
  });

  it('does not echo the file content when it is not JSON (it could be a secret)', () => {
    const out = outDir();
    writeFileSync(join(out, 'pages.json'), 'wlu_secret_token_value');

    expect(() => readCapturedList(out, keys)).toThrow('스크린샷 목록');
    try {
      readCapturedList(out, keys);
    } catch (error: unknown) {
      expect(String(error)).not.toContain('wlu_secret');
    }
  });

  it('refuses a symbolic link in place of the list', () => {
    const out = outDir();
    const elsewhere = outDir();
    writeFileSync(join(elsewhere, 'secret'), '[]');
    try {
      symlinkSync(join(elsewhere, 'secret'), join(out, 'pages.json'));
    } catch {
      // Windows에서 심볼릭 링크 권한이 없으면 건너뛴다(서버는 Linux)
      return;
    }

    expect(() => readCapturedList(out, keys)).toThrow();
  });
});
