import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newGaps, recordGaps, type UntranslatedGap } from './untranslated.ts';

// 2026-10-25: 4.5.0 사이드바·메트릭 단추가 영어로 남았는데, 스크린샷 단계가 센 "표식 없이 보인 영어"는 지워져 아무도 못 봤다
describe('newGaps', () => {
  const gap = (text: string, ...paths: string[]): UntranslatedGap => ({ text, paths });

  it('returns nothing without a baseline (the first capture only sets it)', () => {
    expect(newGaps([gap('Monitoring', '/')], undefined)).toEqual([]);
  });

  it('keeps only texts the previous capture did not show, most seen first', () => {
    const previous = [gap('GitHub Sponsors', '/'), gap('Open  Collective', '/')];
    const current = [gap('Open Collective', '/'), gap('Integrations', '/'), gap('Monitoring', '/', '/servers', '/projects'), gap('GitHub Sponsors', '/')];

    expect(newGaps(current, previous)).toEqual([gap('Monitoring', '/', '/servers', '/projects'), gap('Integrations', '/')]);
  });

  // 2026-10-25: 감사 로그의 기록 시각(예시 리소스를 만든 때)이 찍을 때마다 바뀌어 새 영어로 알렸다
  it('skips texts made only of a date or time, and treats texts that differ only in numbers as the same', () => {
    const previous = [gap('3 minutes ago', '/'), gap('Deployed 2 apps', '/')];
    const current = [gap('Sat, Oct 24, 2026 7:07 PM', '/team/audit-log'), gap('Monday, December 7, 2026', '/'), gap('2026-10-24 19:07:31', '/'), gap('15 minutes ago', '/'), gap('Deployed 2 servers', '/')];

    expect(newGaps(current, previous)).toEqual([gap('Deployed 2 servers', '/')]);
  });
});

describe('recordGaps', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  const temp = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'coolify-ko-gaps-'));
    dirs.push(dir);

    return dir;
  };

  it('compares the capture with the saved baseline, then saves the capture as the next baseline', () => {
    const out = temp();
    const cache = temp();
    writeFileSync(join(cache, 'untranslated.json'), JSON.stringify({ version: '4.4.7', gaps: [{ text: 'Stripe', paths: ['/'] }] }));
    writeFileSync(join(out, 'untranslated.json'), JSON.stringify([{ text: 'Stripe', paths: ['/'] }, { text: 'Monitoring', paths: ['/'] }]));

    expect(recordGaps(out, cache, '4.5.0')).toEqual({ total: 2, previousVersion: '4.4.7', fresh: [{ text: 'Monitoring', paths: ['/'] }] });
    expect(JSON.parse(readFileSync(join(cache, 'untranslated.json'), 'utf8'))).toEqual({ version: '4.5.0', gaps: [{ text: 'Stripe', paths: ['/'] }, { text: 'Monitoring', paths: ['/'] }] });
  });

  it('treats a missing or broken capture as no data and keeps the old baseline', () => {
    const out = temp();
    const cache = temp();
    writeFileSync(join(cache, 'untranslated.json'), JSON.stringify({ version: '4.4.7', gaps: [] }));
    writeFileSync(join(out, 'untranslated.json'), '{not json');

    expect(recordGaps(out, cache, '4.5.0')).toEqual({ total: 0, fresh: [] });
    expect(JSON.parse(readFileSync(join(cache, 'untranslated.json'), 'utf8'))).toEqual({ version: '4.4.7', gaps: [] });
  });
});
