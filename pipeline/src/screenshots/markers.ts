/**
 * 스크린샷용 키 표식 가짜 번역. 값마다 사설 영역 문자로 `열기 번호 가운데 영어 닫기`를 두르면,
 * 화면에 나온 글에서 어느 키가 그 쪽에 있는지 번호로 되찾을 수 있다(AI 없음). smoke의 ⟦ ⟧ 표식과 겹치지 않는다.
 * 찍기 전에 표식을 지워 영어 화면으로 되돌린다. 복수형(a|b)은 한 덩어리로 둘러, 고른 구간에 따라 번호가 안 보일 수 있다.
 */
export const MARK = { open: '', mid: '', close: '' } as const;

const ID = /([0-9a-z]+)/g;
const ANY = /[0-9a-z]+|/g;

/** 키를 정렬해 번호(36진수 순번)를 매긴다. keys[번호]가 그 키다 */
export function keyedPseudo(english: Readonly<Record<string, string>>): { translations: Record<string, string>; keys: string[] } {
  const keys = Object.keys(english).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const translations: Record<string, string> = {};
  keys.forEach((key, index) => {
    translations[key] = `${MARK.open}${index.toString(36)}${MARK.mid}${english[key] ?? ''}${MARK.close}`;
  });

  return { translations, keys };
}

export function markerIds(text: string): string[] {
  return [...text.matchAll(ID)].map((match) => match[1] ?? '');
}

export function stripMarkers(text: string): string {
  return text.replace(ANY, '');
}

/** 쪽에서 찾은 번호를 키로 되돌린다(모르는 번호는 버린다) */
export function keysOf(ids: readonly string[], keys: readonly string[]): string[] {
  return ids.flatMap((id) => {
    const key = /^[0-9a-z]+$/.test(id) ? keys[parseInt(id, 36)] : undefined;

    return key === undefined ? [] : [key];
  });
}
