import { describe, expect, it } from 'vitest';
import { runNight, type NightDeps, type NightOutcome, type PublishPlan } from './night.ts';
import type { SyncState } from './state.ts';
import { emptyStatus, type JobEvent, type JobStatus } from './status.ts';
import type { UpstreamDecision } from './upstream.ts';

const D = `sha256:${'c'.repeat(64)}`;
const state: SyncState = { upstream: { version: '4.4.6', image: 'docker.io/coollabsio/coolify', digest: `sha256:${'a'.repeat(64)}` } };

interface Fake extends NightDeps {
  readonly calls: string[];
  readonly events: JobEvent[];
  savedStatus: JobStatus;
  savedState: SyncState;
}

function fake(options: { decision?: UpstreamDecision; resources?: { memFreeGiB: number; diskFreeGiB: number }; fail?: string; status?: JobStatus; changed?: boolean; weekday?: number; queueEmpty?: boolean; pullRequest?: string; weblate?: { changed: boolean; rejected: string[] } | 'fail'; screenshots?: 'ok' | 'fail'; releaseImage?: 'ok' | 'fail' | 'skipped'; publishPlan?: PublishPlan | 'fail'; pending?: number; draftsLeft?: number } = {}): Fake {
  const calls: string[] = [];
  const events: JobEvent[] = [];
  const step = (name: string) => (): Promise<void> => {
    calls.push(name);

    return options.fail === name ? Promise.reject(new Error(`${name} 실패`)) : Promise.resolve();
  };
  const deps: Fake = {
    calls,
    events,
    savedStatus: options.status ?? emptyStatus(),
    savedState: state,
    now: () => new Date(`2026-10-${String(18 + (options.weekday ?? 0))}T00:15:00+09:00`),
    log: () => undefined,
    readStatus: () => deps.savedStatus,
    writeStatus: (s) => {
      deps.savedStatus = s;
    },
    readState: () => deps.savedState,
    writeState: (s) => {
      deps.savedState = s;
      calls.push(`state ${s.upstream.version}`);
    },
    resetWorkcopy: step('reset'),
    resources: () => Promise.resolve(options.resources ?? { memFreeGiB: 20, diskFreeGiB: 80 }),
    upstream: () => {
      calls.push('upstream');

      return Promise.resolve(options.decision ?? { action: 'same' });
    },
    extract: step('extract'),
    drafts: () => {
      calls.push('drafts');

      return options.fail === 'drafts' ? Promise.reject(new Error('drafts 실패')) : Promise.resolve({ added: 2, changed: 0, removed: 1, drafted: 2, fallbacks: 0, normalized: 1, pending: options.draftsLeft ?? 0 });
    },
    ...(options.pending === undefined
      ? {}
      : {
          pendingDrafts: () => {
            calls.push('pending');

            return Promise.resolve(options.pending ?? 0);
          },
        }),
    review: () => {
      calls.push('review');

      return Promise.resolve({ reviewed: 25, queueEmpty: options.queueEmpty ?? false });
    },
    ...(options.weblate === undefined
      ? {}
      : {
          weblate: () => {
            calls.push('weblate');

            return options.weblate === 'fail' ? Promise.reject(new Error('weblate down')) : Promise.resolve(options.weblate ?? { changed: false, rejected: [] });
          },
        }),
    ...(options.releaseImage === undefined
      ? {}
      : {
          releaseImage: () => {
            calls.push('release-image');

            return options.releaseImage === 'fail' ? Promise.reject(new Error('build failed')) : Promise.resolve(options.releaseImage === 'skipped' ? 'skipped' : 'ready');
          },
        }),
    ...(options.publishPlan === undefined
      ? {}
      : {
          publishPlan: (input) => {
            calls.push(`publish-plan ${input.upstream.version} ${input.gates}`);
            const plan = options.publishPlan;

            return plan === 'fail' || plan === undefined ? Promise.reject(new Error('cdn down')) : Promise.resolve(plan);
          },
        }),
    ...(options.screenshots === undefined
      ? {}
      : {
          screenshots: () => {
            calls.push('screenshots');

            return options.screenshots === 'fail' ? Promise.reject(new Error('instance did not start')) : Promise.resolve();
          },
        }),
    hasChanges: () => Promise.resolve(options.changed ?? true),
    verify: step('verify'),
    commitAndPush: (message) => {
      calls.push(`push ${message}`);

      return options.fail === 'push' ? Promise.reject(new Error('rejected')) : Promise.resolve(options.pullRequest);
    },
    notify: (event) => {
      events.push(event);

      return Promise.resolve();
    },
    compareUrl: 'https://github.com/Kim-Geonwoo/coolify-ko/compare/dev...bot/i18n',
  };

  return deps;
}

describe('runNight', () => {
  it('processes a new version end to end and announces it', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D } });

    const outcome: NightOutcome = await runNight(deps);

    expect(deps.calls).toEqual(['reset', 'upstream', 'state 4.4.7', 'extract', 'drafts', 'review', 'verify', 'push i18n: 4.4.7 초안']);
    expect(deps.events).toEqual([{ type: 'version', version: '4.4.7', added: 2, changed: 0, removed: 1, drafted: 2, fallbacks: 0, normalized: 1, pending: 0, compare: deps.compareUrl }]);
    expect(outcome).toBe('pushed');
    expect(deps.savedStatus.lastSuccess).toBeDefined();
  });

  // 2026-10-24: 4.5.0 새 키 631개가 한 밤 상한을 넘었다. 마감 전에 멈춘 만큼 올리고, 다음 밤에 나머지를 잇는다
  it('pushes what it drafted before the deadline and says how many keys are left', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.5.0', digest: D }, draftsLeft: 400 });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls).toContain('push i18n: 4.5.0 초안');
    expect(deps.events[0]).toMatchObject({ type: 'version', version: '4.5.0', pending: 400 });
  });

  it('carries on drafting the current version on a later night while keys are left', async () => {
    const deps = fake({ pending: 400, draftsLeft: 170 });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['reset', 'upstream', 'pending', 'drafts', 'review', 'verify', 'push i18n: 4.4.6 초안 이어서']);
    expect(deps.events[0]).toMatchObject({ type: 'version', version: '4.4.6', pending: 170 });
  });

  it('leaves the engine off on a night with no keys left', async () => {
    const deps = fake({ pending: 0 });

    await runNight(deps);

    expect(deps.calls.slice(0, 4)).toEqual(['reset', 'upstream', 'pending', 'review']);
    expect(deps.calls).not.toContain('drafts');
  });

  it('links the pull request the push opened instead of the compare page', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, pullRequest: 'https://github.com/Kim-Geonwoo/coolify-ko/pull/9' });

    await runNight(deps);

    expect(deps.events[0]).toMatchObject({ type: 'version', compare: 'https://github.com/Kim-Geonwoo/coolify-ko/pull/9' });
  });

  it('keeps pushing the drafts of the night when Weblate fails, and reports the failure', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, weblate: 'fail' });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['reset', 'upstream', 'state 4.4.7', 'extract', 'drafts', 'review', 'weblate', 'verify', 'push i18n: 4.4.7 초안']);
    expect(deps.events[0]).toEqual({ type: 'failure', stage: 'weblate', code: 'error', count: 1, disabled: false });
    expect(deps.savedStatus.failures.weblate?.count).toBe(1);
  });

  it('pushes reviewed translations the same night, and reports approved strings it had to leave out', async () => {
    const deps = fake({ weekday: 2, weblate: { changed: true, rejected: ['Delete :name?'] } });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['reset', 'upstream', 'review', 'weblate', 'verify', 'push i18n: 검수 결과']);
    expect(deps.events).toEqual([{ type: 'rejected', keys: ['Delete :name?'] }]);
  });

  it('takes screenshots after the push, and a failure there only reports without changing the result', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, weblate: { changed: false, rejected: [] }, screenshots: 'fail' });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls).toEqual(['reset', 'upstream', 'state 4.4.7', 'extract', 'drafts', 'review', 'weblate', 'verify', 'push i18n: 4.4.7 초안', 'screenshots']);
    expect(deps.events.at(-1)).toEqual({ type: 'failure', stage: 'screenshots', code: 'error', count: 1, disabled: false });
    expect(deps.savedStatus.failures.screenshots?.count).toBe(1);
  });

  it('builds the Korean release image after the push and before screenshots, and a failure only reports', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, weblate: { changed: false, rejected: [] }, releaseImage: 'fail', screenshots: 'ok' });

    expect(await runNight(deps)).toBe('pushed');
    expect(deps.calls.slice(-2)).toEqual(['release-image', 'screenshots']);
    expect(deps.events).toContainEqual({ type: 'failure', stage: 'release-image', code: 'error', count: 1, disabled: false });
  });

  it('builds the release image even on a night the Weblate stage failed (it only needs the merged dev)', async () => {
    const deps = fake({ weekday: 2, weblate: 'fail', releaseImage: 'ok' });

    await runNight(deps);
    expect(deps.calls).toContain('release-image');
  });

  it('skips a disabled release-image stage', async () => {
    const deps = fake({ weekday: 2, releaseImage: 'ok', status: { failures: {}, disabled: ['release-image'] } });

    await runNight(deps);
    expect(deps.calls).not.toContain('release-image');
  });

  it('does not take screenshots on a night the Weblate stage failed (new strings are not in Weblate yet)', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, weblate: 'fail', screenshots: 'ok' });

    await runNight(deps);
    expect(deps.calls).not.toContain('screenshots');
  });

  it('reports the same left-out approvals once, not every night', async () => {
    const deps = fake({ weekday: 2, weblate: { changed: false, rejected: ['Delete :name?'] } });

    await runNight(deps);
    await runNight(deps);
    expect(deps.events.filter((event) => event.type === 'rejected')).toEqual([{ type: 'rejected', keys: ['Delete :name?'] }]);
  });

  it('skips a disabled screenshots stage', async () => {
    const deps = fake({ weblate: { changed: false, rejected: [] }, screenshots: 'ok', status: { failures: {}, disabled: ['screenshots'] } });

    await runNight(deps);
    expect(deps.calls).not.toContain('screenshots');
  });

  it('skips a disabled Weblate stage', async () => {
    const deps = fake({ weekday: 2, weblate: { changed: true, rejected: [] }, status: { failures: {}, disabled: ['weblate'] } });

    await runNight(deps);

    expect(deps.calls).not.toContain('weblate');
  });

  it('on a quiet night only reviews, and commits review results once a week or when the queue is empty', async () => {
    const weekday = fake({ weekday: 1 });
    expect(await runNight(weekday)).toBe('reviewed');
    expect(weekday.calls).toEqual(['reset', 'upstream', 'review']);

    const sunday = fake({ weekday: 0 });
    expect(await runNight(sunday)).toBe('pushed');
    expect(sunday.calls).toEqual(['reset', 'upstream', 'review', 'verify', 'push i18n: 검토 결과']);

    const emptied = fake({ weekday: 3, queueEmpty: true });
    expect(await runNight(emptied)).toBe('pushed');
  });

  it('postpones when memory or disk is short, before touching anything', async () => {
    const deps = fake({ resources: { memFreeGiB: 6, diskFreeGiB: 80 } });

    expect(await runNight(deps)).toBe('postponed');
    expect(deps.calls).toEqual(['reset']);
    expect(deps.events).toEqual([{ type: 'failure', stage: 'resources', code: 'low-memory', count: 1, disabled: false }]);
  });

  it('takes memory and disk limits from the caller (rehearsals force a shortage this way)', async () => {
    const deps = { ...fake(), limits: { memoryGiB: 100, diskGiB: 40 } };

    expect(await runNight(deps)).toBe('postponed');
  });

  it('stops on an upstream anomaly and keeps quiet once that stage is off', async () => {
    const deps = fake({ decision: { action: 'stop', reason: 'regress', detail: '4.4.6 → 4.4.5' } });

    for (let night = 0; night < 4; night++) {
      await runNight(deps);
    }

    expect(deps.events.filter((e) => e.type === 'stop')).toHaveLength(3);
    expect(deps.savedStatus.disabled).toEqual(['upstream']);
  });

  it('records a failing stage with a short code, keeps the old state and does not push', async () => {
    const deps = fake({ decision: { action: 'new', version: '4.4.7', digest: D }, fail: 'extract' });

    expect(await runNight(deps)).toBe('failed');
    expect(deps.calls).toEqual(['reset', 'upstream', 'state 4.4.7', 'extract']);
    expect(deps.events).toEqual([{ type: 'failure', stage: 'extract', code: 'error', count: 1, disabled: false }]);
    expect(deps.savedStatus.failures.extract?.count).toBe(1);
  });

  it('skips a disabled stage', async () => {
    const deps = fake({ status: { failures: {}, disabled: ['review'] }, weekday: 0 });

    await runNight(deps);

    expect(deps.calls).not.toContain('review');
  });
});

describe('runNight publish plan', () => {
  const quiet: PublishPlan = { candidate: { kind: 'none', reason: 'waiting' }, hookIssues: [], hookFingerprint: 'f1', announce: false };

  it('remembers when it first saw an upstream version and passes the gate result', async () => {
    const deps = fake({ decision: { action: 'wait', version: '4.4.7', reason: 'no-image' }, releaseImage: 'ok', publishPlan: quiet });
    await runNight(deps);

    expect(deps.calls).toContain('publish-plan 4.4.7 passed');
    expect(deps.savedStatus.upstreamSeen).toEqual({ version: '4.4.7', at: '2026-10-17T15:15:00.000Z' });
  });

  it('keeps the first-seen time on later nights', async () => {
    const deps = fake({ decision: { action: 'wait', version: '4.4.7', reason: 'no-image' }, publishPlan: quiet, status: { ...emptyStatus(), upstreamSeen: { version: '4.4.7', at: '2026-10-10T00:00:00.000Z' } } });
    await runNight(deps);

    expect(deps.savedStatus.upstreamSeen?.at).toBe('2026-10-10T00:00:00.000Z');
    expect(deps.calls).toContain('publish-plan 4.4.7 unknown');
  });

  it('treats a skipped image as unknown gates and a failed one as failed', async () => {
    const skipped = fake({ releaseImage: 'skipped', publishPlan: quiet });
    await runNight(skipped);
    const failed = fake({ releaseImage: 'fail', publishPlan: quiet });
    await runNight(failed);

    expect(skipped.calls).toContain('publish-plan 4.4.6 unknown');
    expect(failed.calls).toContain('publish-plan 4.4.6 failed');
  });

  it('does not fail the night when the plan fails, and still takes screenshots', async () => {
    const deps = fake({ weblate: { changed: false, rejected: [] }, publishPlan: 'fail', screenshots: 'ok' });

    expect(await runNight(deps)).not.toBe('failed');
    expect(deps.calls.slice(-2)).toEqual(['publish-plan 4.4.6 unknown', 'screenshots']);
    expect(deps.savedStatus.failures['publish-plan']?.count).toBe(1);
  });

  it('announces install hook problems once, whatever the publish switch says', async () => {
    const broken: PublishPlan = { ...quiet, hookIssues: ['upgrade.sh가 LATEST_IMAGE를 docker compose에 넘기지 않음'] };
    const first = fake({ publishPlan: broken });
    await runNight(first);
    const second = fake({ publishPlan: broken, status: first.savedStatus });
    await runNight(second);

    expect(first.events.filter((event) => event.type === 'hooks')).toHaveLength(1);
    expect(second.events.filter((event) => event.type === 'hooks')).toHaveLength(0);
  });

  it('asks for a look when hook lines change but still pass', async () => {
    const first = fake({ publishPlan: quiet });
    await runNight(first);
    const second = fake({ publishPlan: { ...quiet, hookFingerprint: 'f2' }, status: first.savedStatus });
    await runNight(second);

    expect(first.events.some((event) => event.type === 'hooks-changed')).toBe(false);
    expect(second.events.filter((event) => event.type === 'hooks-changed')).toHaveLength(1);
  });

  it('keeps candidates quiet while publishing is switched off', async () => {
    const deps = fake({ publishPlan: { ...quiet, candidate: { kind: 'ko', version: '4.4.6', commit: 'c'.repeat(40) } } });
    await runNight(deps);

    expect(deps.events.some((event) => event.type === 'candidate')).toBe(false);
  });

  it('announces a new candidate once when publishing is switched on', async () => {
    const plan: PublishPlan = { ...quiet, announce: true, candidate: { kind: 'passthrough', version: '4.4.7' } };
    const first = fake({ publishPlan: plan });
    await runNight(first);
    const second = fake({ publishPlan: plan, status: first.savedStatus });
    await runNight(second);

    expect(first.events.filter((event) => event.type === 'candidate')).toEqual([{ type: 'candidate', kind: 'passthrough', version: '4.4.7' }]);
    expect(second.events.filter((event) => event.type === 'candidate')).toHaveLength(0);
  });
});
