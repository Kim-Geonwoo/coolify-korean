/**
 * 확장 원격 사전 서명(5단계 공개 계획 P5). 확장(extension/src/verify.ts)과 같은 형식이다: ECDSA P-256, SHA-256, r‖s 64바이트를 base64로.
 * 개인 키는 사용자가 PC에서 만들고 사용자 폴더에만 둔다(집 서버·레포에 두지 않는다). 공개 키(JWK)만 확장 코드에 들어간다
 */
export interface SigningKey {
  readonly privateJwk: JsonWebKey;
  readonly publicJwk: JsonWebKey;
}

const ALGORITHM = { name: 'ECDSA', namedCurve: 'P-256' } as const;

export async function generateSigningKey(): Promise<SigningKey> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const full = await crypto.subtle.exportKey('jwk', pair.publicKey);

  // 공개 키에는 곡선 점만 둔다(key_ops·ext 등은 확장 코드에 넣을 때 필요 없다)
  return { privateJwk, publicJwk: { kty: full.kty ?? 'EC', crv: full.crv ?? 'P-256', x: full.x ?? '', y: full.y ?? '' } };
}

export async function signBytes(privateJwk: JsonWebKey, bytes: Uint8Array): Promise<string> {
  if (privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || typeof privateJwk.d !== 'string') {
    throw new Error('P-256 개인 키(JWK)가 아닙니다.');
  }
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALGORITHM, false, ['sign']);
  const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(bytes));

  return Buffer.from(signature).toString('base64');
}

/** 발행 전 확인: 공개 키로 서명이 풀리는지(형식이 틀린 서명도 false) */
export async function verifyBytes(publicJwk: JsonWebKey, bytes: Uint8Array, signature: string): Promise<boolean> {
  const raw = Buffer.from(signature.trim(), 'base64');
  if (raw.length !== 64) {
    return false;
  }
  const key = await crypto.subtle.importKey('jwk', publicJwk, ALGORITHM, false, ['verify']);

  return crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, new Uint8Array(raw), new Uint8Array(bytes));
}
