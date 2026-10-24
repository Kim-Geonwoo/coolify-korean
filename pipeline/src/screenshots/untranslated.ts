import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 스크린샷이 본 "표식 없이 보인 영어"(오버레이가 번역 호출로 감싸지 못한 화면 글)를 지난 찍기와 비교한다.
 * 새 판이 변환기가 모르는 꼴로 글을 내면(4.5.0 사이드바 PHP 배열·이어 붙인 단추) 여기서 드러난다. 전에는 목록을 지워 아무도 못 봤다(2026-10-25)
 */
export interface UntranslatedGap {
  readonly text: string;
  readonly paths: readonly string[];
}

const BASELINE = 'untranslated.json';

const norm = (text: string): string => text.replace(/\s+/g, ' ').trim();

function parseGaps(value: unknown): UntranslatedGap[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const gaps: UntranslatedGap[] = [];
  for (const item of value) {
    const { text, paths } = (item ?? {}) as { text?: unknown; paths?: unknown };
    if (typeof text !== 'string' || !Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) {
      return undefined;
    }
    gaps.push({ text, paths });
  }

  return gaps;
}

function readJson(path: string): unknown {
  try {
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

/** 지난 찍기에 없던 글만, 여러 쪽에서 보인 것부터. 기준선이 없으면(첫 찍기) 비교하지 않는다 */
export function newGaps(current: readonly UntranslatedGap[], previous: readonly UntranslatedGap[] | undefined): UntranslatedGap[] {
  if (previous === undefined) {
    return [];
  }
  const seen = new Set(previous.map((gap) => norm(gap.text)));

  return current.filter((gap) => !seen.has(norm(gap.text))).sort((a, b) => b.paths.length - a.paths.length || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));
}

/**
 * 찍기 출력(outDir/untranslated.json)을 캐시의 기준선과 비교하고, 이번 찍기를 다음 기준선으로 남긴다.
 * 출력이 없거나 깨졌으면 자료가 없는 것으로 보고 기준선을 그대로 둔다
 */
export function recordGaps(outDir: string, cacheDir: string, version: string): { readonly total: number; readonly fresh: UntranslatedGap[]; readonly previousVersion?: string } {
  const current = parseGaps(readJson(join(outDir, BASELINE)));
  if (current === undefined) {
    return { total: 0, fresh: [] };
  }
  const saved = readJson(join(cacheDir, BASELINE)) as { version?: unknown; gaps?: unknown } | undefined;
  const previous = parseGaps(saved?.gaps);
  const previousVersion = previous !== undefined && typeof saved?.version === 'string' ? saved.version : undefined;
  writeFileSync(join(cacheDir, BASELINE), `${JSON.stringify({ version, gaps: current }, null, 2)}\n`);

  return { total: current.length, fresh: newGaps(current, previous), ...(previousVersion === undefined ? {} : { previousVersion }) };
}
