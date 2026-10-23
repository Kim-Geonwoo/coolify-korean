import { describe, expect, it } from 'vitest';
import type { PublishedLedger } from './ledger.ts';
import { runMirrorJob, type MirrorJobDeps, type MirrorStatus } from './mirrorJob.ts';

const published: PublishedLedger = { schema: 1, versions: { '4.4.6': { kind: 'ko', index: `sha256:${'a'.repeat(64)}`, commit: 'b'.repeat(40), publishedAt: '2026-10-19T00:00:00.000Z' } } };

interface Fake extends MirrorJobDeps {
  readonly calls: string[];
  readonly notices: string[];
  status: MirrorStatus;
}

function fake(options: { ready?: boolean; published?: PublishedLedger; registry?: Readonly<Record<string, string | undefined>>; registryFails?: boolean; changed?: boolean[]; issues?: string[]; push?: ('pushed' | 'rejected')[]; served?: boolean; servedFails?: boolean; syncFails?: boolean; status?: MirrorStatus; notices?: string[] } = {}): Fake {
  const calls: string[] = [];
  const notices = options.notices ?? [];
  const changed = [...(options.changed ?? [true])];
  const pushes = [...(options.push ?? ['pushed'])];
  const deps: Fake = {
    calls,
    notices,
    status: options.status ?? { failures: 0 },
    now: () => new Date('2026-10-20T00:00:00.000Z'),
    log: () => undefined,
    sync: () => {
      calls.push('sync');

      return options.syncFails === true ? Promise.reject(new Error('fetch failed')) : Promise.resolve();
    },
    siteReady: () => options.ready ?? true,
    published: () => options.published ?? published,
    registry: (version) => {
      calls.push(`registry:${version}`);
      if (options.registryFails === true) {
        return Promise.reject(new Error('GHCR 익명 토큰을 받지 못했습니다(HTTP 503).'));
      }
      const ledger = options.published ?? published;

      return Promise.resolve(options.registry !== undefined && version in options.registry ? options.registry[version] : ledger.versions[version]?.index);
    },
    cdn: () => Promise.resolve({}),
    refresh: () => {
      calls.push('refresh');

      return { changed: changed.shift() ?? false, issues: options.issues ?? [] };
    },
    push: () => {
      calls.push('push');

      return Promise.resolve(pushes.shift() ?? 'rejected');
    },
    served: () => {
      calls.push('served');

      return options.servedFails === true ? Promise.reject(new Error('fetch failed')) : Promise.resolve(options.served ?? true);
    },
    readStatus: () => deps.status,
    writeStatus: (status) => {
      deps.status = status;
    },
    notify: (message) => {
      notices.push(message);

      return Promise.resolve();
    },
  };

  return deps;
}

describe('runMirrorJob', () => {
  it('waits for the first publication from the PC', async () => {
    const deps = fake({ ready: false });

    expect(await runMirrorJob(deps)).toBe('skipped');
    expect(deps.calls).toEqual(['sync']);
  });

  it('does nothing before any version is published', async () => {
    expect(await runMirrorJob(fake({ published: { schema: 1, versions: {} } }))).toBe('skipped');
  });

  it('pushes a refreshed versions.json and checks what the site serves', async () => {
    const deps = fake();

    expect(await runMirrorJob(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['sync', 'registry:4.4.6', 'refresh', 'push', 'served']);
    expect(deps.status).toEqual({ failures: 0, lastSuccess: '2026-10-20T00:00:00.000Z' });
  });

  it('leaves the mirror alone when nothing changed', async () => {
    const deps = fake({ changed: [false] });

    expect(await runMirrorJob(deps)).toBe('unchanged');
    expect(deps.calls).toEqual(['sync', 'registry:4.4.6', 'refresh']);
  });

  it('syncs again and retries once when a publication from the PC won the race', async () => {
    const deps = fake({ changed: [true, true], push: ['rejected', 'pushed'] });

    expect(await runMirrorJob(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['sync', 'registry:4.4.6', 'refresh', 'push', 'sync', 'refresh', 'push', 'served']);
  });

  it('fails when the push is rejected twice', async () => {
    const deps = fake({ changed: [true, true], push: ['rejected', 'rejected'] });

    expect(await runMirrorJob(deps)).toBe('failed');
    expect(deps.status.failures).toBe(1);
  });

  it('fails without writing when the mirror check finds problems', async () => {
    const deps = fake({ changed: [false], issues: ['상류가 역행'] });

    expect(await runMirrorJob(deps)).toBe('failed');
    expect(deps.calls).not.toContain('push');
  });

  it('still counts a push as done when the site has not caught up yet', async () => {
    expect(await runMirrorJob(fake({ served: false }))).toBe('pushed');
  });

  // 2026-10-20 서버 첫 실행: push는 됐는데 사이트 확인이 DNS 실패로 던져 실패로 남았다
  it('still counts a push as done when the site check itself fails', async () => {
    const deps = fake({ servedFails: true });

    expect(await runMirrorJob(deps)).toBe('pushed');
    expect(deps.status.failures).toBe(0);
  });

  // 2026-10-22 보안 점검 3: GHCR 쓰기 자격이 새면 발행한 태그를 다른 이미지로 바꿀 수 있다
  describe('published tags on the registry', () => {
    const two: PublishedLedger = { schema: 1, versions: { ...published.versions, '4.4.7': { kind: 'ko', index: `sha256:${'c'.repeat(64)}`, commit: 'd'.repeat(40), publishedAt: '2026-10-23T00:00:00.000Z' } } };
    const swapped = `sha256:${'e'.repeat(64)}`;

    it('checks every published tag before touching versions.json', async () => {
      const deps = fake({ published: two });

      expect(await runMirrorJob(deps)).toBe('pushed');
      expect(deps.calls.slice(0, 3)).toEqual(['sync', 'registry:4.4.6', 'registry:4.4.7']);
    });

    it('stops and tells the owner at once when a tag points to another image', async () => {
      const deps = fake({ published: two, registry: { '4.4.7': swapped } });

      expect(await runMirrorJob(deps)).toBe('failed');
      expect(deps.calls).not.toContain('refresh');
      expect(deps.calls).not.toContain('push');
      expect(deps.notices).toHaveLength(1);
      expect(deps.notices[0]).toContain('4.4.7');
      expect(deps.notices[0]).toContain('eeeeeeeeeeee');
      expect(deps.status.failures).toBe(1);
    });

    it('treats a missing tag as a mismatch', async () => {
      const deps = fake({ published: two, registry: { '4.4.6': undefined } });

      expect(await runMirrorJob(deps)).toBe('failed');
      expect(deps.notices[0]).toContain('4.4.6');
      expect(deps.notices[0]).toContain('태그 없음');
    });

    it('tells the owner once per mismatch, again when it changes, and forgets it after a success', async () => {
      const notices: string[] = [];
      let status: MirrorStatus = { failures: 0 };
      for (const registry of [{ '4.4.7': swapped }, { '4.4.7': swapped }, { '4.4.7': undefined }]) {
        const deps = fake({ published: two, registry, status, notices });
        await runMirrorJob(deps);
        status = deps.status;
      }

      expect(notices).toHaveLength(2);
      const recovered = fake({ published: two, status, notices });
      expect(await runMirrorJob(recovered)).toBe('pushed');
      expect(recovered.status).toEqual({ failures: 0, lastSuccess: '2026-10-20T00:00:00.000Z' });
      await runMirrorJob(fake({ published: two, registry: { '4.4.7': swapped }, status: recovered.status, notices }));
      expect(notices).toHaveLength(3);
    });

    it('counts an unreachable registry as an ordinary failure', async () => {
      const deps = fake({ registryFails: true });

      expect(await runMirrorJob(deps)).toBe('failed');
      expect(deps.calls).not.toContain('push');
      expect(deps.notices).toHaveLength(0);
    });
  });

  it('tells the owner once after three failures in a row and clears it after a success', async () => {
    const notices: string[] = [];
    let status: MirrorStatus = { failures: 0 };
    for (let run = 0; run < 4; run++) {
      const deps = fake({ syncFails: true, status, notices });
      await runMirrorJob(deps);
      status = deps.status;
    }

    expect(status.failures).toBe(4);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('3번');
    const recovered = fake({ status });
    await runMirrorJob(recovered);
    expect(recovered.status).toEqual({ failures: 0, lastSuccess: '2026-10-20T00:00:00.000Z' });
  });
});
