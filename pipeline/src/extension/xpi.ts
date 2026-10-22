import { inflateRawSync } from 'node:zlib';

/**
 * addons.mozilla.org가 서명한 Firefox 확장 묶음(.xpi = zip)에서 id·버전을 읽는다. 사이트의 updates.json과 파일 이름을 이 값으로 만든다.
 * 중앙 디렉터리만 믿고(로컬 헤더의 크기는 쓰지 않음), manifest.json 하나만 푼다
 */
export interface XpiInfo {
  readonly id: string;
  readonly version: string;
  /** AMO 서명 파일(META-INF/cose.sig 또는 mozilla.rsa)이 들어 있는지 */
  readonly signed: boolean;
}

const MAX_MANIFEST_BYTES = 64 * 1024;
const VERSION = /^\d{1,9}(?:\.\d{1,9}){0,3}$/;

interface Entry {
  readonly method: number;
  readonly compressed: number;
  readonly size: number;
  readonly offset: number;
}

function entries(bytes: Buffer): Map<string, Entry> {
  // 끝 레코드(22바이트 + 주석 최대 65535)를 뒤에서 찾는다
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at--) {
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    throw new Error('xpi가 zip이 아닙니다.');
  }
  const count = bytes.readUInt16LE(end + 10);
  let at = bytes.readUInt32LE(end + 16);
  const found = new Map<string, Entry>();
  for (let index = 0; index < count; index++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) {
      throw new Error('xpi 중앙 디렉터리가 깨졌습니다.');
    }
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    found.set(name, { method: bytes.readUInt16LE(at + 10), compressed: bytes.readUInt32LE(at + 20), size: bytes.readUInt32LE(at + 24), offset: bytes.readUInt32LE(at + 42) });
    at += 46 + nameLength + extraLength + commentLength;
  }

  return found;
}

function read(bytes: Buffer, entry: Entry): Buffer {
  if (entry.size > MAX_MANIFEST_BYTES || entry.offset + 30 > bytes.length || bytes.readUInt32LE(entry.offset) !== 0x04034b50) {
    throw new Error('xpi manifest.json을 읽지 못했습니다.');
  }
  const start = entry.offset + 30 + bytes.readUInt16LE(entry.offset + 26) + bytes.readUInt16LE(entry.offset + 28);
  const data = bytes.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) {
    throw new Error('xpi manifest.json이 잘렸습니다.');
  }
  const out = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_MANIFEST_BYTES }) : undefined;
  if (out?.length !== entry.size) {
    throw new Error('xpi manifest.json 압축 방식이나 크기가 맞지 않습니다.');
  }

  return out;
}

export function xpiInfo(input: Uint8Array): XpiInfo {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const files = entries(bytes);
  const entry = files.get('manifest.json');
  if (entry === undefined) {
    throw new Error('xpi에 manifest.json이 없습니다.');
  }
  const manifest = JSON.parse(read(bytes, entry).toString('utf8')) as { version?: unknown; browser_specific_settings?: { gecko?: { id?: unknown } } };
  const id = manifest.browser_specific_settings?.gecko?.id;
  const version = manifest.version;
  if (typeof id !== 'string' || id === '' || typeof version !== 'string' || !VERSION.test(version)) {
    throw new Error('xpi manifest.json에 gecko id나 버전이 없습니다.');
  }

  return { id, version, signed: files.has('META-INF/cose.sig') || files.has('META-INF/mozilla.rsa') };
}
