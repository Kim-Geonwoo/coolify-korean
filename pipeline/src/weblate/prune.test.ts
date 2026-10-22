import { describe, expect, it } from 'vitest';
import { checkIntegrity, sourceHash } from '../i18n/integrity.ts';
import { pruneWeblateOutputs } from './prune.ts';

// 새 버전 카탈로그: Remove는 지워졌고, Delete의 영어가 바뀌었다
const catalog = {
  version: '4.4.7',
  keys: {
    Save: { english: 'Save', kinds: ['text'], placeholders: [] },
    'Delete :name?': { english: 'Delete :name permanently?', kinds: ['text'], placeholders: ['name'] },
    'Rename :name': { english: 'Rename :name', kinds: ['text'], placeholders: ['name'] },
    nginx: { english: 'nginx', kinds: ['prop-text'], placeholders: [] },
  },
};
const exclusions = new Map([['nginx', '예시 값']]);

describe('pruneWeblateOutputs', () => {
  it('drops reviewed and pending strings a new release made stale, so the night verify passes even when Weblate is down', () => {
    const before = {
      reviewed: { Save: '저장', 'Delete :name?': ':name을(를) 삭제할까요?', Remove: '제거' },
      meta: { Save: { sourceHash: sourceHash('Save') }, 'Delete :name?': { sourceHash: sourceHash('Delete :name?') }, Remove: { sourceHash: sourceHash('Remove') } },
      pending: { Remove: '지우기', 'Rename :name': '이름 바꾸기', Save: '저장하기' },
    };
    // 그대로 두면 무결성 검사가 verify를 멈춘다
    expect(checkIntegrity({ catalog, stateVersion: '4.4.7', exclusions, reviewed: before.reviewed, reviewedMeta: before.meta, pending: before.pending })).not.toEqual([]);

    const after = pruneWeblateOutputs({ catalog, exclusions, verbatim: [], ...before });

    expect(after.reviewed).toEqual({ Save: '저장' });
    expect(after.meta).toEqual({ Save: { sourceHash: sourceHash('Save') } });
    expect(after.pending).toEqual({ Save: '저장하기' });
    expect(after.removed).toEqual(['reviewed:Delete :name?', 'reviewed:Remove', 'pending:Remove', 'pending:Rename :name']);
    expect(checkIntegrity({ catalog, stateVersion: '4.4.7', exclusions, verbatim: [], reviewed: after.reviewed, reviewedMeta: after.meta, pending: after.pending })).toEqual([]);
  });

  it('changes nothing when everything is still current', () => {
    const current = { reviewed: { Save: '저장' }, meta: { Save: { sourceHash: sourceHash('Save') } }, pending: {} };

    expect(pruneWeblateOutputs({ catalog, exclusions, verbatim: [], ...current })).toEqual({ ...current, removed: [] });
  });
});
