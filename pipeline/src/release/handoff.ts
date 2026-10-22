import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, fchmodSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SelectCounts } from './select.ts';

/** PaaS 호스트가 읽는 manifest(4단계 설계 5.1). PaaS 호스트는 이 파일만 보고 판단하므로 ko.json 다음에 쓴다 */
export interface LangManifest {
  readonly schema: 1;
  readonly catalogVersion: string;
  readonly devCommit: string;
  readonly weblateLastChange: string;
  readonly counts: SelectCounts;
  readonly sha256: string;
  readonly builtAt: string;
}

/** 키 순서를 고정한 JSON(같은 번역이면 같은 바이트 → 같은 해시) */
export function serializeKo(ko: Readonly<Record<string, string>>): string {
  const sorted = Object.fromEntries(Object.keys(ko).sort().map((key) => [key, ko[key]]));

  return `${JSON.stringify(sorted)}\n`;
}

// 임시 이름으로 쓰고 권한을 맞춘 뒤 이름을 바꾼다: 읽는 쪽은 반쯤 쓴 파일을 보지 않는다.
// 임시 이름은 무작위이고 새로 만들 때만 연다(wx = O_CREAT|O_EXCL): 그 자리에 심어 둔 링크를 따라 쓰지 않는다
const publish = (dir: string, name: string, data: string): void => {
  const partial = join(dir, `.${name}.${randomBytes(8).toString('hex')}.partial`);
  const fd = openSync(partial, 'wx', 0o640);
  try {
    writeFileSync(fd, data);
    fchmodSync(fd, 0o640);
  } finally {
    closeSync(fd);
  }
  renameSync(partial, join(dir, name));
};

/**
 * 전달 폴더에 ko.json과 manifest.json을 쓴다. 번역이 같으면(해시 같음) 아무것도 쓰지 않는다:
 * 건너편 path 유닛이 헛돌지 않게(검토 초점 5)
 */
export function writeHandoff(dir: string, ko: Readonly<Record<string, string>>, info: Omit<LangManifest, 'schema' | 'sha256' | 'builtAt'>, now: Date): 'written' | 'same' {
  const text = serializeKo(ko);
  const sha256 = createHash('sha256').update(text).digest('hex');
  const manifestPath = join(dir, 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      if ((JSON.parse(readFileSync(manifestPath, 'utf8')) as { sha256?: unknown }).sha256 === sha256) {
        return 'same';
      }
    } catch {
      // 읽지 못하는 manifest는 새로 쓴다
    }
  }
  mkdirSync(dir, { recursive: true });
  publish(dir, 'ko.json', text);
  const manifest: LangManifest = { schema: 1, ...info, sha256, builtAt: now.toISOString() };
  publish(dir, 'manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

  return 'written';
}
