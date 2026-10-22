import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

/**
 * tar 목록 읽기(외부 tar 없이). 공개판 OCI 묶음과 그 안의 층을 검사하는 데 쓴다.
 * 윈도의 tar는 bsdtar·GNU tar가 섞여 있고 GNU tar는 "C:..."를 원격 호스트로 읽어, 직접 읽는다.
 * ustar의 prefix와 pax 확장 헤더(path·시각·소유자)를 읽는다. Docker(Go archive/tar)와 해석이 갈릴 수 있는 항목(pax size·linkpath·xattr,
 * 전역 pax·GNU 긴 이름, 이어진 pax 헤더, 끝 표시 뒤 데이터)과 체크섬이 틀리거나 잘린 묶음은 던진다(보안 검토 2026-10-19)
 */
export interface TarEntry {
  readonly path: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  readonly size: number;
  /** 데이터가 시작하는 바이트 위치(묶음 기준) */
  readonly offset: number;
  /** 권한 비트(setuid·setgid 포함) */
  readonly mode: number;
  readonly uid: number;
  readonly gid: number;
}

const BLOCK = 512;
const MAX_GUNZIP = 1024 * 1024 * 1024;
const MAX_ENTRY_READ = 512 * 1024 * 1024;
// Docker 층이 쓰는 pax 키(이름·시각·소유자)만 받는다
const PAX_KEYS = new Set(['path', 'mtime', 'atime', 'ctime', 'uid', 'gid', 'uname', 'gname']);

type Read = (offset: number, length: number) => Buffer;

const text = (block: Buffer, start: number, length: number): string => {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);

  return raw.subarray(0, end < 0 ? raw.length : end).toString('utf8');
};

function numeric(block: Buffer, start: number, length: number): number {
  const field = block.subarray(start, start + length);
  // 큰 값은 base-256(첫 바이트 최상위 비트)
  if (((field[0] ?? 0) & 0x80) !== 0) {
    let value = (field[0] ?? 0) & 0x7f;
    for (const byte of field.subarray(1)) {
      value = value * 256 + byte;
    }

    return value;
  }
  const digits = field.toString('ascii').replace(/[\0 ]+$/g, '').trim();
  if (digits === '') {
    return 0;
  }
  if (!/^[0-7]+$/.test(digits)) {
    throw new Error('tar 헤더의 숫자 칸이 8진수가 아닙니다.');
  }

  return Number.parseInt(digits, 8);
}

function checksumOk(block: Buffer): boolean {
  let sum = 0;
  for (let index = 0; index < BLOCK; index++) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  }

  return numeric(block, 148, 8) === sum;
}

/** pax 레코드("길이 키=값\n") */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>();
  let position = 0;
  while (position < data.length) {
    const space = data.indexOf(0x20, position);
    const length = space < 0 ? NaN : Number.parseInt(data.subarray(position, space).toString('ascii'), 10);
    if (!Number.isInteger(length) || length <= 0 || position + length > data.length) {
      throw new Error('pax 헤더 형식이 맞지 않습니다.');
    }
    const record = data.subarray(space + 1, position + length - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals > 0) {
      records.set(record.slice(0, equals), record.slice(equals + 1));
    }
    position += length;
  }

  return records;
}

const paxNumber = (value: string | undefined, fallback: number): number => {
  if (value === undefined) {
    return fallback;
  }
  if (!/^\d+$/.test(value)) {
    throw new Error('pax 숫자 값이 맞지 않습니다.');
  }

  return Number(value);
};

const kind = (flag: string): TarEntry['type'] => {
  switch (flag) {
    case '0':
    case '\0':
    case '7':
      return 'file';
    case '5':
      return 'dir';
    case '2':
      return 'symlink';
    case '1':
      return 'hardlink';
    default:
      return 'other';
  }
};

function parse(read: Read, total: number): TarEntry[] {
  const entries: TarEntry[] = [];
  let offset = 0;
  // 다음 항목에만 적용되는 pax 값(path·uid·gid)과 GNU 긴 이름
  let next = new Map<string, string>();
  let pending = false;
  while (offset < total) {
    if (offset + BLOCK > total) {
      throw new Error('tar 헤더가 잘렸습니다.');
    }
    const block = read(offset, BLOCK);
    if (block.every((byte) => byte === 0)) {
      // Go archive/tar처럼 끝 표시는 0블록 둘이다. 0블록 뒤에 다른 것이 있으면 읽는 쪽마다 다르게 본다
      const following = offset + BLOCK < total ? read(offset + BLOCK, BLOCK) : Buffer.alloc(0);
      if (!following.every((byte) => byte === 0)) {
        throw new Error('tar 끝 표시 뒤에 데이터가 있습니다.');
      }
      break;
    }
    if (!checksumOk(block)) {
      throw new Error(`tar 헤더 체크섬이 맞지 않습니다(위치 ${String(offset)}).`);
    }
    const size = numeric(block, 124, 12);
    const start = offset + BLOCK;
    if (start + size > total) {
      throw new Error('tar 항목 데이터가 잘렸습니다.');
    }
    const flag = String.fromCharCode(block[156] ?? 0);
    const prefix = text(block, 257, 6) === 'ustar' ? text(block, 345, 155) : '';
    const name = prefix === '' ? text(block, 0, 100) : `${prefix}/${text(block, 0, 100)}`;
    if (flag === 'x') {
      // Go는 연속한 pax 헤더 중 마지막 것만 쓰고, size·linkpath·xattr 등은 항목 해석을 바꾼다: 갈릴 수 있는 것은 받지 않는다
      if (pending) {
        throw new Error('pax 헤더가 이어집니다.');
      }
      const records = paxRecords(read(start, size));
      const unknown = [...records.keys()].find((key) => !PAX_KEYS.has(key));
      if (unknown !== undefined) {
        throw new Error(`허용하지 않는 pax 키입니다: ${unknown.slice(0, 40)}`);
      }
      next = records;
      pending = true;
    } else if (flag === 'g' || flag === 'L' || flag === 'K') {
      throw new Error(`허용하지 않는 tar 항목 종류입니다: ${flag}`);
    } else {
      pending = false;
      entries.push({
        path: (next.get('path') ?? name).replace(/^\.\//, ''),
        type: kind(flag),
        size,
        offset: start,
        mode: numeric(block, 100, 8) & 0o7777,
        uid: paxNumber(next.get('uid'), numeric(block, 108, 8)),
        gid: paxNumber(next.get('gid'), numeric(block, 116, 8)),
      });
      next = new Map();
    }
    offset = start + Math.ceil(size / BLOCK) * BLOCK;
  }
  if (pending) {
    throw new Error('pax 헤더 뒤에 항목이 없습니다.');
  }

  return entries;
}

/** 메모리의 tar(gzip이면 풀어서) 목록. 층 blob처럼 작은 묶음용 */
export function listTar(data: Buffer): TarEntry[] {
  const plain = data[0] === 0x1f && data[1] === 0x8b ? gunzipSync(data, { maxOutputLength: MAX_GUNZIP }) : data;

  return parse((offset, length) => plain.subarray(offset, offset + length), plain.length);
}

/** 디스크의 (압축 안 된) tar를 헤더만 읽어 나열한다. OCI 묶음처럼 큰 파일용 */
export function listTarFile(path: string): TarEntry[] {
  const fd = openSync(path, 'r');
  try {
    const total = fstatSync(fd).size;

    return parse((offset, length) => {
      const buffer = Buffer.alloc(length);
      const got = readSync(fd, buffer, 0, length, offset);

      return buffer.subarray(0, got);
    }, total);
  } finally {
    closeSync(fd);
  }
}

/** listTarFile로 찾은 항목 하나의 데이터 */
export function readTarEntry(path: string, entry: TarEntry): Buffer {
  if (entry.size > MAX_ENTRY_READ) {
    throw new Error(`tar 항목이 너무 큽니다: ${entry.path}`);
  }
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(entry.size);
    const got = readSync(fd, buffer, 0, entry.size, entry.offset);
    if (got !== entry.size) {
      throw new Error(`tar 항목을 끝까지 읽지 못했습니다: ${entry.path}`);
    }

    return buffer;
  } finally {
    closeSync(fd);
  }
}

/** 같은 경로가 둘 이상이면 던진다(푸는 쪽은 마지막 것을, 우리는 첫 것을 읽게 된다) */
export function uniquePaths(entries: readonly TarEntry[]): readonly TarEntry[] {
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replace(/\/$/, '');
    if (seen.has(path)) {
      throw new Error(`tar에 같은 경로가 두 번 있습니다: ${path.slice(0, 80)}`);
    }
    seen.add(path);
  }

  return entries;
}
