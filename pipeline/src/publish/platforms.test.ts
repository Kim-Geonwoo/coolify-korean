import { describe, expect, it } from 'vitest';
import { PLATFORMS, sourceDrift } from './platforms.ts';

const a = 'a'.repeat(64);
const b = 'b'.repeat(64);
const hashes = (lines: readonly (readonly [string, string])[]): string => `${lines.map(([hash, path]) => `${hash}  ${path}`).join('\n')}\n`;

describe('PLATFORMS', () => {
  it('publishes the same platforms as the official image', () => {
    expect(PLATFORMS).toEqual(['linux/amd64', 'linux/arm64']);
  });
});

describe('sourceDrift', () => {
  it('finds nothing when both platforms ship the same sources', () => {
    const text = hashes([[a, './app/Models/Server.php'], [b, './resources/views/layouts/app.blade.php']]);

    expect(sourceDrift(text, text)).toEqual([]);
  });

  it('reports a file whose content differs', () => {
    expect(sourceDrift(hashes([[a, './app/x.php']]), hashes([[b, './app/x.php']]))).toEqual(['./app/x.php']);
  });

  it('reports files that exist on one platform only, sorted', () => {
    const left = hashes([[a, './app/x.php'], [a, './config/z.php']]);
    const right = hashes([[a, './app/x.php'], [a, './app/y.php']]);

    expect(sourceDrift(left, right)).toEqual(['./app/y.php', './config/z.php']);
  });

  it('keeps paths with spaces intact', () => {
    expect(sourceDrift(hashes([[a, './lang/a b.json']]), hashes([[b, './lang/a b.json']]))).toEqual(['./lang/a b.json']);
  });

  it('refuses output that is not sha256sum lines', () => {
    expect(() => sourceDrift('garbage\n', '')).toThrow();
  });

  it('refuses an empty listing (a failed hash step must not look like a match)', () => {
    expect(() => sourceDrift('', '')).toThrow();
  });
});
