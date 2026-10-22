import { describe, expect, it } from 'vitest';
import type { ExtensionDictionary } from './engine.ts';
import { fetchSignedDictionary, MAX_DICTIONARY_BYTES, verifySignedDictionary } from './verify.ts';

const subtle = globalThis.crypto.subtle;

const dictionary = (version: string, patch: Partial<ExtensionDictionary> = {}): ExtensionDictionary => ({
  schema: 1,
  code: 'ko',
  version,
  exact: { Save: '저장' },
  patterns: [],
  tagged: {},
  verbatim: ['Confirm Deletion'],
  ...patch,
});

async function keys(): Promise<{ publicKey: JsonWebKey; sign: (bytes: Uint8Array<ArrayBuffer>) => Promise<Uint8Array<ArrayBuffer>> }> {
  const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicKey = await subtle.exportKey('jwk', pair.publicKey);

  return { publicKey, sign: async (bytes) => new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes)) };
}

const encode = (value: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(value));

describe('verifySignedDictionary', () => {
  it('accepts a dictionary signed with the key and newer than the current one', async () => {
    const { publicKey, sign } = await keys();
    const bytes = encode(dictionary('4.4.6.2'));

    const result = await verifySignedDictionary({ bytes, signature: await sign(bytes), publicKey, current: { code: 'ko', version: '4.4.6.1' }, subtle });

    expect(result.version).toBe('4.4.6.2');
    expect(result.exact['Save']).toBe('저장');
  });

  it('rejects the dictionary when one byte changes after signing', async () => {
    const { publicKey, sign } = await keys();
    const bytes = encode(dictionary('4.4.6.2'));
    const signature = await sign(bytes);
    const tampered = bytes.slice();
    tampered[tampered.indexOf(0x53)] = 0x54;

    await expect(verifySignedDictionary({ bytes: tampered, signature, publicKey, current: { code: 'ko', version: '4.4.6.1' }, subtle })).rejects.toThrow();
  });

  it('rejects a signature made with another key', async () => {
    const { publicKey } = await keys();
    const other = await keys();
    const bytes = encode(dictionary('4.4.6.2'));

    await expect(verifySignedDictionary({ bytes, signature: await other.sign(bytes), publicKey, current: { code: 'ko', version: '4.4.6.1' }, subtle })).rejects.toThrow();
  });

  it('rejects a lower or equal version (no rollback)', async () => {
    const { publicKey, sign } = await keys();
    for (const version of ['4.4.6.0', '4.4.6.1', '4.4.5.9']) {
      const bytes = encode(dictionary(version));

      await expect(verifySignedDictionary({ bytes, signature: await sign(bytes), publicKey, current: { code: 'ko', version: '4.4.6.1' }, subtle })).rejects.toThrow();
    }
  });

  it('rejects another language, a broken shape, and anything over the size cap', async () => {
    const { publicKey, sign } = await keys();
    const current = { code: 'ko', version: '4.4.6.1' };
    const japanese = encode(dictionary('4.4.6.2', { code: 'ja' }));
    const broken = encode({ ...dictionary('4.4.6.2'), exact: { Save: 1 } });
    const big = new Uint8Array(MAX_DICTIONARY_BYTES + 1).fill(0x20);

    await expect(verifySignedDictionary({ bytes: japanese, signature: await sign(japanese), publicKey, current, subtle })).rejects.toThrow();
    await expect(verifySignedDictionary({ bytes: broken, signature: await sign(broken), publicKey, current, subtle })).rejects.toThrow();
    await expect(verifySignedDictionary({ bytes: big, signature: await sign(big), publicKey, current, subtle })).rejects.toThrow();
    expect(MAX_DICTIONARY_BYTES).toBe(2 * 1024 * 1024);
  });
});

describe('fetchSignedDictionary', () => {
  const current = { code: 'ko', version: '4.4.6.1' };

  it('does nothing when no update address is set', async () => {
    const { publicKey } = await keys();
    let calls = 0;
    const fetcher = (): Promise<Response> => {
      calls++;

      return Promise.resolve(new Response('{}'));
    };

    expect(await fetchSignedDictionary({ url: '', publicKey, current, subtle, fetcher })).toBeNull();
    expect(calls).toBe(0);
  });

  it('fetches the dictionary and its detached base64 signature over https', async () => {
    const { publicKey, sign } = await keys();
    const bytes = encode(dictionary('4.4.6.3'));
    const signature = btoa(String.fromCharCode(...(await sign(bytes))));
    const asked: string[] = [];
    const fetcher = (url: string): Promise<Response> => {
      asked.push(url);

      return Promise.resolve(new Response(url.endsWith('.sig') ? signature : bytes));
    };

    const result = await fetchSignedDictionary({ url: 'https://example.com/ko.json', publicKey, current, subtle, fetcher });

    expect(result?.version).toBe('4.4.6.3');
    expect(asked).toEqual(['https://example.com/ko.json', 'https://example.com/ko.json.sig']);
  });

  it('refuses plain http and responses that announce more than the cap', async () => {
    const { publicKey } = await keys();
    const huge = (): Promise<Response> => Promise.resolve(new Response('{}', { headers: { 'content-length': String(MAX_DICTIONARY_BYTES + 1) } }));

    await expect(fetchSignedDictionary({ url: 'http://example.com/ko.json', publicKey, current, subtle, fetcher: huge })).rejects.toThrow();
    await expect(fetchSignedDictionary({ url: 'https://example.com/ko.json', publicKey, current, subtle, fetcher: huge })).rejects.toThrow();
  });
});
