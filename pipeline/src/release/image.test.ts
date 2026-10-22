import { describe, expect, it } from 'vitest';
import { configDigestOf, imageKey, imageStepTimeout, isCompleteManifest, retired, trustMessage } from './image.ts';

const ids = ['a'.repeat(40), 'b'.repeat(40)];

describe('imageKey', () => {
  it('names an image by version and a hash of what goes into it, so the same inputs never build twice', () => {
    const key = imageKey('4.4.6', 'docker.io/coollabsio/coolify:4.4.6@sha256:' + 'c'.repeat(64), ids);

    expect(key).toMatch(/^4\.4\.6-[0-9a-f]{12}$/);
    expect(imageKey('4.4.6', 'docker.io/coollabsio/coolify:4.4.6@sha256:' + 'c'.repeat(64), ids)).toBe(key);
    expect(imageKey('4.4.6', 'docker.io/coollabsio/coolify:4.4.6@sha256:' + 'd'.repeat(64), ids)).not.toBe(key);
    expect(imageKey('4.4.6', 'docker.io/coollabsio/coolify:4.4.6@sha256:' + 'c'.repeat(64), ['a'.repeat(40), 'e'.repeat(40)])).not.toBe(key);
  });

  it('refuses a version or object id that could make an odd folder or tag name', () => {
    expect(() => imageKey('../4.4.6', 'x', ids)).toThrow('버전');
    expect(() => imageKey('4.4.6', 'x', ['not-a-git-id'])).toThrow('git 객체');
  });
});

describe('retired', () => {
  it('keeps the newest three builds and anything younger than a week, and lists the rest for removal', () => {
    const now = Date.parse('2026-10-30T00:00:00Z');
    const dirs = [
      { name: '4.4.4-aaaaaaaaaaaa', builtAt: '2026-10-01T00:00:00Z' },
      { name: '4.4.5-bbbbbbbbbbbb', builtAt: '2026-10-02T00:00:00Z' },
      { name: '4.4.6-cccccccccccc', builtAt: '2026-10-25T00:00:00Z' },
      { name: '4.4.6-dddddddddddd', builtAt: '2026-10-26T00:00:00Z' },
      { name: '4.4.6-eeeeeeeeeeee', builtAt: '2026-10-27T00:00:00Z' },
      { name: '4.4.7-ffffffffffff', builtAt: '2026-10-28T00:00:00Z' },
    ];

    expect(retired(dirs, now).sort()).toEqual(['4.4.4-aaaaaaaaaaaa', '4.4.5-bbbbbbbbbbbb']);
    expect(retired(dirs.slice(0, 2), now)).toEqual([]);
  });
});

describe('configDigestOf', () => {
  it('reads the image config digest from the manifest docker save writes, in both archive layouts', () => {
    const hex = 'a'.repeat(64);

    expect(configDigestOf(JSON.stringify([{ Config: `blobs/sha256/${hex}`, RepoTags: ['coolify-ko:x'], Layers: [] }]))).toBe(`sha256:${hex}`);
    expect(configDigestOf(JSON.stringify([{ Config: `${hex}.json`, RepoTags: ['coolify-ko:x'], Layers: [] }]))).toBe(`sha256:${hex}`);
    expect(() => configDigestOf('[]')).toThrow('설정');
    expect(() => configDigestOf(JSON.stringify([{ Config: '../etc/passwd' }]))).toThrow('설정');
  });
});

describe('isCompleteManifest', () => {
  it('counts an earlier build without the config digest as not built, so it is made again with it', () => {
    const digest = `sha256:${'b'.repeat(64)}`;

    expect(isCompleteManifest(JSON.stringify({ schema: 1, configDigest: digest }))).toBe(true);
    expect(isCompleteManifest(JSON.stringify({ schema: 1, imageId: digest }))).toBe(false);
    expect(isCompleteManifest('not json')).toBe(false);
  });
});

describe('imageStepTimeout', () => {
  it('gives each docker step at most what is left before the night deadline, minus a margin, and refuses when too little is left', () => {
    const now = 1_000_000;

    expect(imageStepTimeout(40 * 60_000, now + 120 * 60_000, now)).toBe(40 * 60_000);
    expect(imageStepTimeout(40 * 60_000, now + 20 * 60_000, now)).toBe(15 * 60_000);
    expect(() => imageStepTimeout(40 * 60_000, now + 6 * 60_000, now)).toThrow('시간');
  });
});

describe('trustMessage', () => {
  // PaaS 호스트의 승인 명령은 레포가 아니라 서버 설정(/srv/coolify-ko/config/trust-command)에서 온다(공개 레포에 내부 이름을 남기지 않게)
  const commit = '1234567890abcdef1234567890abcdef12345678';
  const id = `sha256:${'f'.repeat(64)}`;

  it('tells the user the one command that lets the image into the PaaS', () => {
    // 이미지 id 대신 설정 다이제스트: Docker 이미지 저장소 종류(containerd·기존)와 상관없이 같은 값이다
    expect(trustMessage('4.4.6', id, commit, 'sudo -u paas paas-host ko trust')).toContain(`sudo -u paas paas-host ko trust 4.4.6 ${id}`);
    expect(trustMessage('4.4.6', id, commit, 'sudo -u paas paas-host ko trust')).toContain('1234567');
    expect(() => trustMessage('4.4.6', 'sha256:short', 'x')).toThrow('이미지 id');
  });

  it('gives the values to approve when the server has no command configured', () => {
    expect(trustMessage('4.4.6', id, commit)).toContain(`4.4.6 ${id}`);
  });

  it('refuses a configured command that could add another line or command', () => {
    expect(() => trustMessage('4.4.6', id, commit, 'ko trust; rm -rf /')).toThrow();
    expect(() => trustMessage('4.4.6', id, commit, 'ko trust\nmore')).toThrow();
  });
});
