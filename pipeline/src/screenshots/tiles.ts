/**
 * 긴 쪽을 Weblate가 받는 크기로 나눈다. Weblate는 가로·세로 2000px을 넘는 이미지를 거부한다
 * (weblate/utils/validators.py validate_bitmap, 고정값). 찍기 폭은 1440px이라 세로만 자른다.
 */
export const TILE_HEIGHT = 1800;
const MAX_TILES = 6;

/** 쪽 안에서 키 표식이 보인 자리(문서 좌표, px) */
export interface Mark {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}

export interface Tile {
  readonly y: number;
  readonly height: number;
  readonly ids: string[];
}

/** 표식은 가운데가 든 조각 하나에만 넣는다. 키가 없는 조각은 버리고, maxTiles 조각 아래는 찍지 않는다 */
export function planTiles(marks: readonly Mark[], pageHeight: number, options: { readonly maxTiles?: number } = {}): Tile[] {
  const limit = Math.min(Math.max(0, Math.floor(pageHeight)), TILE_HEIGHT * (options.maxTiles ?? MAX_TILES));
  const tiles: Tile[] = [];
  for (let y = 0; y < limit; y += TILE_HEIGHT) {
    tiles.push({ y, height: Math.min(TILE_HEIGHT, limit - y), ids: [] });
  }
  for (const mark of marks) {
    const middle = (mark.top + mark.bottom) / 2;
    const tile = middle >= 0 && middle < limit ? tiles[Math.floor(middle / TILE_HEIGHT)] : undefined;
    if (tile !== undefined && !tile.ids.includes(mark.id)) {
      tile.ids.push(mark.id);
    }
  }

  return tiles.filter((tile) => tile.ids.length > 0);
}
