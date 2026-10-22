import { screenName } from './names.ts';

const EXAMPLE = /^demo-[a-z0-9-]+$/;

/**
 * 예시 리소스(seed.ts의 demo-* uuid)의 하위 쪽을 한 화면으로 접는다. 본 쪽(마지막 마디)은 종류마다 따로 돌고,
 * 환경 변수·로그 같은 하위 탭은 앱 4개·DB 8개마다가 아니라 한 번만 돈다(2026-10-18 로컬 실측: /project 196쪽이 300쪽 상한을 먹음)
 */
export function foldExamples(path: string): string {
  const segments = screenName(path).split('/');

  return segments.map((segment, index) => (index < segments.length - 1 && EXAMPLE.test(segment) ? '{demo}' : segment)).join('/');
}

export interface CrawlOptions {
  readonly maxDepth: number;
  readonly maxPages: number;
  /** 같은 화면으로 볼 경로를 접는 함수(기본: 레코드 id만 접는 screenName) */
  readonly screenOf?: (path: string) => string;
}

/**
 * 스크린샷 탐색 대기열. 시작 쪽부터 너비 우선, 링크마다 한 단계씩 깊이(maxDepth까지).
 * 같은 화면(레코드 id를 {id}로 바꾼 경로)은 한 쪽만 돈다: 배포 기록 쪽 열 개가 시간을 먹지 않게
 */
export class Crawl {
  private readonly queue: { path: string; depth: number }[] = [];
  private readonly screens = new Set<string>();
  private handed = 0;
  private readonly options: CrawlOptions;

  constructor(start: readonly string[], options: CrawlOptions) {
    this.options = options;
    this.add(start, -1);
  }

  /** 깊이 fromDepth 쪽에서 찾은 링크. 이미 본 화면이거나 깊이를 넘으면 버린다 */
  add(paths: readonly string[], fromDepth: number): void {
    const depth = fromDepth + 1;
    if (depth > this.options.maxDepth) {
      return;
    }
    for (const path of paths) {
      const screen = (this.options.screenOf ?? screenName)(path);
      if (!this.screens.has(screen)) {
        this.screens.add(screen);
        this.queue.push({ path, depth });
      }
    }
  }

  next(): { path: string; depth: number } | undefined {
    if (this.handed >= this.options.maxPages) {
      return undefined;
    }
    const step = this.queue.shift();
    if (step !== undefined) {
      this.handed++;
    }

    return step;
  }

  get visited(): number {
    return this.handed;
  }
}
