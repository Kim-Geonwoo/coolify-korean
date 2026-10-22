import { describe, expect, it } from 'vitest';
import { extraErrors, measureTexts } from './e2e.ts';

describe('measureTexts', () => {
  it('counts English UI text against all lettered text, leaving out data and Korean', () => {
    const summary = measureTexts(['Projects', '프로젝트', 'demo-nixpacks', 'https://example.com', '42', 'Add a new server', '서버 추가', '']);

    expect(summary.total).toBe(6);
    expect(summary.english).toBe(2);
    expect(summary.korean).toBe(2);
    expect(summary.ratio).toBeCloseTo(2 / 6);
    expect(summary.englishSample).toEqual(['Projects', 'Add a new server']);
  });

  it('gives ratio 0 for a page without lettered text', () => {
    expect(measureTexts(['', '  ', '123']).ratio).toBe(0);
  });
});

describe('extraErrors', () => {
  it('lists errors seen only with the extension, ignoring numbers and addresses that change between runs', () => {
    const baseline = ['WebSocket connection to ws://127.0.0.1:6001/app/abc123 failed', 'Failed to load resource: 404'];
    const withExtension = ['WebSocket connection to ws://127.0.0.1:6001/app/def456 failed', 'Failed to load resource: 404', 'TypeError: x is not a function'];

    expect(extraErrors(withExtension, baseline)).toEqual(['TypeError: x is not a function']);
    expect(extraErrors(baseline, baseline)).toEqual([]);
  });

  it('ignores errors of the missing real-time service, whose count depends on how long a page stays open', () => {
    const baseline = ["WebSocket connection to 'ws://127.0.0.1:6001/app/x' failed"];
    const withExtension = ['Coolify could not connect to its real-time service. This will cause unusual problems on the UI if not fixed!', "WebSocket connection to 'ws://127.0.0.1:6001/app/y' failed"];

    expect(extraErrors(withExtension, baseline)).toEqual([]);
  });
});
