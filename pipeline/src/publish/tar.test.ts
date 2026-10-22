import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { listTar, listTarFile, readTarEntry, uniquePaths } from './tar.ts';

const BLOCK = 512;

/** 시험용 ustar 헤더(체크섬 포함) */
function header(name: string, type: string, size: number, options: { readonly prefix?: string; readonly link?: string } = {}): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100, 'ascii');
  block.write('0000000\0', 108, 'ascii');
  block.write('0000000\0', 116, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  block.write('00000000000\0', 136, 'ascii');
  block.write('        ', 148, 'ascii');
  block.write(type, 156, 'ascii');
  block.write(options.link ?? '', 157, 100, 'utf8');
  block.write('ustar\0', 257, 'ascii');
  block.write('00', 263, 'ascii');
  block.write(options.prefix ?? '', 345, 155, 'utf8');
  let sum = 0;
  for (const byte of block) {
    sum += byte;
  }
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');

  return block;
}

function entry(name: string, type: string, data: Buffer = Buffer.alloc(0), options: { readonly prefix?: string; readonly link?: string } = {}): Buffer {
  const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;

  return Buffer.concat([header(name, type, data.length, options), data, Buffer.alloc(padding)]);
}

function pax(path: string): Buffer {
  const body = ` path=${path}\n`;
  let length = body.length;
  while (`${String(length)}${body}`.length !== length) {
    length = `${String(length)}${body}`.length;
  }

  return entry('PaxHeader', 'x', Buffer.from(`${String(length)}${body}`));
}

const longDir = `var/www/html/resources/views/${'livewire/'.repeat(9)}`;
const veryLong = `var/www/html/app/${'Deeply/'.repeat(30)}File.php`;
const archive = Buffer.concat([
  entry('var/www/html/app/', '5'),
  entry('var/www/html/app/x.php', '0', Buffer.from('<?php echo 1;')),
  entry('var/www/html/app/link', '2', Buffer.alloc(0), { link: '/etc/passwd' }),
  entry('page.blade.php', '0', Buffer.from('hi'), { prefix: longDir.slice(0, -1) }),
  pax(veryLong),
  entry('ignored-short-name', '0', Buffer.from('long')),
  Buffer.alloc(BLOCK * 2),
]);
const expected = [
  { path: 'var/www/html/app/', type: 'dir', size: 0 },
  { path: 'var/www/html/app/x.php', type: 'file', size: 13 },
  { path: 'var/www/html/app/link', type: 'symlink', size: 0 },
  { path: `${longDir}page.blade.php`, type: 'file', size: 2 },
  { path: veryLong, type: 'file', size: 4 },
];

describe('listTar', () => {
  it('lists ustar entries with prefix and pax path names', () => {
    expect(listTar(archive).map(({ path, type, size }) => ({ path, type, size }))).toEqual(expected);
  });

  it('reads the permission bits', () => {
    expect(listTar(archive)[1]?.mode).toBe(0o644);
  });

  it('reads owner ids, preferring pax values', () => {
    const records = (pairs: readonly (readonly [string, string])[]): Buffer => {
      const body = pairs
        .map(([key, value]) => {
          const tail = ` ${key}=${value}\n`;
          let length = tail.length + 1;
          while (`${String(length)}${tail}`.length !== length) {
            length = `${String(length)}${tail}`.length;
          }

          return `${String(length)}${tail}`;
        })
        .join('');

      return entry('PaxHeader', 'x', Buffer.from(body));
    };
    const owned = Buffer.concat([records([['uid', '9999'], ['gid', '9999']]), entry('var/www/html/app/y.php', '0', Buffer.from('y')), entry('plain', '0'), Buffer.alloc(BLOCK * 2)]);
    const [first, second] = listTar(owned);

    expect([first?.uid, first?.gid, second?.uid, second?.gid]).toEqual([9999, 9999, 0, 0]);
  });

  it('reads the same entries through gzip', () => {
    expect(listTar(gzipSync(archive)).map(({ path, type, size }) => ({ path, type, size }))).toEqual(expected);
  });

  it('refuses a truncated header', () => {
    expect(() => listTar(archive.subarray(0, BLOCK + 100))).toThrow();
  });

  it('refuses an entry whose data runs past the end', () => {
    expect(() => listTar(entry('a', '0', Buffer.alloc(2000)).subarray(0, BLOCK * 2))).toThrow();
  });

  // 보안 검토(2026-10-19): Docker가 쓰는 Go archive/tar와 다르게 읽으면 허용 경로 밖 파일을 층 검증에서 숨길 수 있다.
  // 해석이 갈릴 수 있는 항목은 모두 거부한다
  describe('rejects headers whose meaning differs between tar readers', () => {
    const records = (pairs: readonly (readonly [string, string])[]): Buffer => {
      const body = pairs
        .map(([key, value]) => {
          const tail = ` ${key}=${value}\n`;
          let length = tail.length + 1;
          while (`${String(length)}${tail}`.length !== length) {
            length = `${String(length)}${tail}`.length;
          }

          return `${String(length)}${tail}`;
        })
        .join('');

      return entry('PaxHeader', 'x', Buffer.from(body));
    };
    const end = Buffer.alloc(BLOCK * 2);
    const hidden = Buffer.concat([entry('var/www/html/routes/web.php', '0', Buffer.from('evil!')), Buffer.alloc(BLOCK - ((BLOCK + BLOCK) % BLOCK))]);

    it.each([
      ['a pax size that hides the next header', Buffer.concat([records([['size', '0']]), entry('var/www/html/app/a.php', '0', hidden), end])],
      ['two pax headers in a row', Buffer.concat([records([['path', 'var/www/html/app/a.php']]), records([['path', 'var/www/html/routes/web.php']]), entry('x', '0'), end])],
      ['a global pax header', Buffer.concat([entry('pax_global_header', 'g', Buffer.from('19 path=var/x/y.php\n')), entry('var/www/html/app/a.php', '0'), end])],
      ['a GNU long name', Buffer.concat([entry('././@LongLink', 'L', Buffer.from('var/www/html/routes/web.php\0')), entry('var/www/html/app/a.php', '0'), end])],
      ['a GNU long link name', Buffer.concat([entry('././@LongLink', 'K', Buffer.from('/etc/passwd\0')), entry('var/www/html/app/a.php', '2'), end])],
      ['a file capability attribute', Buffer.concat([records([['SCHILY.xattr.security.capability', 'x']]), entry('var/www/html/app/a.php', '0'), end])],
      ['a sparse file name', Buffer.concat([records([['GNU.sparse.name', 'var/www/html/routes/web.php']]), entry('var/www/html/app/a.php', '0'), end])],
      ['a pax link target', Buffer.concat([records([['linkpath', '/etc/passwd']]), entry('var/www/html/app/a.php', '0'), end])],
      ['a pax header with nothing after it', Buffer.concat([records([['path', 'var/www/html/app/a.php']]), end])],
      ['data after the end-of-archive block', Buffer.concat([entry('var/www/html/app/a.php', '0'), Buffer.alloc(BLOCK), entry('var/www/html/routes/web.php', '0'), end])],
    ])('%s', (_label, data) => {
      expect(() => listTar(data)).toThrow();
    });

    it('still accepts the pax keys Docker layers use', () => {
      const ok = Buffer.concat([records([['path', 'var/www/html/app/a.php'], ['mtime', '1729300000.123456789'], ['atime', '1729300000'], ['ctime', '1729300000'], ['uid', '9999'], ['gid', '9999'], ['uname', 'www-data'], ['gname', 'www-data']]), entry('x', '0'), end]);

      expect(listTar(ok).map((item) => item.path)).toEqual(['var/www/html/app/a.php']);
    });
  });

  it('refuses a header with a wrong checksum', () => {
    const broken = Buffer.from(archive);
    broken[0] = 'w'.charCodeAt(0);

    expect(() => listTar(broken)).toThrow();
  });
});

describe('listTarFile and readTarEntry', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a tar on disk without loading it and reads one entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coolify-ko-tar-'));
    dirs.push(dir);
    const path = join(dir, 'a.tar');
    writeFileSync(path, archive);
    const entries = listTarFile(path);
    const php = entries.find((item) => item.path === 'var/www/html/app/x.php');

    expect(entries.map((item) => item.path)).toEqual(expected.map((item) => item.path));
    expect(php === undefined ? '' : readTarEntry(path, php).toString('utf8')).toBe('<?php echo 1;');
  });
});

describe('uniquePaths', () => {
  it('refuses an archive that names the same path twice (extractors keep the last one)', () => {
    const twice = Buffer.concat([entry('index.json', '0', Buffer.from('{}')), entry('index.json', '0', Buffer.from('{"x":1}')), Buffer.alloc(BLOCK * 2)]);

    expect(() => uniquePaths(listTar(twice))).toThrow();
    expect(() => uniquePaths(listTar(archive))).not.toThrow();
  });
});
