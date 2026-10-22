import { describe, expect, it } from 'vitest';
import { planTiles, TILE_HEIGHT } from './tiles.ts';

describe('planTiles', () => {
  it('keeps a short page as one tile with every key it shows', () => {
    expect(planTiles([{ id: 'a', top: 10, bottom: 30 }, { id: 'b', top: 500, bottom: 520 }], 900)).toEqual([{ y: 0, height: 900, ids: ['a', 'b'] }]);
  });

  it('cuts a tall page into tiles Weblate accepts (2000px at most) and links each key only to the tile it shows in', () => {
    const tiles = planTiles(
      [
        { id: 'top', top: 100, bottom: 120 },
        { id: 'middle', top: 2000, bottom: 2020 },
        { id: 'bottom', top: 4000, bottom: 4020 },
      ],
      4100,
    );

    expect(TILE_HEIGHT).toBeLessThanOrEqual(2000);
    expect(tiles).toEqual([
      { y: 0, height: TILE_HEIGHT, ids: ['top'] },
      { y: TILE_HEIGHT, height: TILE_HEIGHT, ids: ['middle'] },
      { y: TILE_HEIGHT * 2, height: 4100 - TILE_HEIGHT * 2, ids: ['bottom'] },
    ]);
  });

  it('puts a key that straddles a cut into the tile holding its middle, and lists a key once per tile', () => {
    const tiles = planTiles(
      [
        { id: 'edge', top: TILE_HEIGHT - 5, bottom: TILE_HEIGHT + 25 },
        { id: 'twice', top: 10, bottom: 20 },
        { id: 'twice', top: 40, bottom: 50 },
      ],
      TILE_HEIGHT * 2,
    );

    expect(tiles).toEqual([
      { y: 0, height: TILE_HEIGHT, ids: ['twice'] },
      { y: TILE_HEIGHT, height: TILE_HEIGHT, ids: ['edge'] },
    ]);
  });

  it('drops tiles that show no key, and stops at the tile limit so one endless page cannot eat the run', () => {
    const marks = Array.from({ length: 20 }, (_, n) => ({ id: `k${String(n)}`, top: n * TILE_HEIGHT + 10, bottom: n * TILE_HEIGHT + 30 }));
    const tiles = planTiles([marks[0], marks[2]].flatMap((mark) => (mark === undefined ? [] : [mark])), TILE_HEIGHT * 3);

    expect(tiles.map((tile) => tile.ids)).toEqual([['k0'], ['k2']]);
    expect(tiles.map((tile) => tile.y)).toEqual([0, TILE_HEIGHT * 2]);
    expect(planTiles(marks, TILE_HEIGHT * 20, { maxTiles: 4 })).toHaveLength(4);
  });

  it('ignores marks outside the page (negative or past the end) and a page with no height', () => {
    expect(planTiles([{ id: 'ghost', top: -50, bottom: -10 }, { id: 'past', top: 5000, bottom: 5010 }], 900)).toEqual([]);
    expect(planTiles([{ id: 'a', top: 0, bottom: 10 }], 0)).toEqual([]);
  });
});
