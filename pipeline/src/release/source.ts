import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/**
 * 번역 묶기의 레포 입력. 밤 작업 작업 사본(reset·clean을 한다)과 따로, 전용 bare 클론에 dev만 받아 객체에서 읽는다
 * (검토 2026-10-18 중대 5: 두 작업이 같은 사본을 쓰면 서로 지운다)
 */
// 카탈로그가 2.4MB라 자식 프로세스 기본 버퍼(1MB)로는 잘린다(2026-10-18 서버 리허설)
const MAX_FILE_BYTES = 64 * 1024 * 1024;

const git = (gitDir: string, args: readonly string[], timeoutMs: number): { status: number | null; stdout: string; stderr: string; failed: boolean } => {
  // "파일 없음" 판정이 git 메시지 문구에 기대므로 언어를 고정한다
  // GitHub가 응답 없이 멈추면 ssh가 TCP 재시도로 2분 넘게 걸린다: 유닛 상한 안에서 실패로 끝나게 연결·생존 시간을 짧게 둔다(검토 I2)
  const env = { ...process.env, LC_ALL: 'C', GIT_SSH_COMMAND: 'ssh -o ConnectTimeout=10 -o ServerAliveInterval=5 -o ServerAliveCountMax=3' };
  const result = spawnSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs, maxBuffer: MAX_FILE_BYTES, env });

  return { status: result.status, stdout: result.stdout, stderr: result.stderr, failed: result.error !== undefined };
};

/** 원격의 dev를 bare 클론에 받고 그 커밋을 돌려준다. 클론이 없으면 만든다 */
export function fetchDev(gitDir: string, remote: string): string {
  if (!existsSync(gitDir)) {
    const init = spawnSync('git', ['init', '-q', '--bare', gitDir], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    if (init.status !== 0) {
      throw new Error('번역 묶기용 bare 클론을 만들지 못했습니다.');
    }
  }
  if (git(gitDir, ['fetch', '-q', '--depth', '1', remote, '+refs/heads/dev:refs/heads/dev'], 45_000).status !== 0) {
    throw new Error('레포 dev를 받지 못했습니다.');
  }
  const head = git(gitDir, ['rev-parse', 'refs/heads/dev'], 30_000);
  if (head.status !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) {
    throw new Error('레포 dev 커밋을 읽지 못했습니다.');
  }

  return head.stdout.trim();
}

/** 받은 dev의 파일 내용. 그 커밋에 파일이 없으면 undefined, 읽다가 실패하면(버퍼·시간 초과 등) 던진다 */
export function readDevFile(gitDir: string, path: string, ref = 'refs/heads/dev'): string | undefined {
  const shown = git(gitDir, ['show', `${ref}:${path}`], 30_000);
  if (!shown.failed && shown.status === 0) {
    return shown.stdout;
  }
  if (!shown.failed && /does not exist|exists on disk, but not in/.test(shown.stderr)) {
    return undefined;
  }
  throw new Error(`레포 dev의 ${path}를 읽지 못했습니다.`);
}
