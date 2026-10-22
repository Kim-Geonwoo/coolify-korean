import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapturedPage } from '../weblate/screenshots.ts';
import { keysOf } from './markers.ts';

/**
 * 찍기 컨테이너가 쓴 결과를 호스트가 읽을 때의 검사. 컨테이너는 업스트림 화면을 다루므로 믿지 않는다:
 * 그 결과로 호스트가 다른 파일(비밀값 등)을 읽어 Weblate에 올리게 되면 안 된다.
 */
const FILE = /^\d{3}\.(?:png|webp)$/;
const ID = /^[0-9a-z]{1,8}$/;
// 쪽마다 조각 여러 장(tiles.ts). 파일 이름이 세 자리라 1000장까지
const MAX_PAGES = 1000;
const MAX_PART = 20;
const MAX_MODAL = 80;
const MAX_IDS = 20_000;
const MAX_PATH = 300;
const MAX_PNG_BYTES = 20 * 1024 * 1024;
const MAX_LIST_BYTES = 2 * 1024 * 1024;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const bad = (why: string): Error => new Error(`스크린샷 목록(pages.json)이 형식에 맞지 않습니다: ${why}`);

/** pages.json → 쪽 목록(파일은 이름만). 형식이 하나라도 어긋나면 통째로 거부한다 */
export function parseCaptured(data: unknown, keys: readonly string[]): CapturedPage[] {
  if (!Array.isArray(data) || data.length > MAX_PAGES) {
    throw bad('목록이 아니거나 너무 깁니다');
  }

  return (data as unknown[]).map((item) => {
    const { path, part = 1, modal, file, ids } = (item ?? {}) as { path?: unknown; part?: unknown; modal?: unknown; file?: unknown; ids?: unknown };
    if (typeof path !== 'string' || !path.startsWith('/') || path.length > MAX_PATH || /\p{Cc}/u.test(path)) {
      throw bad('경로');
    }
    if (typeof part !== 'number' || !Number.isInteger(part) || part < 1 || part > MAX_PART) {
      throw bad('조각 번호');
    }
    if (modal !== undefined && (typeof modal !== 'string' || modal === '' || modal.length > MAX_MODAL || /\p{Cc}/u.test(modal))) {
      throw bad('창 이름');
    }
    if (typeof file !== 'string' || !FILE.test(file)) {
      throw bad('파일 이름');
    }
    if (!Array.isArray(ids) || ids.length > MAX_IDS || !(ids as unknown[]).every((id) => typeof id === 'string' && ID.test(id))) {
      throw bad('키 번호');
    }

    return { path, ...(part > 1 ? { part } : {}), ...(modal === undefined ? {} : { modal }), file, keys: keysOf(ids as string[], keys) };
  });
}

/**
 * 일반 파일만 읽는다. 심볼릭 링크는 거부하고(lstat), 링크를 따라가지 않게 연 뒤(Linux O_NOFOLLOW) 연 파일로 종류·크기를 다시 본다:
 * 검사와 읽기 사이에 링크로 바꿔치기해도 다른 파일을 읽지 않는다
 */
function readRegular(path: string, maxBytes: number, what: string): Buffer {
  if (!lstatSync(path).isFile()) {
    throw new Error(`${what}이(가) 일반 파일이 아닙니다`);
  }
  // O_NOFOLLOW는 Windows에 없다(개발 PC). 타입은 늘 있다고 하므로 넓혀서 읽는다
  const fd = openSync(path, constants.O_RDONLY | ((constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`${what}이(가) 일반 파일이 아닙니다`);
    }
    if (stat.size > maxBytes) {
      throw new Error(`${what}이(가) 너무 큽니다`);
    }

    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 출력 폴더의 pages.json을 읽어 검사한다. 없으면 빈 목록. JSON이 아니면 내용을 옮기지 않고 거부한다(비밀값일 수 있다) */
export function readCapturedList(out: string, keys: readonly string[]): CapturedPage[] {
  let text: string;
  try {
    text = readRegular(join(out, 'pages.json'), MAX_LIST_BYTES, '스크린샷 목록').toString('utf8');
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw bad('JSON이 아닙니다');
  }

  return parseCaptured(data, keys);
}

/** 출력 폴더 안의 일반 이미지 파일(PNG·WebP)만 읽는다(심볼릭 링크·다른 이름·확장자와 내용이 다른 것·너무 큰 것 거부) */
export function readImage(out: string, file: string): Uint8Array {
  if (!FILE.test(file)) {
    throw bad('파일 이름');
  }
  const bytes = readRegular(join(out, file), MAX_PNG_BYTES, `스크린샷 ${file}`);
  if (file.endsWith('.webp')) {
    const tag = (from: number): string => String.fromCharCode(...bytes.subarray(from, from + 4));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WEBP') {
      throw new Error(`스크린샷이 WebP가 아닙니다: ${file}`);
    }
  } else if (!PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) {
    throw new Error(`스크린샷이 PNG가 아닙니다: ${file}`);
  }

  return new Uint8Array(bytes);
}
