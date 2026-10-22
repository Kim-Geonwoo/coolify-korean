// 원격 사전 서명 공개 키(ECDSA P-256, 2026-10-20 발행용). 개인 키는 관리자 PC에만 있다(pipeline/src/extension/cli.ts keygen).
// 확장(background.ts)과 사이트 발행(publish site의 서명 확인)이 같은 값을 쓴다
export const UPDATE_PUBLIC_KEY: JsonWebKey = { kty: 'EC', crv: 'P-256', x: '-6w4g6rKZ-SDKYFbV8_SlXyYpxY-pORluKVQhfM5QWo', y: 'HTic4xDbN7uxg_1KH4LY51M-b4MCPq7p3NPSj4ZtDp8' };
