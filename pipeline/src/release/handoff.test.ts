import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serializeKo, writeHandoff } from './handoff.ts';

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-'));
  dirs.push(dir);

  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});
const info = { catalogVersion: '4.4.6', devCommit: 'abc', weblateLastChange: '2026-10-18T00:00:00Z', counts: { approved: 1, pending: 0, drafts: 1, english: 0 } };

describe('serializeKo', () => {
  it('writes keys in a fixed order and round-trips quotes, line breaks and U+2028', () => {
    const ko = { b: `"따옴표"\n${String.fromCodePoint(0x2028)}끝`, a: '가' };
    const text = serializeKo(ko);

    expect(text.indexOf('"a"')).toBeLessThan(text.indexOf('"b"'));
    expect(JSON.parse(text)).toEqual(ko);
    expect(serializeKo({ a: '가', b: ko.b })).toBe(text);
  });
});

describe('writeHandoff', () => {
  it('writes ko.json, then a manifest whose hash matches the file, readable by the group only', () => {
    const dir = temp();

    expect(writeHandoff(dir, { a: '가' }, info, new Date('2026-10-18T01:00:00Z'))).toBe('written');
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { schema: number; sha256: string; builtAt: string; counts: unknown };
    const ko = readFileSync(join(dir, 'ko.json'));

    expect(manifest).toMatchObject({ schema: 1, catalogVersion: '4.4.6', devCommit: 'abc', builtAt: '2026-10-18T01:00:00.000Z', counts: info.counts });
    expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sha256).toBe(createHash('sha256').update(ko).digest('hex'));
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'ko.json')).mode & 0o777).toBe(0o640);
      expect(statSync(join(dir, 'manifest.json')).mode & 0o777).toBe(0o640);
    }
  });

  it('never writes through a symbolic link left at a temporary name in the folder', () => {
    const dir = temp();
    const victim = join(temp(), 'victim.txt');
    writeFileSync(victim, 'keep');
    symlinkSync(victim, join(dir, '.ko.json.partial'));
    symlinkSync(victim, join(dir, '.manifest.json.partial'));
    writeHandoff(dir, { a: '가' }, info, new Date('2026-10-18T01:00:00Z'));

    expect(readFileSync(victim, 'utf8')).toBe('keep');
    expect(JSON.parse(readFileSync(join(dir, 'ko.json'), 'utf8'))).toEqual({ a: '가' });
  });

  it('leaves both files alone when the translations did not change, so the watcher on the other side does not fire', () => {
    const dir = temp();
    writeHandoff(dir, { a: '가' }, info, new Date('2026-10-18T01:00:00Z'));
    const before = readFileSync(join(dir, 'manifest.json'), 'utf8');

    expect(writeHandoff(dir, { a: '가' }, { ...info, devCommit: 'def' }, new Date('2026-10-18T02:00:00Z'))).toBe('same');
    expect(readFileSync(join(dir, 'manifest.json'), 'utf8')).toBe(before);
    expect(writeHandoff(dir, { a: '나' }, info, new Date('2026-10-18T03:00:00Z'))).toBe('written');
  });
});
