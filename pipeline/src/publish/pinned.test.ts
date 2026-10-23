import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINNED_RAW, SITE_URL } from './site.ts';

/**
 * 2026-10-22 보안 점검 4: 설치 스크립트 해시와 cosign 공개 키를 사이트가 아니라 공개 레포(GitHub)에서 받게 한다.
 * 서버는 공개 레포에 쓸 수 없으니, 사이트(미러 배포 키)가 뚫려도 레포의 해시·키로 바뀐 것을 알아챈다
 */
const root = join(import.meta.dirname, '..', '..', '..');
const read = (path: string): string => readFileSync(join(root, path), 'utf8');

describe('pinned install checks', () => {
  it('keeps the committed script hash equal to the script', () => {
    const hash = createHash('sha256').update(readFileSync(join(root, 'scripts', 'coolify-ko.sh'))).digest('hex');

    expect(read('scripts/coolify-ko.sh.sha256')).toBe(`${hash}  coolify-ko.sh\n`);
  });

  it('tells readers to check the script hash and the signing key from the public repository', () => {
    for (const path of ['README.md', 'docs/install.md']) {
      const text = read(path);

      expect(text, path).toContain(`curl -fsSL ${PINNED_RAW}/scripts/coolify-ko.sh.sha256 | sha256sum -c -`);
      expect(text, path).not.toContain(`${SITE_URL}/coolify-ko.sh.sha256`);
    }
    expect(read('docs/install.md')).toContain(`cosign verify --key ${PINNED_RAW}/releases/cosign.pub`);
    expect(read('docs/install.md')).not.toContain(`--key ${SITE_URL}/cosign.pub`);
  });
});
