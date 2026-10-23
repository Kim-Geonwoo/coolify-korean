/**
 * 사용자가 고른 Coolify 주소(origin) 다루기. popup·background가 같이 쓴다(import 없는 모듈, 팩이 앞에 붙인다).
 */

/** 지금 탭이 웹 쪽이 아닐 때(chrome://, 새 탭 등) popup이 보여 주는 안내. http도 된다는 것이 드러나게 쓴다 */
export const NOT_WEB_TAB = '이 탭에서는 사용할 수 없습니다. Coolify 대시보드(http:// 또는 https:// 주소)를 연 탭에서 다시 눌러 주세요.';

/** http(s) 쪽의 origin(스킴·호스트·포트). 그 밖이면 null */
export function parseOrigin(url: string | undefined): string | null {
  if (url === undefined) {
    return null;
  }
  try {
    const parsed = new URL(url);

    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

/** 권한 요청·스크립트 등록용 패턴. Firefox 패턴은 포트를 못 담아 빼고, content가 저장된 origin(포트 포함)과 다시 대조한다 */
export function originPattern(origin: string, firefox: boolean): string {
  const parsed = new URL(origin);

  return `${parsed.protocol}//${firefox ? parsed.hostname : parsed.host}/*`;
}
