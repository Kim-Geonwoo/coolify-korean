/**
 * 사용자가 글자 그대로 쳐야 하는 확인 문구(`confirmationText="…"`). 화면은 입력값을 이 영어와 비교하므로,
 * 안내문에 이 문구가 나오면 번역에서도 바꾸지 않고 그대로 둬야 한다(2b: '삭제된 백업 정리'로 옮겨 확인이 통과하지 않을 뻔했다).
 */
const LITERAL = /(?<![:\w-])confirmationText="([^"]*)"/g;

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 변환된 Blade 템플릿에서 글자 그대로 적힌 확인 문구를 모은다(바인딩·echo 값은 뺀다) */
export function scanVerbatim(files: readonly { readonly path: string; readonly text: string }[]): string[] {
  const found = new Set<string>();
  for (const file of files) {
    for (const match of file.text.matchAll(LITERAL)) {
      const value = match[1] ?? '';
      if (value.trim() !== '' && !/\{\{|\{!!|\$/.test(value)) {
        found.add(value);
      }
    }
  }

  return [...found].sort(byCodeUnit);
}

/** 영어에는 있는데 번역에서 사라진 확인 문구 */
export function verbatimMissing(english: string, translation: string, literals: readonly string[]): string[] {
  return literals.filter((literal) => english.includes(literal) && !translation.includes(literal));
}
