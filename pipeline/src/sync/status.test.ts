import { describe, expect, it } from 'vitest';
import { discordMessage, emptyStatus, recordFailure, recordSuccess } from './status.ts';

describe('failure memory', () => {
  it('counts the same failure in a row and turns the stage off at three', () => {
    let status = emptyStatus();
    status = recordFailure(status, 'extract', 'docker-build', '2026-10-18T00:20:00Z');
    status = recordFailure(status, 'extract', 'docker-build', '2026-10-19T00:20:00Z');

    expect(status.failures.extract).toEqual({ code: 'docker-build', count: 2, since: '2026-10-18T00:20:00Z' });
    expect(status.disabled).toEqual([]);

    status = recordFailure(status, 'extract', 'docker-build', '2026-10-20T00:20:00Z');
    expect(status.disabled).toEqual(['extract']);
  });

  it('starts counting again when the failure changes, and forgets it after a success', () => {
    let status = recordFailure(recordFailure(emptyStatus(), 'review', 'quota-daily', 't1'), 'review', 'http', 't2');

    expect(status.failures.review).toEqual({ code: 'http', count: 1, since: 't2' });

    status = recordSuccess(status, 'review', 't3');
    expect(status.failures.review).toBeUndefined();
    expect(status.lastSuccess).toBe('t3');
  });
});

describe('discordMessage', () => {
  it('reports a processed version with counts and the compare link, without logs or arguments', () => {
    const text = discordMessage({ type: 'version', version: '4.4.7', added: 12, changed: 1, removed: 3, drafted: 11, fallbacks: 1, normalized: 4, pending: 0, compare: 'https://github.com/Kim-Geonwoo/coolify-ko/compare/dev...bot/i18n' });

    expect(text).toBe('coolify-ko 4.4.7 처리: 새 키 12 · 바뀐 키 1 · 없어진 키 3 · 초안 11(폴백 1, 정규화 4)\n받을 결과: https://github.com/Kim-Geonwoo/coolify-ko/compare/dev...bot/i18n');
  });

  it('says how many keys are left for the next night when the deadline cut the drafting short', () => {
    const text = discordMessage({ type: 'version', version: '4.5.0', added: 631, changed: 0, removed: 2, drafted: 231, fallbacks: 0, normalized: 9, pending: 400, compare: 'https://github.com/Kim-Geonwoo/coolify-ko/pull/12' });

    expect(text).toBe('coolify-ko 4.5.0 처리: 새 키 631 · 바뀐 키 0 · 없어진 키 2 · 초안 231(폴백 0, 정규화 9) · 남은 키 400(다음 밤에 이어서)\n받을 결과: https://github.com/Kim-Geonwoo/coolify-ko/pull/12');
  });

  it('reports failures by stage and short code only', () => {
    expect(discordMessage({ type: 'failure', stage: 'extract', code: 'docker-build', count: 3, disabled: true })).toBe('coolify-ko 밤 작업 실패: extract (docker-build), 3번째. 이 단계를 껐습니다. 확인이 필요합니다.');
    expect(discordMessage({ type: 'failure', stage: 'push', code: 'rejected', count: 1, disabled: false })).toBe('coolify-ko 밤 작업 실패: push (rejected), 1번째.');
    expect(discordMessage({ type: 'stop', reason: 'regress', detail: '4.4.7 → 4.4.6' })).toBe('coolify-ko 업스트림 이상: regress (4.4.7 → 4.4.6). 사람이 확인할 때까지 처리하지 않습니다.');
  });

  it('reports approved translations left out by the repository checks', () => {
    expect(discordMessage({ type: 'rejected', keys: ['A', 'B', 'C', 'D'] })).toBe('coolify-ko 승인됐지만 검사에 걸려 뺀 번역 4개: A · B · C …');
    expect(discordMessage({ type: 'rejected', keys: ['A'] })).toBe('coolify-ko 승인됐지만 검사에 걸려 뺀 번역 1개: A');
  });

  it('caps long free text so a message never carries a log dump', () => {
    const text = discordMessage({ type: 'failure', stage: 'x'.repeat(500), code: 'y'.repeat(500), count: 1, disabled: false });

    expect(text.length).toBeLessThanOrEqual(300);
  });
});
