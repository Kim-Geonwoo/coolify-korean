import { describe, expect, it } from 'vitest';
import { WeblateError } from './client.ts';
import { planScreenshots, screenName, uploadScreenshots } from './screenshots.ts';

const sourceUnits = new Map([
  ['Save', 101],
  ['Cancel', 102],
  ['Servers', 103],
  ['Delete', 104],
]);

describe('planScreenshots', () => {
  it('creates one screenshot per new page, linked to the source strings found on it', () => {
    const plan = planScreenshots({ pages: [{ path: '/servers', file: 'p1.png', keys: ['Servers', 'Save', 'Save'] }], existing: [], sourceUnits });

    expect(plan).toEqual({ create: [{ name: '/servers', file: 'p1.png', unitIds: [101, 103] }], replace: [] });
  });

  it('swaps the image of a page shot before and fixes its links instead of adding a second one', () => {
    const plan = planScreenshots({ pages: [{ path: '/servers', file: 'p1.png', keys: ['Servers', 'Cancel'] }], existing: [{ id: 7, name: '/servers', unitIds: [103, 104] }], sourceUnits });

    expect(plan).toEqual({ create: [], replace: [{ id: 7, name: '/servers', file: 'p1.png', link: [102], unlink: [104] }] });
  });

  it('skips pages without any known string and keeps screenshots of pages not reached this time', () => {
    const plan = planScreenshots({ pages: [{ path: '/login', file: 'p0.png', keys: ['. Email is managed by your SSO provider.'] }], existing: [{ id: 9, name: '/team', unitIds: [101] }], sourceUnits });

    expect(plan).toEqual({ create: [], replace: [] });
  });
});

describe('uploadScreenshots', () => {
  const calls: string[] = [];
  const client = {
    units: () => Promise.resolve([...sourceUnits].map(([key, id]) => ({ id, key, source: key, target: key, state: 100 }))),
    screenshots: () => Promise.resolve([{ id: 7, name: '/servers', unitIds: [103, 104] }]),
    createScreenshot: (_p: string, _c: string, lang: string, name: string, png: Uint8Array) => {
      calls.push(`create ${lang} ${name} ${String(png.length)}`);

      return Promise.resolve(8);
    },
    replaceScreenshotImage: (id: number) => {
      calls.push(`replace ${String(id)}`);

      return Promise.resolve();
    },
    linkScreenshot: (id: number, unit: number) => {
      calls.push(`link ${String(id)} ${String(unit)}`);

      return Promise.resolve();
    },
    unlinkScreenshot: (id: number, unit: number) => {
      calls.push(`unlink ${String(id)} ${String(unit)}`);

      return Promise.resolve();
    },
  };

  it('creates new page shots on the source language, swaps old ones and fixes links', async () => {
    calls.length = 0;
    const report = await uploadScreenshots(client, {
      pages: [
        { path: '/servers', file: 'a.png', keys: ['Servers'] },
        { path: '/team', file: 'b.png', keys: ['Save', 'Cancel'] },
      ],
      readImage: () => new Uint8Array(3),
    });

    expect(calls).toEqual(['create en /team 3', 'link 8 101', 'link 8 102', 'replace 7', 'unlink 7 104']);
    expect(report).toEqual({ created: 1, replaced: 1, linked: 2, unlinked: 1, skipped: 0 });
  });

  it('stops without touching Weblate when nothing was captured', async () => {
    calls.length = 0;
    await expect(uploadScreenshots(client, { pages: [], readImage: () => new Uint8Array(3) })).rejects.toThrow('0쪽');
    expect(calls).toEqual([]);
  });
});

describe('screenName', () => {
  it('replaces record ids in a page path, so the same screen keeps one screenshot across fresh test instances', () => {
    expect(screenName('/server/bulajpaicdzqi0jx0fe7qzar/analytics')).toBe('/server/{id}/analytics');
    expect(screenName('/project/0b6c1d2e-3f40-4a5b-8c7d-9e0f1a2b3c4d/environment/12')).toBe('/project/{id}/environment/{id}');
    expect(screenName('/settings/advanced')).toBe('/settings/advanced');
  });

  it('gives pages that differ only by id one screenshot with the strings of both', () => {
    const plan = planScreenshots({
      pages: [
        { path: '/server/aaaaaaaaaa1aaaaaaaaaaaaa', file: 'a.png', keys: ['Save'] },
        { path: '/server/bbbbbbbbbb2bbbbbbbbbbbbb', file: 'b.png', keys: ['Cancel'] },
      ],
      existing: [],
      sourceUnits,
    });

    expect(plan.create).toEqual([{ name: '/server/{id}', file: 'a.png', unitIds: [101, 102] }]);
  });
});

describe('screenshots of a long page cut into parts', () => {
  it('names later parts after the page with their number, so each part keeps its own screenshot', () => {
    const plan = planScreenshots({
      pages: [
        { path: '/servers', file: '000.png', keys: ['Servers'] },
        { path: '/servers', part: 2, file: '001.png', keys: ['Delete'] },
      ],
      existing: [{ id: 7, name: '/servers', unitIds: [103] }],
      sourceUnits,
    });

    expect(plan).toEqual({
      create: [{ name: '/servers #2', file: '001.png', unitIds: [104] }],
      replace: [{ id: 7, name: '/servers', file: '000.png', link: [], unlink: [] }],
    });
  });
});

describe('screenshots of dialogs and common strings', () => {
  it('gives an opened dialog its own screenshot named after the button', () => {
    const plan = planScreenshots({ pages: [{ path: '/servers', modal: 'Add', file: '004.png', keys: ['Save'] }], existing: [], sourceUnits });

    expect(plan.create).toEqual([{ name: '/servers › Add', file: '004.png', unitIds: [101] }]);
  });

  it('links a string to its first three screenshots only, so a word on every page does not get hundreds', () => {
    const pages = ['/a', '/b', '/c', '/d', '/e'].map((path, n) => ({ path, file: `00${String(n)}.png`, keys: ['Save', ...(n === 4 ? ['Cancel'] : [])] }));
    const plan = planScreenshots({ pages, existing: [{ id: 9, name: '/d', unitIds: [101] }], sourceUnits });

    expect(plan.create.map((shot) => [shot.name, shot.unitIds])).toEqual([
      ['/a', [101]],
      ['/b', [101]],
      ['/c', [101]],
      ['/e', [102]],
    ]);
    expect(plan.replace).toEqual([]);
  });
});

describe('uploadScreenshots when Weblate refuses one image', () => {
  const units = (): Promise<{ id: number; key: string; source: string; target: string; state: number }[]> =>
    Promise.resolve([...sourceUnits].map(([key, id]) => ({ id, key, source: key, target: key, state: 100 })));
  const pages = [
    { path: '/team', file: '000.png', keys: ['Save'] },
    { path: '/servers', file: '001.png', keys: ['Servers'] },
  ];

  it('skips the image Weblate rejects as invalid (400, e.g. too big) and still uploads the others', async () => {
    const done: string[] = [];
    const client = {
      units,
      screenshots: () => Promise.resolve([]),
      createScreenshot: (_p: string, _c: string, _l: string, name: string) => {
        if (name === '/team') {
          return Promise.reject(new WeblateError(400, '/api/screenshots/', '{"detail":"The image is too big"}'));
        }
        done.push(name);

        return Promise.resolve(9);
      },
      replaceScreenshotImage: () => Promise.reject(new WeblateError(400, '/api/screenshots/7/file/')),
      linkScreenshot: () => Promise.resolve(),
      unlinkScreenshot: () => Promise.resolve(),
    };
    const report = await uploadScreenshots(client, { pages, readImage: () => new Uint8Array(3) });

    expect(done).toEqual(['/servers']);
    expect(report).toMatchObject({ created: 1, linked: 1, skipped: 1 });
  });

  it('still stops on other Weblate failures (server error, lost token)', async () => {
    for (const status of [401, 500]) {
      const client = {
        units,
        screenshots: () => Promise.resolve([]),
        createScreenshot: () => Promise.reject(new WeblateError(status, '/api/screenshots/')),
        replaceScreenshotImage: () => Promise.resolve(),
        linkScreenshot: () => Promise.resolve(),
        unlinkScreenshot: () => Promise.resolve(),
      };
      await expect(uploadScreenshots(client, { pages, readImage: () => new Uint8Array(3) })).rejects.toThrow(`HTTP ${String(status)}`);
    }
  });
});

describe('uploadScreenshots with a bad image', () => {
  it('skips a page whose image is refused and still uploads the others', async () => {
    const done: string[] = [];
    const client = {
      units: () => Promise.resolve([...sourceUnits].map(([key, id]) => ({ id, key, source: key, target: key, state: 100 }))),
      screenshots: () => Promise.resolve([]),
      createScreenshot: (_p: string, _c: string, _l: string, name: string) => {
        done.push(name);

        return Promise.resolve(done.length);
      },
      replaceScreenshotImage: () => Promise.resolve(),
      linkScreenshot: () => Promise.resolve(),
      unlinkScreenshot: () => Promise.resolve(),
    };
    const report = await uploadScreenshots(client, {
      pages: [
        { path: '/team', file: '000.png', keys: ['Save'] },
        { path: '/servers', file: '001.png', keys: ['Servers'] },
      ],
      readImage: (file) => {
        if (file === '000.png') {
          throw new Error('스크린샷이 PNG가 아닙니다: 000.png');
        }

        return new Uint8Array(3);
      },
    });

    expect(done).toEqual(['/servers']);
    expect(report).toMatchObject({ created: 1, skipped: 1 });
  });
});
