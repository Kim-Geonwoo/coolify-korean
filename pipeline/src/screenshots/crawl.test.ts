import { describe, expect, it } from 'vitest';
import { Crawl, foldExamples } from './crawl.ts';

const drain = (crawl: Crawl): string[] => {
  const seen: string[] = [];
  for (let step = crawl.next(); step !== undefined; step = crawl.next()) {
    seen.push(`${step.path}@${String(step.depth)}`);
  }

  return seen;
};

describe('foldExamples', () => {
  it('keeps the main page of each example resource apart but folds their sub-pages into one screen', () => {
    expect(foldExamples('/project/demo/environment/x1y2z3a4b5c6d7e8f9g0h1i2/application/demo-image')).toBe('/project/demo/environment/{id}/application/demo-image');
    expect(foldExamples('/project/demo/environment/x1y2z3a4b5c6d7e8f9g0h1i2/application/demo-image/logs')).toBe('/project/demo/environment/{id}/application/{demo}/logs');
    expect(foldExamples('/server/demo-server/proxy')).toBe('/server/{demo}/proxy');
    expect(foldExamples('/settings/advanced')).toBe('/settings/advanced');
  });
});

describe('Crawl', () => {
  it('visits the start pages first, then pages they link to, one level deeper each time, up to the depth limit', () => {
    const crawl = new Crawl(['/servers', '/projects'], { maxDepth: 2, maxPages: 50 });

    expect(crawl.next()).toEqual({ path: '/servers', depth: 0 });
    crawl.add(['/server/aaaaaaaaaa1aaaaaaaaaaaaa', '/projects'], 0);
    expect(crawl.next()).toEqual({ path: '/projects', depth: 0 });
    expect(crawl.next()).toEqual({ path: '/server/aaaaaaaaaa1aaaaaaaaaaaaa', depth: 1 });
    crawl.add(['/server/aaaaaaaaaa1aaaaaaaaaaaaa/proxy'], 1);
    expect(crawl.next()).toEqual({ path: '/server/aaaaaaaaaa1aaaaaaaaaaaaa/proxy', depth: 2 });
    crawl.add(['/server/aaaaaaaaaa1aaaaaaaaaaaaa/proxy/logs'], 2);
    expect(crawl.next()).toBeUndefined();
  });

  it('visits one page per screen: pages that differ only by record id are the same screen', () => {
    const crawl = new Crawl(['/servers'], { maxDepth: 3, maxPages: 50 });
    crawl.next();
    crawl.add(['/server/aaaaaaaaaa1aaaaaaaaaaaaa', '/server/bbbbbbbbbb2bbbbbbbbbbbbb', '/server/aaaaaaaaaa1aaaaaaaaaaaaa'], 0);

    expect(drain(crawl)).toEqual(['/server/aaaaaaaaaa1aaaaaaaaaaaaa@1']);
  });

  it('can fold screens further, e.g. one set of sub-tabs per resource type instead of per example resource', () => {
    const crawl = new Crawl(['/p'], { maxDepth: 3, maxPages: 50, screenOf: foldExamples });
    crawl.next();
    crawl.add(['/app/demo-nixpacks', '/app/demo-dockerfile', '/app/demo-nixpacks/logs', '/app/demo-dockerfile/logs'], 0);

    expect(drain(crawl)).toEqual(['/app/demo-nixpacks@1', '/app/demo-dockerfile@1', '/app/demo-nixpacks/logs@1']);
  });

  it('stops after the page limit, counting every page handed out', () => {
    const crawl = new Crawl(['/a', '/b', '/c'], { maxDepth: 3, maxPages: 2 });

    expect(drain(crawl)).toEqual(['/a@0', '/b@0']);
    expect(crawl.visited).toBe(2);
  });
});
