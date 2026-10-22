import { describe, expect, it } from 'vitest';
import { stepTimeout } from './budget.ts';

const MIN = 60_000;

describe('stepTimeout', () => {
  it('gives a step its own cap while the overall deadline is far', () => {
    expect(stepTimeout(30 * MIN, 100 * MIN, 0)).toBe(30 * MIN);
  });

  it('shortens a step so five minutes stay for taking the test instance down', () => {
    expect(stepTimeout(30 * MIN, 20 * MIN, 0)).toBe(15 * MIN);
  });

  it('refuses to start a step when there is no time left for it and the cleanup', () => {
    expect(() => stepTimeout(30 * MIN, 6 * MIN, 0)).toThrow('시간');
  });
});
