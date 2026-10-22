import { readFileSync } from 'node:fs';

const BOM = 0xfeff;

/**
 * .env에서 비밀값 하나를 읽는다. process.env에 넣지 않아 자식 프로세스로 새지 않고, 값은 어디에도 출력하지 않는다.
 * BOM·CRLF·감싼 따옴표를 처리한다. 없으면 이름만 알리는 오류를 낸다.
 */
export function readSecret(path: string, name: string): string {
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${name}를 읽을 .env가 없습니다(${path}).`);
  }
  const body = content.charCodeAt(0) === BOM ? content.slice(1) : content;
  for (const line of body.split(/\r?\n/)) {
    if (!line.startsWith(`${name}=`)) {
      continue;
    }
    const value = line.slice(name.length + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    if (value !== '') {
      return value;
    }
  }
  throw new Error(`${name}가 .env에 없거나 비어 있습니다.`);
}
