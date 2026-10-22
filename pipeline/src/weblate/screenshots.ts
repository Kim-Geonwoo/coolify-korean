import { shotName } from '../screenshots/names.ts';
import { WeblateError, type WeblateClient } from './client.ts';
import { WEBLATE } from './config.ts';

/** 시험 인스턴스에서 찍은 한 장: 경로, 조각 번호(첫 조각은 없음) 또는 연 창의 버튼 이름, PNG 파일, 거기 나온 키(표식으로 찾음) */
export interface CapturedPage {
  readonly path: string;
  readonly part?: number;
  readonly modal?: string;
  readonly file: string;
  readonly keys: readonly string[];
}

/** Weblate에 이미 있는 스크린샷(원문 언어). 이름은 쪽 경로다 */
export interface ExistingScreenshot {
  readonly id: number;
  readonly name: string;
  readonly unitIds: readonly number[];
}

export interface ScreenshotPlan {
  readonly create: { readonly name: string; readonly file: string; readonly unitIds: number[] }[];
  readonly replace: { readonly id: number; readonly name: string; readonly file: string; readonly link: number[]; readonly unlink: number[] }[];
}

const ascending = (a: number, b: number): number => a - b;
// 한 문장에 잇는 스크린샷 수 상한. "Save"처럼 모든 쪽에 나오는 말이 수백 장에 이어지지 않게(찍은 순서로 앞의 것)
const SHOTS_PER_UNIT = 3;

export { screenName } from '../screenshots/names.ts';

/**
 * 쪽(조각·창)마다 스크린샷 한 장. 처음 보는 쪽은 만들고, 전에 찍은 쪽(같은 이름)은 이미지를 바꿔 끼우고 잇기를 고친다.
 * Weblate에 없는 키(앞 점 키 등)만 나온 쪽은 건너뛴다. 이번에 못 간 쪽의 스크린샷은 지우지 않는다(다음에 다시 닿을 수 있다)
 */
export function planScreenshots(input: { readonly pages: readonly CapturedPage[]; readonly existing: readonly ExistingScreenshot[]; readonly sourceUnits: ReadonlyMap<string, number> }): ScreenshotPlan {
  const byName = new Map(input.existing.map((shot) => [shot.name, shot]));
  const plan: ScreenshotPlan = { create: [], replace: [] };
  // id만 다른 쪽은 한 장으로 합친다(이미지는 처음 찍은 쪽, 키는 모두)
  const grouped = new Map<string, CapturedPage>();
  for (const page of input.pages) {
    const name = shotName(page);
    const seen = grouped.get(name);
    grouped.set(name, seen === undefined ? { path: name, file: page.file, keys: [...page.keys] } : { ...seen, keys: [...seen.keys, ...page.keys] });
  }
  const shotsOf = new Map<number, number>();
  for (const page of grouped.values()) {
    const unitIds = [...new Set(page.keys.flatMap((key) => {
      const id = input.sourceUnits.get(key);

      return id === undefined ? [] : [id];
    }))]
      .filter((id) => {
        const count = shotsOf.get(id) ?? 0;
        shotsOf.set(id, count + 1);

        return count < SHOTS_PER_UNIT;
      })
      .sort(ascending);
    if (unitIds.length === 0) {
      continue;
    }
    const shot = byName.get(page.path);
    if (shot === undefined) {
      plan.create.push({ name: page.path, file: page.file, unitIds });
    } else {
      const before = new Set(shot.unitIds);
      const after = new Set(unitIds);
      plan.replace.push({ id: shot.id, name: page.path, file: page.file, link: unitIds.filter((id) => !before.has(id)), unlink: [...before].filter((id) => !after.has(id)).sort(ascending) });
    }
  }

  return plan;
}

export interface ScreenshotReport {
  readonly created: number;
  readonly replaced: number;
  readonly linked: number;
  readonly unlinked: number;
  /** 이미지를 읽지 못해(검사 거부 등) 건너뛴 쪽 */
  readonly skipped: number;
}

/**
 * 찍은 쪽들을 운영 컴포넌트의 원문 언어(en) 스크린샷으로 올린다. 원문 단위에 이어 모든 번역에서 보인다.
 * 하나도 못 찍었으면 Weblate를 건드리지 않고 멈춘다(시험 인스턴스가 안 뜬 날)
 */
export async function uploadScreenshots(
  client: Pick<WeblateClient, 'units' | 'screenshots' | 'createScreenshot' | 'replaceScreenshotImage' | 'linkScreenshot' | 'unlinkScreenshot'>,
  input: { readonly pages: readonly CapturedPage[]; readonly readImage: (file: string) => Uint8Array },
): Promise<ScreenshotReport> {
  if (input.pages.length === 0) {
    throw new Error('찍은 쪽이 0쪽입니다(시험 인스턴스·브라우저 로그를 본다). Weblate는 건드리지 않았습니다.');
  }
  const { project, component } = WEBLATE;
  const sourceUnits = new Map((await client.units(project, component, 'en')).map((unit) => [unit.key, unit.id]));
  const plan = planScreenshots({ pages: input.pages, existing: await client.screenshots(project, component), sourceUnits });
  let linked = 0;
  let unlinked = 0;
  let skipped = 0;
  // 쪽 하나의 이미지가 거부돼도(검사·크기) 나머지는 올린다
  const image = (file: string): Uint8Array | undefined => {
    try {
      return input.readImage(file);
    } catch (error: unknown) {
      skipped++;
      console.log(`스크린샷 건너뜀: ${error instanceof Error ? error.message : String(error)}`);

      return undefined;
    }
  };
  // Weblate가 이미지를 형식 오류(400: 크기 초과 등)로 거부하면 그 한 장만 건너뛴다. 다른 실패(권한·서버)는 멈춘다
  const accepted = async <T>(name: string, send: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await send();
    } catch (error: unknown) {
      if (!(error instanceof WeblateError && error.status === 400)) {
        throw error;
      }
      skipped++;
      console.log(`스크린샷 건너뜀(${name}): ${error.message}`);

      return undefined;
    }
  };
  let created = 0;
  let replaced = 0;
  for (const shot of plan.create) {
    const png = image(shot.file);
    if (png === undefined) {
      continue;
    }
    const id = await accepted(shot.name, () => client.createScreenshot(project, component, 'en', shot.name, png));
    if (id === undefined) {
      continue;
    }
    created++;
    for (const unitId of shot.unitIds) {
      await client.linkScreenshot(id, unitId);
      linked++;
    }
  }
  for (const shot of plan.replace) {
    const png = image(shot.file);
    if (png === undefined) {
      continue;
    }
    if ((await accepted(shot.name, () => client.replaceScreenshotImage(shot.id, png).then(() => true))) === undefined) {
      continue;
    }
    replaced++;
    for (const unitId of shot.link) {
      await client.linkScreenshot(shot.id, unitId);
      linked++;
    }
    for (const unitId of shot.unlink) {
      await client.unlinkScreenshot(shot.id, unitId);
      unlinked++;
    }
  }

  return { created, replaced, linked, unlinked, skipped };
}
