import { describe, expect, it } from 'vitest';
import { normalize } from './normalize.ts';

const text = (translation: string, names: string[] = []): string => normalize(translation, names).text;

describe('requests end in 하세요', () => {
  it('turns every sentence-final 십시오 into 세요, also before tags and colons', () => {
    expect(text('저장하십시오. 그런 다음 다시 시도하십시오.')).toBe('저장하세요. 그런 다음 다시 시도하세요.');
    expect(text('다음 명령을 실행하십시오: <0>docker ps</0>')).toBe('다음 명령을 실행하세요: <0>docker ps</0>');
    expect(text('<1>문서를 읽으십시오</1>')).toBe('<1>문서를 읽으세요</1>');
    expect(text('잠시 기다려 주십시오')).toBe('잠시 기다려 주세요');
  });

  it('leaves quoted text and words that continue after 십시오 alone', () => {
    expect(text('‘확인을 누르십시오’라는 안내가 보이면 닫으세요.')).toBe('‘확인을 누르십시오’라는 안내가 보이면 닫으세요.');
    expect(text('"다시 시도하십시오" 문구')).toBe('"다시 시도하십시오" 문구');
    expect(text('하십시오라는 표현')).toBe('하십시오라는 표현');
  });
});

describe('particles after values that change at run time', () => {
  it('pairs a one-sided particle right after a placeholder', () => {
    expect(text(':fields_list을 설정하세요', ['fields_list'])).toBe(':fields_list을(를) 설정하세요');
    expect(text(':name가 시작되었습니다.', ['name'])).toBe(':name이(가) 시작되었습니다.');
    expect(text(':name는 비어 있습니다.', ['name'])).toBe(':name은(는) 비어 있습니다.');
    expect(text(':name와 연결합니다.', ['name'])).toBe(':name와(과) 연결합니다.');
    expect(text(':name로 이동합니다.', ['name'])).toBe(':name(으)로 이동합니다.');
    expect(text(':name이라는 이름', ['name'])).toBe(':name(이)라는 이름');
    expect(text('도메인은 :change였지만 그대로 두었습니다.', ['change'])).toBe('도메인은 :change(이)었지만 그대로 두었습니다.');
  });

  it('leaves units, words and other particles that do not change with the value', () => {
    expect(text(':minutes_to_wait분을 더 기다리세요.', ['minutes_to_wait'])).toBe(':minutes_to_wait분을 더 기다리세요.');
    expect(text(':count가지 방법', ['count'])).toBe(':count가지 방법');
    expect(text(':name이미지를 받습니다.', ['name'])).toBe(':name이미지를 받습니다.');
    expect(text(':service로그를 봅니다.', ['service'])).toBe(':service로그를 봅니다.');
    expect(text(':registry에 로그인', ['registry'])).toBe(':registry에 로그인');
    expect(text(':name의 설정', ['name'])).toBe(':name의 설정');
  });

  it('keeps pairs that are already written and fixes the non-standard order', () => {
    expect(text(':name을(를) 삭제합니다.', ['name'])).toBe(':name을(를) 삭제합니다.');
    expect(text(':value(이)가 이 태그를 씁니다.', ['value'])).toBe(':value이(가) 이 태그를 씁니다.');
    expect(text(':name를(을) 지웁니다.', ['name'])).toBe(':name을(를) 지웁니다.');
  });

  it('chooses by the final consonant when a tag wraps Korean text, and pairs after Latin or placeholders', () => {
    expect(text('자세한 내용은 <5>문서</5>를 참조하세요.')).toBe('자세한 내용은 <5>문서</5>를 참조하세요.');
    expect(text('자세한 내용은 <5>문서</5>을 참조하세요.')).toBe('자세한 내용은 <5>문서</5>를 참조하세요.');
    expect(text('<0>설정 파일</0>로 이동합니다.')).toBe('<0>설정 파일</0>로 이동합니다.');
    expect(text('<0>Docker</0>를 설치합니다.')).toBe('<0>Docker</0>을(를) 설치합니다.');
    expect(text('포트 <0>:port</0>는 쓰이지 않습니다.', ['port'])).toBe('포트 <0>:port</0>은(는) 쓰이지 않습니다.');
  });

  it('never touches what follows a void tag, but warns', () => {
    const result = normalize('첫 줄입니다.<1/>이 설정은 나중에 바꿀 수 있습니다.', []);

    expect(result.text).toBe('첫 줄입니다.<1/>이 설정은 나중에 바꿀 수 있습니다.');
    expect(result.warnings).toEqual(['void-tag-particle']);
  });
});

describe('normalize', () => {
  it('is idempotent and records every edit', () => {
    const once = normalize(':name를 저장하십시오.', ['name']);

    expect(once.text).toBe(':name을(를) 저장하세요.');
    expect(once.edits.map((e) => [e.rule, e.before, e.after])).toEqual([
      ['particle', '를', '을(를)'],
      ['imperative', '십시오', '세요'],
    ]);
    expect(normalize(once.text, ['name'])).toEqual({ text: once.text, edits: [], warnings: [] });
  });
});

describe('Korean plural keys', () => {
  it('keeps one form for a plural key, since Korean does not change with the count (Laravel uses a single form for every count)', () => {
    const result = normalize('도메인 :count개|도메인들 :count개', ['count'], { plural: true });

    expect(result.text).toBe('도메인 :count개');
    expect(result.edits.map((edit) => edit.rule)).toEqual(['plural-single']);
  });

  it('leaves a bar alone in keys that are not plural', () => {
    expect(normalize('상태 | 이름', [], {}).text).toBe('상태 | 이름');
    expect(normalize('도메인 :count개', ['count'], { plural: true }).edits).toEqual([]);
  });
});
