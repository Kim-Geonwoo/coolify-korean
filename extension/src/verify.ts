import { compareVersions, isDictionary, type ExtensionDictionary } from './engine.ts';

/**
 * 원격 사전 검증(방법 C, 이번엔 코드 경로만). 사전은 데이터(JSON)일 뿐이고 코드를 받지 않는다.
 * ECDSA P-256 분리 서명(WebCrypto, r‖s 64바이트) + 크기 상한 + 스키마 + 버전 단조 증가(롤백 거부).
 */
export const MAX_DICTIONARY_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;

interface Current {
  readonly code: string;
  readonly version: string;
}

export async function verifySignedDictionary(input: {
  readonly bytes: Uint8Array;
  readonly signature: Uint8Array;
  readonly publicKey: JsonWebKey;
  readonly current: Current;
  readonly subtle: SubtleCrypto;
}): Promise<ExtensionDictionary> {
  if (input.bytes.byteLength > MAX_DICTIONARY_BYTES) {
    throw new Error('dictionary too large');
  }
  const key = await input.subtle.importKey('jwk', input.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await input.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(input.signature), new Uint8Array(input.bytes));
  if (!valid) {
    throw new Error('bad signature');
  }
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.bytes));
  if (!isDictionary(value)) {
    throw new Error('not a dictionary');
  }
  if (value.code !== input.current.code) {
    throw new Error('other language');
  }
  if (compareVersions(value.version, input.current.version) <= 0) {
    throw new Error('not newer');
  }

  return value;
}

async function readCapped(response: Response): Promise<Uint8Array> {
  if (!response.ok) {
    throw new Error(`http ${String(response.status)}`);
  }
  const announced = Number(response.headers.get('content-length') ?? '0');
  if (announced > MAX_DICTIONARY_BYTES) {
    throw new Error('dictionary too large');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_DICTIONARY_BYTES) {
    throw new Error('dictionary too large');
  }

  return bytes;
}

function decodeBase64(text: string): Uint8Array {
  const binary = atob(text.trim());

  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** 갱신 주소의 사전과 `<주소>.sig`(base64 서명)를 받아 검증한다. 주소가 비어 있으면 끈 것(null). https만 */
export async function fetchSignedDictionary(input: {
  readonly url: string;
  readonly publicKey: JsonWebKey;
  readonly current: Current;
  readonly subtle: SubtleCrypto;
  readonly fetcher: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<ExtensionDictionary | null> {
  if (input.url === '') {
    return null;
  }
  if (new URL(input.url).protocol !== 'https:') {
    throw new Error('https only');
  }
  const get = async (url: string): Promise<Uint8Array> => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, FETCH_TIMEOUT_MS);
    try {
      return await readCapped(await input.fetcher(url, { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' }));
    } finally {
      clearTimeout(timer);
    }
  };
  const bytes = await get(input.url);
  const signature = decodeBase64(new TextDecoder().decode(await get(`${input.url}.sig`)));

  return verifySignedDictionary({ bytes, signature, publicKey: input.publicKey, current: input.current, subtle: input.subtle });
}
