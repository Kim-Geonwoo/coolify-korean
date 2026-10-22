import { describe, expect, it } from 'vitest';
import type { WeblateUnit } from './client.ts';
import { brokenApproval, stateCounts } from './rehearsalPlan.ts';

const unit = (id: number, key: string, state: number, target = ''): WeblateUnit => ({ id, key, source: key, target, state });

describe('stateCounts', () => {
  it('counts units by Weblate state name', () => {
    expect(stateCounts([unit(1, 'a', 0), unit(2, 'b', 10), unit(3, 'c', 10), unit(4, 'd', 11), unit(5, 'e', 30), unit(6, 'f', 100), unit(7, 'g', 42)])).toEqual({
      empty: 1,
      'needs-editing': 2,
      'needs-rewriting': 1,
      approved: 1,
      'read-only': 1,
      'state-42': 1,
    });
  });
});

describe('brokenApproval', () => {
  const verbatim = ['cleanup deleted backups'];

  it('picks a confirmation string without placeholders and a translation that drops the phrase', () => {
    const units = [unit(1, 'Delete :name? Type cleanup deleted backups', 0), unit(2, 'Type cleanup deleted backups to confirm.', 10, '확인하려면 cleanup deleted backups를 입력하세요.'), unit(3, 'Save', 0)];

    const picked = brokenApproval(units, verbatim);
    expect(picked?.unit.id).toBe(2);
    expect(picked?.target).not.toContain('cleanup deleted backups');
  });

  it('finds nothing when every confirmation string is read-only or has placeholders', () => {
    expect(brokenApproval([unit(1, 'Type cleanup deleted backups to confirm.', 100), unit(2, 'Remove <0>cleanup deleted backups</0>', 0)], verbatim)).toBeUndefined();
  });
});
