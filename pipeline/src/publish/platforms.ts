/**
 * 공개판이 내는 플랫폼(5단계 사용자 결정 1: 공식처럼 amd64+arm64).
 * 변환은 빌드 기계에서 한 번만 하고 두 플랫폼에 같은 파일을 얹으므로(판결 R3), 공식 이미지의 두 플랫폼 소스가 바이트까지 같아야 한다
 */
export const PLATFORMS = ['linux/amd64', 'linux/arm64'] as const;
export type Platform = (typeof PLATFORMS)[number];

const LINE = /^([0-9a-f]{64}) [ *](.+)$/;

function parse(text: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line === '') {
      continue;
    }
    const match = LINE.exec(line);
    if (match === null) {
      throw new Error(`sha256sum 줄이 아닙니다: ${line.slice(0, 60)}`);
    }
    files.set(match[2] ?? '', match[1] ?? '');
  }
  if (files.size === 0) {
    throw new Error('소스 해시 목록이 비었습니다.');
  }

  return files;
}

/** 두 플랫폼의 `sha256sum` 출력에서 내용이 다르거나 한쪽에만 있는 경로(정렬) */
export function sourceDrift(a: string, b: string): string[] {
  const left = parse(a);
  const right = parse(b);
  const paths = new Set([...left.keys(), ...right.keys()]);

  return [...paths].filter((path) => left.get(path) !== right.get(path)).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
}
