import { describe, expect, it } from 'vitest';
import type { WeblateUnit } from '../weblate/client.ts';
import { runReleaseBuild, type ReleaseDeps, type ReleaseState } from './buildCli.ts';

const repo: Record<string, string> = {
  'i18n/catalog.json': JSON.stringify({ version: '4.4.6', keys: { Save: { english: 'Save', kinds: ['text'], placeholders: [] }, Cancel: { english: 'Cancel', kinds: ['text'], placeholders: [] } } }),
  'i18n/drafts/ko.json': JSON.stringify({ Save: '저장 초안', Cancel: '취소 초안' }),
  'i18n/drafts/ko.meta.json': JSON.stringify({}),
  'i18n/exclude.json': JSON.stringify({ keys: {} }),
  'i18n/verbatim.json': JSON.stringify({ literals: [] }),
  'i18n/release.json': JSON.stringify({ mode: 'drafts' }),
  'i18n/reviewed/ko.json': JSON.stringify({}),
  'i18n/reviewed/ko.meta.json': JSON.stringify({}),
};
const approvedSave: WeblateUnit = { id: 1, key: 'Save', source: 'Save', target: '저장', state: 30 };

const fake = (over: Partial<ReleaseDeps> & { files?: Record<string, string>; state?: ReleaseState }): { deps: ReleaseDeps; written: Record<string, string>[]; states: ReleaseState[]; notes: string[]; unitCalls: () => number } => {
  const written: Record<string, string>[] = [];
  const states: ReleaseState[] = [];
  const notes: string[] = [];
  let calls = 0;
  let state = over.state;
  const files = over.files ?? repo;
  const deps: ReleaseDeps = {
    now: () => new Date('2026-10-18T10:00:00Z'),
    fetchDev: () => 'c'.repeat(40),
    lastChange: () => Promise.resolve('2026-10-18T09:00:00Z'),
    units: () => {
      calls++;

      return Promise.resolve([approvedSave]);
    },
    readDev: (_commit, path) => files[path],
    previousApproved: () => undefined,
    write: (ko) => {
      written.push({ ...ko });

      return 'written';
    },
    readState: () => state,
    writeState: (next) => {
      state = next;
      states.push(next);
    },
    notify: (message) => Promise.resolve(void notes.push(message)),
    ...over,
  };

  return { deps, written, states, notes, unitCalls: () => calls };
};

describe('runReleaseBuild', () => {
  it('bundles the approval over the draft and remembers what it was built from', async () => {
    const { deps, written, states } = fake({});
    const result = await runReleaseBuild(deps);

    expect(result).toMatchObject({ kind: 'written', counts: { approved: 1, pending: 0, drafts: 1, english: 0 } });
    expect(written).toEqual([{ Cancel: '취소 초안', Save: '저장' }]);
    expect(states.at(-1)).toEqual({ lastChange: '2026-10-18T09:00:00Z', devCommit: 'c'.repeat(40), builtAt: '2026-10-18T10:00:00.000Z', failures: 0 });
  });

  it('does not read Weblate units when neither Weblate nor dev changed within the hour', async () => {
    const state = { lastChange: '2026-10-18T09:00:00Z', devCommit: 'c'.repeat(40), builtAt: '2026-10-18T09:30:00.000Z', failures: 0 };
    const { deps, unitCalls, written } = fake({ state });

    expect(await runReleaseBuild(deps)).toEqual({ kind: 'skipped' });
    expect(unitCalls()).toBe(0);
    expect(written).toEqual([]);
  });

  it('rebuilds once an hour even when nothing seems to have changed', async () => {
    const state = { lastChange: '2026-10-18T09:00:00Z', devCommit: 'c'.repeat(40), builtAt: '2026-10-18T08:59:00.000Z', failures: 0 };
    const { deps } = fake({ state });

    expect((await runReleaseBuild(deps)).kind).toBe('written');
  });

  it('keeps the last file when Weblate cannot be read, counts the failures and tells Discord once, on the third', async () => {
    let state: ReleaseState | undefined;
    const notes: string[] = [];
    for (let run = 0; run < 4; run++) {
      const { deps, written } = fake({ lastChange: () => Promise.reject(new Error('HTTP 502')), notify: (message) => Promise.resolve(void notes.push(message)), ...(state === undefined ? {} : { state }) });
      const result = await runReleaseBuild({ ...deps, writeState: (next) => void (state = next) });

      expect(result.kind).toBe('kept');
      expect(written).toEqual([]);
    }

    expect(state?.failures).toBe(4);
    expect(notes).toHaveLength(1);
  });

  it('stops instead of publishing when approvals drop sharply (component re-created, old backup restored), unless allowed once', async () => {
    const { deps, written, notes } = fake({ previousApproved: () => 20, state: { lastChange: '', devCommit: '', builtAt: '', failures: 2 } });
    const result = await runReleaseBuild(deps);

    expect(result.kind).toBe('kept');
    expect(written).toEqual([]);
    expect(notes).toHaveLength(1);
    const allowed = fake({ previousApproved: () => 20, allowShrink: true });

    expect((await runReleaseBuild(allowed.deps)).kind).toBe('written');
  });

  it('stops when Weblate returns far fewer units than the catalog has keys', async () => {
    const { deps, written } = fake({ units: () => Promise.resolve([]) });

    expect((await runReleaseBuild(deps)).kind).toBe('kept');
    expect(written).toEqual([]);
  });

  it('counts a run as failed before touching the network, so a run killed by the time limit still counts and alerts later', async () => {
    let seenWhileWorking: ReleaseState | undefined;
    let state: ReleaseState | undefined = { lastChange: 'x', devCommit: 'y', builtAt: '2026-10-18T00:00:00.000Z', failures: 2 };
    const killed = fake({ state });
    await runReleaseBuild({
      ...killed.deps,
      writeState: (next) => void (state = next),
      fetchDev: () => {
        seenWhileWorking = state;

        return 'c'.repeat(40);
      },
    });

    expect(seenWhileWorking?.failures).toBe(3);
    const notes: string[] = [];
    const after = fake({ state: { lastChange: 'x', devCommit: 'y', builtAt: '2026-10-18T00:00:00.000Z', failures: 3 }, lastChange: () => Promise.reject(new Error('timeout')), notify: (message) => Promise.resolve(void notes.push(message)) });
    await runReleaseBuild(after.deps);

    expect(notes).toHaveLength(1);
  });

  it('treats a damaged state file as no state', async () => {
    const { deps } = fake({ state: { lastChange: 1, devCommit: null, builtAt: 'x', failures: 'many' } as unknown as ReleaseState });

    expect((await runReleaseBuild(deps)).kind).toBe('written');
  });

  it('puts only approvals in the file when the release switch says reviewed', async () => {
    const { deps, written } = fake({ files: { ...repo, 'i18n/release.json': JSON.stringify({ mode: 'reviewed' }) } });
    await runReleaseBuild(deps);

    expect(written).toEqual([{ Save: '저장' }]);
  });
});
