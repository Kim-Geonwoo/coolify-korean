import { describe, expect, it } from 'vitest';
import { imageArchive } from './archive.ts';

describe('imageArchive', () => {
  it('gives a pinned image a local tag and an HDD file name that both carry its version and digest', () => {
    expect(imageArchive('mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf')).toEqual({
      tag: 'coolify-ko/playwright:v1.64.1-noble-7852dc5a7d72',
      file: 'playwright-v1.64.1-noble-7852dc5a7d72.tar',
    });
  });

  it('refuses an image that is not pinned by digest', () => {
    expect(() => imageArchive('mcr.microsoft.com/playwright:v1.64.1-noble')).toThrow('다이제스트');
  });
});
