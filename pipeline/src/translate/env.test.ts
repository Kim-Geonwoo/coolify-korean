import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readSecret } from './env.ts';

const dirs: string[] = [];
function envFile(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'coolify-ko-env-'));
  dirs.push(dir);
  const path = join(dir, '.env');
  writeFileSync(path, content);

  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('readSecret', () => {
  it('reads one value without touching process.env, handling BOM, CRLF and quotes', () => {
    const path = envFile(`${String.fromCodePoint(0xfeff)}OTHER=1\r\nGEMINI_API_KEY="abc123"\r\n`);

    expect(readSecret(path, 'GEMINI_API_KEY')).toBe('abc123');
    expect(process.env['GEMINI_API_KEY']).toBeUndefined();
  });

  it('names the missing key without printing anything else', () => {
    const path = envFile('GEMINI_API_KEY=\n');

    expect(() => readSecret(path, 'GEMINI_API_KEY')).toThrow('GEMINI_API_KEY');
    expect(() => readSecret(join(tmpdir(), 'no-such-dir-x', '.env'), 'GEMINI_API_KEY')).toThrow('GEMINI_API_KEY');
  });
});
