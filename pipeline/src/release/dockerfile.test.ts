import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// PaaS 호스트는 한국어판 이미지의 실행 설정(Entrypoint·Cmd·User·포트·작업 폴더·환경)이 공식 이미지와 같아야 받는다.
// overlay 단계에 ENV·HEALTHCHECK·VOLUME·USER·WORKDIR·EXPOSE·CMD 등을 더하면 PaaS가 그 판을 거부한다(2026-10-18 PaaS 호스트 계약)
const ALLOWED = new Set(['ARG', 'COPY', 'LABEL']);

describe('Dockerfile overlay stage', () => {
  it('only copies files and adds labels on top of the official image, so the PaaS accepts the image', () => {
    const lines = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Dockerfile'), 'utf8').split('\n');
    const start = lines.findIndex((line) => /^FROM \$\{COOLIFY_IMAGE\} AS overlay\s*$/.test(line));
    expect(start).toBeGreaterThan(0);
    const stage: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (/^FROM\s/i.test(line)) {
        break;
      }
      stage.push(line);
    }
    // 줄 이음(\)으로 이어진 줄은 앞 지시의 일부라 첫 단어만 본다
    const instructions = stage.filter((line, index) => line.trim() !== '' && !line.trimStart().startsWith('#') && !(stage[index - 1] ?? '').trimEnd().endsWith('\\')).map((line) => line.trim().split(/\s+/)[0]?.toUpperCase() ?? '');

    expect(instructions.length).toBeGreaterThan(0);
    expect(instructions.filter((word) => !ALLOWED.has(word))).toEqual([]);
  });
});

describe('Dockerfile public stage', () => {
  const lines = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Dockerfile'), 'utf8').split('\n');
  const start = lines.findIndex((line) => /^FROM overlay AS public\s*$/.test(line));
  const stage: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^FROM\s/i.test(line)) {
      break;
    }
    stage.push(line);
  }
  const instructions = stage.filter((line, index) => line.trim() !== '' && !line.trimStart().startsWith('#') && !(stage[index - 1] ?? '').trimEnd().endsWith('\\'));

  it('builds on the PaaS overlay and only adds files and labels', () => {
    expect(start).toBeGreaterThan(0);
    expect(instructions.map((line) => line.trim().split(/\s+/)[0]?.toUpperCase() ?? '').filter((word) => !ALLOWED.has(word))).toEqual([]);
  });

  it('adds nothing but the default language files', () => {
    const targets = instructions.filter((line) => /^\s*COPY\s/i.test(line)).map((line) => line.trim().split(/\s+/).at(-1));

    expect(targets).toEqual(['/var/www/html/lang-default/']);
  });
});

describe('Dockerfile build platforms', () => {
  const text = readFileSync(join(import.meta.dirname, '..', '..', '..', 'Dockerfile'), 'utf8');
  const fromLine = (stage: string): string => text.split('\n').find((line) => new RegExp(`^FROM .* AS ${stage}\\s*$`).test(line)) ?? '';

  it('runs the transform toolchain on the build machine so arm64 needs no emulation', () => {
    expect(fromLine('upstream')).toMatch(/^FROM --platform=\$BUILDPLATFORM /);
    expect(fromLine('base')).toMatch(/^FROM --platform=\$BUILDPLATFORM /);
  });

  it('keeps the shipped images and the target-platform sources on the target platform', () => {
    for (const stage of ['overlay', 'public', 'upstream-target']) {
      expect(fromLine(stage)).not.toBe('');
      expect(fromLine(stage)).not.toContain('--platform');
    }
  });

  it('hashes the target-platform sources with the build-platform toolchain', () => {
    expect(fromLine('source-hashes')).toMatch(/^FROM base AS source-hashes/);
    expect(fromLine('source-hashes-report')).toMatch(/^FROM scratch AS source-hashes-report/);
  });
});
