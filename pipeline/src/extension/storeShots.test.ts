import { describe, expect, it } from 'vitest';
import { jpegSize, privacyProblems, shotFileName, STORE_SIZE, storeImageProblem, storeShotPlan } from './storeShots.ts';

/** 표지 조각: FF + 표지 + 길이(2바이트, 길이 칸 포함) + 내용 */
const segment = (marker: number, body: readonly number[]): number[] => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
/** SOF 내용: 정밀도 8, 높이, 너비, 성분 수, 성분마다 3바이트 */
const sofBody = (width: number, height: number, components: number): number[] => [8, height >> 8, height & 0xff, width >> 8, width & 0xff, components, ...Array.from({ length: components * 3 }, () => 0x11)];
const jpeg = (...parts: number[][]): Buffer => Buffer.from([0xff, 0xd8, ...parts.flat(), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);
const app0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]);

describe('jpegSize', () => {
  it('reads width, height and component count from a baseline SOF0 frame', () => {
    expect(jpegSize(jpeg(app0, segment(0xc0, sofBody(1280, 800, 3))))).toEqual({ width: 1280, height: 800, components: 3 });
  });

  it('reads a progressive SOF2 frame and skips tables (DHT is 0xC4, not a frame) and fill bytes', () => {
    const dht = segment(0xc4, [0x00, ...Array.from({ length: 16 }, () => 0)]);
    const buffer = jpeg(app0, dht, [0xff], segment(0xc2, sofBody(640, 400, 1)));

    expect(jpegSize(buffer)).toEqual({ width: 640, height: 400, components: 1 });
  });

  it('returns null for something that is not a JPEG, a truncated file, or scan data before any frame', () => {
    expect(jpegSize(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 8, 0x03]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]))).toBeNull();
    expect(jpegSize(Buffer.from([0xff, 0xd8, 0x00, 0x00]))).toBeNull();
    expect(jpegSize(Buffer.alloc(0))).toBeNull();
  });
});

describe('storeImageProblem', () => {
  it('accepts a 24-bit colour JPEG of exactly the store size', () => {
    expect(storeImageProblem(jpeg(app0, segment(0xc0, sofBody(STORE_SIZE.width, STORE_SIZE.height, 3))))).toBeNull();
  });

  it('names what is wrong: not a JPEG, a wrong size, or not three colour components', () => {
    expect(storeImageProblem(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toMatch(/JPEG/);
    expect(storeImageProblem(jpeg(segment(0xc0, sofBody(1280, 720, 3))))).toMatch(/1280x720/);
    expect(storeImageProblem(jpeg(segment(0xc0, sofBody(2560, 1600, 3))))).toMatch(/2560x1600/);
    expect(storeImageProblem(jpeg(segment(0xc0, sofBody(1280, 800, 1))))).toMatch(/성분 1/);
  });
});

describe('storeShotPlan', () => {
  const plan = storeShotPlan('h0kswoc8gss4');

  it('lists 4 or 5 pages with unique kebab-case slugs and site paths', () => {
    expect(plan.length).toBeGreaterThanOrEqual(4);
    expect(plan.length).toBeLessThanOrEqual(5);
    expect(new Set(plan.map((shot) => shot.slug)).size).toBe(plan.length);
    for (const shot of plan) {
      expect(shot.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(shot.path.startsWith('/')).toBe(true);
    }
  });

  it('starts with the dashboard and puts the environment id into the project paths', () => {
    expect(plan[0]?.path).toBe('/');
    expect(plan.some((shot) => shot.path.includes('/environment/h0kswoc8gss4'))).toBe(true);
  });

  it('never visits pages that show the login e-mail (profile, team members)', () => {
    expect(plan.some((shot) => /^\/(?:profile|team)/.test(shot.path))).toBe(false);
  });

  it('rejects an environment id that could change the path', () => {
    expect(() => storeShotPlan('')).toThrow();
    expect(() => storeShotPlan('../settings')).toThrow();
    expect(() => storeShotPlan('a/b')).toThrow();
  });
});

describe('shotFileName', () => {
  it('numbers files from 1 with the slug', () => {
    expect(shotFileName(1, 'dashboard')).toBe('screenshot-1-dashboard.jpg');
    expect(shotFileName(5, 'new-project')).toBe('screenshot-5-new-project.jpg');
  });

  it('rejects a bad number or slug', () => {
    expect(() => shotFileName(0, 'dashboard')).toThrow();
    expect(() => shotFileName(1.5, 'dashboard')).toThrow();
    expect(() => shotFileName(1, 'Dash board')).toThrow();
    expect(() => shotFileName(1, '../x')).toThrow();
  });
});

describe('privacyProblems', () => {
  const email = 'e2e@coolify-ko.invalid';

  it('passes demo data: loopback address, example.com domains and generic names', () => {
    expect(privacyProblems('demo-server 127.0.0.1 http://demo-nixpacks.example.com 0.0.0.0 localhost', email)).toEqual([]);
  });

  it('flags the login e-mail in any case', () => {
    expect(privacyProblems('Signed in as E2E@Coolify-KO.invalid', email)).toHaveLength(1);
  });

  it('flags an IPv4 address other than loopback or 0.0.0.0, without repeating it', () => {
    const problems = privacyProblems('Public IPv4 203.0.113.7 and 10.0.1.2', email);

    expect(problems).toHaveLength(2);
    expect(problems.join(' ')).not.toContain('203.0.113.7');
  });

  it('ignores version numbers that are not four parts', () => {
    expect(privacyProblems('v4.4.6 build 1.2.3', email)).toEqual([]);
  });
});
