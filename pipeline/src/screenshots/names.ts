// 숫자·UUID·cuid(영문 소문자와 숫자 20~32자, 둘 다 섞임). 시험 인스턴스를 새로 띄울 때마다 바뀌는 레코드 id다
const ID_SEGMENT = /^(?:\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{20,32})$/i;
// Weblate Screenshot.name의 max_length
const MAX_NAME = 200;

/** 화면 이름: 쪽 경로의 레코드 id를 {id}로 바꿔, 버전마다 같은 화면이 한 장으로 남게 한다(검토 2026-10-18 Important 6) */
export function screenName(path: string): string {
  return path
    .split('/')
    .map((segment) => (ID_SEGMENT.test(segment) ? '{id}' : segment))
    .join('/');
}

/** 스크린샷 이름: 화면, 둘째 조각부터 " #번호", 연 창은 " › 버튼 이름" */
export function shotName(shot: { readonly path: string; readonly part?: number; readonly modal?: string }): string {
  const screen = screenName(shot.path);
  const name = shot.modal !== undefined ? `${screen} › ${shot.modal}` : shot.part !== undefined && shot.part > 1 ? `${screen} #${String(shot.part)}` : screen;

  return name.slice(0, MAX_NAME);
}
