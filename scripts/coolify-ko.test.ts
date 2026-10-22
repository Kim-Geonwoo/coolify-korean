import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = join(import.meta.dirname, 'coolify-ko.sh');
const fixtures = join(import.meta.dirname, 'fixtures', 'coolify-ko');
const REPO = 'registry.example.com/coolify-ko';
const MIRROR = 'https://mirror.example.com/versions.json';
const CUSTOM = 'docker-compose.custom.yml';

// 윈도에서는 Git Bash를 쓴다(System32의 bash.exe는 WSL이라 쓰지 않는다)
function gitUsrBin(): string | undefined {
  const bases = [process.env.ProgramFiles, process.env.ProgramW6432].filter((b): b is string => b !== undefined);
  return bases.map((b) => join(b, 'Git', 'usr', 'bin')).find((dir) => existsSync(join(dir, 'bash.exe')));
}
const winBin = process.platform === 'win32' ? gitUsrBin() : undefined;
const bash = process.platform === 'win32' ? (winBin === undefined ? undefined : join(winBin, 'bash.exe')) : 'bash';
const posix = (p: string): string => p.replaceAll('\\', '/');

interface Sandbox {
  readonly root: string;
  readonly src: string;
  readonly log: string;
  readonly env: Record<string, string>;
}

interface Run {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const sandboxes: string[] = [];
afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sandbox(options: { readonly custom?: string } = {}): Sandbox {
  const root = mkdtempSync(join(tmpdir(), 'coolify-ko-'));
  sandboxes.push(root);
  const src = join(root, 'source');
  const bin = join(root, 'bin');
  mkdirSync(src);
  mkdirSync(bin);
  copyFileSync(join(fixtures, 'source', 'docker-compose.yml'), join(src, 'docker-compose.yml'));
  copyFileSync(join(fixtures, 'source', 'docker-compose.prod.yml'), join(src, 'docker-compose.prod.yml'));
  copyFileSync(join(fixtures, 'source', 'env.txt'), join(src, '.env'));
  if (options.custom !== undefined) copyFileSync(join(fixtures, 'custom', options.custom), join(src, CUSTOM));
  for (const name of ['docker', 'id', 'curl']) {
    copyFileSync(join(fixtures, 'bin', name), join(bin, name));
    chmodSync(join(bin, name), 0o755);
  }
  const log = join(root, 'calls.log');
  writeFileSync(log, '');
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key.toUpperCase() !== 'PATH') env[key] = value;
  }
  const inherited = process.env.PATH ?? process.env.Path ?? '';
  env.PATH = [bin, ...(winBin === undefined ? [] : [winBin]), inherited].join(delimiter);
  env.COOLIFY_KO_SOURCE_DIR = posix(src);
  env.FAKE_DOCKER_LOG = posix(log);
  env.FAKE_CURL_BODY = posix(join(fixtures, 'versions.json'));
  return { root, src, log, env };
}

function run(box: Sandbox, args: readonly string[], extra: Readonly<Record<string, string>> = {}): Run {
  if (bash === undefined) throw new Error('bash가 없습니다');
  const result = spawnSync(bash, [posix(script), ...args], {
    env: { ...box.env, ...extra },
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const install = (box: Sandbox, extra: Readonly<Record<string, string>> = {}, flags: readonly string[] = []): Run =>
  run(box, ['install', '--image', REPO, '--versions-url', MIRROR, ...flags], extra);

const read = (path: string): string => readFileSync(path, 'utf8');
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const calls = (box: Sandbox): string[] => read(box.log).split('\n').filter((line) => line.length > 0);
const composeCalls = (box: Sandbox): string[] => calls(box).filter((line) => line.startsWith('docker compose '));

const createdCustom =
  '# >>> coolify-ko (managed by coolify-ko.sh)\n' +
  'services:\n' +
  '  coolify:\n' +
  `    image: "${REPO}:\${LATEST_IMAGE:?LATEST_IMAGE is required}"\n` +
  '# <<< coolify-ko\n';

const envBlock = `# >>> coolify-ko\nVERSIONS_URL=${MIRROR}\nCOOLIFY_LOCALE=ko\n# <<< coolify-ko\n`;

describe.skipIf(bash === undefined)('coolify-ko.sh', { timeout: 30_000 }, () => {
  it('install creates custom.yml when missing', () => {
    const box = sandbox();
    const original = read(join(box.src, '.env'));
    const result = install(box);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(read(join(box.src, CUSTOM))).toBe(createdCustom);
    expect(read(join(box.src, '.env'))).toBe(original + envBlock);
    expect(existsSync(join(box.src, 'coolify-ko.sh'))).toBe(true);
    const compose = composeCalls(box);
    expect(compose).toHaveLength(1);
    expect(compose[0]).toContain(`-f ${posix(join(box.src, CUSTOM))}`);
    expect(compose[0]).toMatch(/ up -d --wait --wait-timeout 300 coolify$/);
  });

  it('install inserts under existing services', () => {
    const box = sandbox({ custom: 'existing-services.yml' });
    const result = install(box);
    expect(result.status).toBe(0);
    expect(read(join(box.src, CUSTOM))).toBe(
      '# my overrides\n' +
        'services:\n' +
        '    # >>> coolify-ko (managed by coolify-ko.sh)\n' +
        '    coolify:\n' +
        `        image: "${REPO}:\${LATEST_IMAGE:?LATEST_IMAGE is required}"\n` +
        '    # <<< coolify-ko\n' +
        '    postgres:\n' +
        '        ports:\n' +
        '            - "127.0.0.1:5432:5432"\n' +
        'networks:\n' +
        '    coolify:\n' +
        '        external: true\n',
    );
  });

  it('install appends the block when services is missing', () => {
    const box = sandbox({ custom: 'no-services.yml' });
    const original = read(join(box.src, CUSTOM));
    const result = install(box);
    expect(result.status).toBe(0);
    expect(read(join(box.src, CUSTOM))).toBe(original + createdCustom);
  });

  it('install aborts on existing coolify service', () => {
    const box = sandbox({ custom: 'coolify-service.yml' });
    const before = [sha(join(box.src, CUSTOM)), sha(join(box.src, '.env'))];
    const result = install(box);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('이미 coolify 서비스가 있습니다');
    expect([sha(join(box.src, CUSTOM)), sha(join(box.src, '.env'))]).toEqual(before);
    expect(readdirSync(box.src).sort()).toEqual(['.env', CUSTOM, 'docker-compose.prod.yml', 'docker-compose.yml']);
    expect(composeCalls(box)).toEqual([]);
  });

  it('install refuses a custom.yml it cannot edit line by line', () => {
    const box = sandbox();
    writeFileSync(join(box.src, CUSTOM), 'services: {}\n');
    const result = install(box);
    expect(result.status).toBe(1);
    expect(read(join(box.src, CUSTOM))).toBe('services: {}\n');
    expect(composeCalls(box)).toEqual([]);
  });

  it('install refuses a broken marker block', () => {
    const box = sandbox();
    const broken = read(join(box.src, '.env')) + '# >>> coolify-ko\nVERSIONS_URL=https://x.example/v.json\n';
    writeFileSync(join(box.src, '.env'), broken);
    const result = install(box);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('표시 구간');
    expect(read(join(box.src, '.env'))).toBe(broken);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
  });

  it('install aborts when VERSIONS_URL is already set outside the block', () => {
    const box = sandbox();
    writeFileSync(join(box.src, '.env'), read(join(box.src, '.env')) + 'VERSIONS_URL=https://other.example/v.json\n');
    const before = sha(join(box.src, '.env'));
    const result = install(box);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('VERSIONS_URL');
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
  });

  it('install aborts when tag missing', () => {
    const box = sandbox();
    const before = sha(join(box.src, '.env'));
    const result = install(box, { FAKE_MANIFEST_STATUS: '1' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${REPO}:4.4.6`);
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
    expect(existsSync(join(box.src, '.coolify-ko-backup'))).toBe(false);
    expect(calls(box)).toContain(`docker manifest inspect ${REPO}:4.4.6`);
    expect(composeCalls(box)).toEqual([]);
  });

  it('install and uninstall refuse while an official upgrade is still restarting containers', () => {
    const box = sandbox();
    const status = join(box.src, '.upgrade-status');
    writeFileSync(status, '4|Stopping containers|2026-10-18T22:24:21+09:00\n');
    const before = sha(join(box.src, '.env'));
    const blocked = install(box);
    expect(blocked.status).toBe(1);
    expect(blocked.stderr).toContain('.upgrade-status');
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(calls(box)).toEqual([]);

    writeFileSync(status, '6|Upgrade complete|2026-10-18T22:24:50+09:00\n');
    expect(install(box).status).toBe(0);
    const installed = read(join(box.src, '.env'));

    writeFileSync(status, '5|Starting new containers|2026-10-18T22:24:33+09:00\n');
    writeFileSync(box.log, '');
    expect(run(box, ['uninstall']).status).toBe(1);
    expect(read(join(box.src, '.env'))).toBe(installed);
    expect(calls(box)).toEqual([]);
  });

  it('install aborts when the mirror does not answer', () => {
    const box = sandbox();
    const before = sha(join(box.src, '.env'));
    const result = install(box, { FAKE_CURL_STATUS: '22' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(MIRROR);
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
    expect(calls(box).filter((line) => line.startsWith('docker '))).toEqual([]);
  });

  it('install and preinstall refuse a versions.json without the coolify-ko key', () => {
    const box = sandbox();
    const upstream = join(box.root, 'upstream.json');
    const mirror = JSON.parse(read(join(fixtures, 'versions.json'))) as Record<string, unknown>;
    delete mirror['coolify-ko'];
    writeFileSync(upstream, JSON.stringify(mirror, null, 4));
    const before = sha(join(box.src, '.env'));
    expect(install(box, { FAKE_CURL_BODY: posix(upstream) }).status).toBe(1);
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);

    const fresh = join(box.root, 'fresh', 'source');
    const pre = run(box, ['preinstall', '--image', REPO, '--versions-url', MIRROR], {
      COOLIFY_KO_SOURCE_DIR: posix(fresh),
      FAKE_CURL_BODY: posix(upstream),
    });
    expect(pre.status).toBe(1);
    expect(existsSync(fresh)).toBe(false);
  });

  it('install checks a loopback registry over plain http like the docker daemon does', () => {
    const box = sandbox();
    const result = run(box, ['install', '--image', 'localhost:5000/coolify-ko', '--versions-url', MIRROR]);
    expect(result.status).toBe(0);
    expect(calls(box)).toContain('docker manifest inspect --insecure localhost:5000/coolify-ko:4.4.6');

    const remote = sandbox();
    expect(install(remote).status).toBe(0);
    expect(calls(remote).filter((line) => line.includes('--insecure'))).toEqual([]);
  });

  it('install aborts on running deployment', () => {
    const box = sandbox();
    const before = sha(join(box.src, '.env'));
    const blocked = install(box, { FAKE_PSQL_OUTPUT: '1' });
    expect(blocked.status).toBe(1);
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
    expect(calls(box).some((line) => line.startsWith('docker exec coolify-db psql -U coolify -d coolify '))).toBe(true);

    const forced = install(box, { FAKE_PSQL_OUTPUT: '1' }, ['--force']);
    expect(forced.status).toBe(0);
    expect(read(join(box.src, CUSTOM))).toBe(createdCustom);
  });

  it('install is idempotent', () => {
    const box = sandbox({ custom: 'existing-services.yml' });
    expect(install(box).status).toBe(0);
    const first = [read(join(box.src, CUSTOM)), read(join(box.src, '.env'))];
    expect(install(box).status).toBe(0);
    expect([read(join(box.src, CUSTOM)), read(join(box.src, '.env'))]).toEqual(first);
  });

  it('uninstall restores original bytes', () => {
    const withCustom = sandbox({ custom: 'existing-services.yml' });
    const before = [sha(join(withCustom.src, CUSTOM)), sha(join(withCustom.src, '.env'))];
    expect(install(withCustom).status).toBe(0);
    expect(run(withCustom, ['uninstall']).status).toBe(0);
    expect([sha(join(withCustom.src, CUSTOM)), sha(join(withCustom.src, '.env'))]).toEqual(before);
    expect(existsSync(join(withCustom.src, 'coolify-ko.sh'))).toBe(false);

    const created = sandbox();
    const envBefore = sha(join(created.src, '.env'));
    expect(install(created).status).toBe(0);
    expect(run(created, ['uninstall']).status).toBe(0);
    expect(existsSync(join(created.src, CUSTOM))).toBe(false);
    expect(sha(join(created.src, '.env'))).toBe(envBefore);
    const compose = composeCalls(created).at(-1) ?? '';
    expect(compose).not.toContain(CUSTOM);
  });

  // 최종 리뷰(2026-10-19): 윈도 편집기로 저장해 줄끝이 CRLF가 되면 구간을 못 지우고도 "되돌렸습니다"라고 했다
  it('uninstall removes the blocks from files saved with CRLF line endings', () => {
    const box = sandbox();
    expect(install(box).status).toBe(0);
    for (const name of [CUSTOM, '.env']) {
      const path = join(box.src, name);
      writeFileSync(path, read(path).replaceAll('\r\n', '\n').replaceAll('\n', '\r\n'));
    }
    const result = run(box, ['uninstall']);

    expect(result.status).toBe(0);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
    expect(read(join(box.src, '.env'))).not.toContain('coolify-ko');
    expect(read(join(box.src, '.env'))).not.toContain('VERSIONS_URL');
  });

  it('uninstall pulls official first', () => {
    const box = sandbox();
    expect(install(box).status).toBe(0);
    const installed = [read(join(box.src, CUSTOM)), read(join(box.src, '.env'))];

    const failed = run(box, ['uninstall'], { FAKE_PULL_STATUS: '1' });
    expect(failed.status).toBe(1);
    expect([read(join(box.src, CUSTOM)), read(join(box.src, '.env'))]).toEqual(installed);

    writeFileSync(box.log, '');
    expect(run(box, ['uninstall']).status).toBe(0);
    const log = calls(box);
    const pull = log.indexOf('docker pull docker.io/coollabsio/coolify:4.4.6');
    const up = log.findIndex((line) => line.startsWith('docker compose ') && line.includes(' up '));
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(pull);
  });

  it('compose failure rolls back', () => {
    const box = sandbox({ custom: 'existing-services.yml' });
    const before = [sha(join(box.src, CUSTOM)), sha(join(box.src, '.env'))];
    const result = install(box, { FAKE_COMPOSE_STATUS: '1' });
    expect(result.status).toBe(1);
    expect([sha(join(box.src, CUSTOM)), sha(join(box.src, '.env'))]).toEqual(before);
    expect(composeCalls(box)).toHaveLength(2);
    expect(existsSync(join(box.src, 'coolify-ko.sh'))).toBe(false);
  });

  // 5단계 공개: 인자 없이 설치하면 공개 이미지와 미러 주소를 쓴다
  it('install defaults to the published image and mirror', () => {
    const box = sandbox();
    const result = run(box, ['install']);
    expect(result.status).toBe(0);
    expect(read(join(box.src, CUSTOM))).toContain('image: "ghcr.io/kim-geonwoo/coolify-ko:${LATEST_IMAGE:?LATEST_IMAGE is required}"');
    expect(read(join(box.src, '.env'))).toContain('VERSIONS_URL=https://coolify-ko.geonwoo.dev/versions.json');
  });

  it('carries no publish-time placeholder any more', () => {
    expect(read(script)).not.toContain('REPLACE_AT_' + 'PUBLISH');
  });

  it('install refuses when not root', () => {
    const box = sandbox();
    const result = install(box, { FAKE_UID: '1000' });
    expect(result.status).toBe(1);
    expect(calls(box)).toEqual([]);
  });

  it('preinstall writes both files and prints the official install command', () => {
    const box = sandbox();
    const fresh = join(box.root, 'fresh', 'source');
    const result = run(box, ['preinstall', '--image', REPO, '--versions-url', MIRROR], {
      COOLIFY_KO_SOURCE_DIR: posix(fresh),
    });
    expect(result.status).toBe(0);
    expect(read(join(fresh, CUSTOM))).toBe(createdCustom);
    expect(read(join(fresh, '.env'))).toBe(envBlock);
    // 되돌리기 안내(README·배너)가 가리키는 자리에 스크립트를 둔다
    expect(read(join(fresh, 'coolify-ko.sh'))).toBe(read(script));
    expect(result.stdout).toContain('curl -fsSL https://cdn.coollabs.io/coolify/install.sh | sudo bash -s 4.4.6');
    expect(calls(box)).toContain(`curl -fsS --max-time 10 ${MIRROR}`);
  });

  it('preinstall refuses on a server that already has Coolify', () => {
    const box = sandbox();
    const before = sha(join(box.src, '.env'));
    const result = run(box, ['preinstall', '--image', REPO, '--versions-url', MIRROR]);
    expect(result.status).toBe(1);
    expect(sha(join(box.src, '.env'))).toBe(before);
    expect(existsSync(join(box.src, CUSTOM))).toBe(false);
  });

  it('status reports the blocks, the running image and the mirror', () => {
    const box = sandbox();
    expect(install(box).status).toBe(0);
    const result = run(box, ['status'], { FAKE_RUNNING_IMAGE: `${REPO}:4.4.6` });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`${REPO}:\${LATEST_IMAGE`);
    expect(result.stdout).toContain(MIRROR);
    expect(result.stdout).toContain(`${REPO}:4.4.6`);
    expect(result.stdout).toContain('coolify-ko');
  });
});
