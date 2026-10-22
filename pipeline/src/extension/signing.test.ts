import { describe, expect, it } from 'vitest';
import { verifySignedDictionary } from '../../../extension/src/verify.ts';
import { UPDATE_PUBLIC_KEY } from '../../../extension/src/updateKey.ts';
import { buildDictionary } from './dictionary.ts';
import { generateSigningKey, signBytes, verifyBytes } from './signing.ts';

const catalog = { version: '4.4.6', keys: { Save: { english: 'Save', kinds: ['text'], placeholders: [] } } };
const dictionary = buildDictionary({ catalog, lang: { Save: '저장' }, verbatim: [], code: 'ko', version: '4.4.6.202610190000' });
const bytes = new TextEncoder().encode(JSON.stringify(dictionary));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(Buffer.from(text, 'base64'));

describe('dictionary signing', () => {
  it('signs a dictionary that the extension accepts with the public key', async () => {
    const key = await generateSigningKey();
    const signature = await signBytes(key.privateJwk, bytes);
    const accepted = await verifySignedDictionary({ bytes, signature: fromBase64(signature), publicKey: key.publicJwk, current: { code: 'ko', version: '4.4.6.202610180000' }, subtle: crypto.subtle });

    expect(accepted.version).toBe('4.4.6.202610190000');
    expect(fromBase64(signature)).toHaveLength(64);
  });

  it('keeps the private part out of the public key', async () => {
    const key = await generateSigningKey();

    expect(Object.keys(key.publicJwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(typeof key.privateJwk.d).toBe('string');
  });

  it('produces a signature the extension rejects for another key or changed bytes', async () => {
    const key = await generateSigningKey();
    const other = await generateSigningKey();
    const signature = fromBase64(await signBytes(key.privateJwk, bytes));
    const changed = Uint8Array.from(bytes);
    changed[10] = (changed[10] ?? 0) ^ 1;
    const current = { code: 'ko', version: '4.4.6.202610180000' };

    await expect(verifySignedDictionary({ bytes, signature, publicKey: other.publicJwk, current, subtle: crypto.subtle })).rejects.toThrow();
    await expect(verifySignedDictionary({ bytes: changed, signature, publicKey: key.publicJwk, current, subtle: crypto.subtle })).rejects.toThrow();
  });

  // 발행 전 확인(2026-10-20): 확장에 든 공개 키로 풀리지 않는 서명은 사이트에 올리지 않는다
  it('checks a signature against a public key before publishing', async () => {
    const key = await generateSigningKey();
    const signature = await signBytes(key.privateJwk, bytes);
    const changed = Uint8Array.from(bytes);
    changed[10] = (changed[10] ?? 0) ^ 1;

    expect(await verifyBytes(key.publicJwk, bytes, signature)).toBe(true);
    expect(await verifyBytes(key.publicJwk, changed, signature)).toBe(false);
    expect(await verifyBytes(UPDATE_PUBLIC_KEY, bytes, signature)).toBe(false);
    expect(await verifyBytes(key.publicJwk, bytes, 'not base64 !')).toBe(false);
  });

  it('refuses a key file that is not a P-256 private key', async () => {
    const key = await generateSigningKey();

    await expect(signBytes(key.publicJwk, bytes)).rejects.toThrow();
  });
});
