import { describe, expect, it } from 'vitest';
import { hardIssues, softReport } from './validate.ts';
import type { Glossary } from './glossary.ts';

const item = (source: string, kind = 'text', placeholders: string[] = []) => ({ source, kind, placeholders });

describe('hardIssues', () => {
  it('passes a clean translation', () => {
    expect(hardIssues(item('Delete :name?', 'text', ['name']), ':name을(를) 삭제할까요?')).toEqual([]);
  });

  it('flags empty output and leftover tokens', () => {
    expect(hardIssues(item('Save'), '  ')).toContain('empty');
    expect(hardIssues(item('Hi :name', 'text', ['name']), '안녕 {{name}}')).toContain('leftover-token');
  });

  it('lets plural strings collapse to one Korean form but not change the number of forms otherwise', () => {
    const plural = item(':count resource uses|:count resources use', 'plural', ['count']);

    expect(hardIssues(plural, ':count개의 리소스가 사용합니다')).toEqual([]);
    expect(hardIssues(plural, ':count개|:count개|:count개')).toContain('plural-shape');
    expect(hardIssues(plural, '리소스가 사용합니다')).toContain('placeholder-mismatch');
  });

  it('requires raw HTML tags to stay exactly the same, attributes included', () => {
    const raw = item("<span class='text-helper'>Examples</span><br>For Public repo");

    expect(hardIssues(raw, "<span class='text-helper'>예시</span><br>공개 저장소")).toEqual([]);
    expect(hardIssues(raw, '<span class="text-helper">예시</span><br>공개 저장소')).toContain('raw-html-shape');
    expect(hardIssues(raw, "<span class='text-helper'>예시</span> 공개 저장소")).toContain('raw-html-shape');
  });

  it('applies message rules when any use of the key is a message', () => {
    const shared = { source: 'The database must be running to start a backup.', kind: 'prop-literal', kinds: ['prop-literal', 'toast'], placeholders: [] };

    expect(hardIssues(shared, '백업을 시작하려면 데이터베이스가 실행 중이어야 합니다.\n')).toContain('whitespace-shape');
  });

  it('allows literal braces the source already had', () => {
    const literal = item('Added :key as {{vault.:key}}.', 'toast', ['key']);

    expect(hardIssues(literal, ':key을(를) {{vault.:key}}(으)로 추가했습니다.')).toEqual([]);
    expect(hardIssues(literal, ':key을(를) {{vault.:key}} {{KEEP_1}} 추가했습니다.')).toContain('leftover-token');
  });

  it('flags placeholder multiset differences', () => {
    expect(hardIssues(item(':count of :count', 'text', ['count']), ':count개')).toContain('placeholder-mismatch');
    expect(hardIssues(item('Hi :name', 'text', ['name']), '안녕 :name :other')).toEqual([]);
    expect(hardIssues(item('Hi :name', 'text', ['name']), '안녕 :Name')).toContain('placeholder-mismatch');
  });

  it('checks numbered tags with the same rules as the PHP helpers', () => {
    const source = 'Use <0>this link</0> now.<1/>';
    expect(hardIssues(item(source), '지금 <0>이 링크</0>를 쓰세요.<1/>')).toEqual([]);
    for (const broken of ['링크를 쓰세요<1/>', '<0>링크</0><5/><1/>', '<0>링크</0><0>또</0><1/>', '<0>링크<1/>', '<1>링크</1><0/>', '<0>가 <1/></0></1>']) {
      expect(hardIssues(item(source), broken), broken).toContain('tag-structure');
    }
  });

  it('flags markup the source did not have', () => {
    expect(hardIssues(item('Saved.'), '<a href="https://evil">저장</a>됨')).toContain('new-markup');
    expect(hardIssues(item('Use &lt;tenant ID&gt; here'), '여기에 &lt;tenant ID&gt;를 쓰세요')).toEqual([]);
    expect(hardIssues(item('Operators such as &lt; are blocked.'), '&lt;, &lt; 같은 연산자는 막힙니다.')).toContain('new-markup');
    expect(hardIssues(item('A &amp; B'), 'A &amp; B &nbsp;')).toContain('new-markup');
  });

  it('flags invisible control characters', () => {
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    const rightToLeftOverride = String.fromCodePoint(0x202e);

    expect(hardIssues(item('Save'), `저${zeroWidthSpace}장`)).toContain('control-char');
    expect(hardIssues(item('Save'), `저장${rightToLeftOverride}`)).toContain('control-char');
  });

  it('keeps line breaks and outer spaces of toast bodies', () => {
    expect(hardIssues(item('Invalid file.\n:detail', 'toast', ['detail']), '잘못된 파일입니다.\n:detail')).toEqual([]);
    expect(hardIssues(item('Invalid file.\n:detail', 'toast', ['detail']), '잘못된 파일입니다. :detail')).toContain('whitespace-shape');
    expect(hardIssues(item('Done. ', 'toast'), '완료했습니다.')).toContain('whitespace-shape');
  });
});

describe('softReport', () => {
  const glossary: Glossary = {
    terms: [
      { en: 'Container', ko: '컨테이너' },
      { en: 'Environment Variables', ko: '환경 변수' },
      { en: 'Deploy', ko: '배포' },
    ],
    brands: ['Docker', 'GitHub'],
  };

  it('finds glossary terms the translation dropped', () => {
    expect(softReport(item('Restart the container.'), '다시 시작합니다.', glossary).glossaryMissing).toEqual(['Container']);
    expect(softReport(item('Edit Environment Variables'), '환경 변수 편집', glossary).glossaryMissing).toEqual([]);
  });

  it('counts plain English words copied from the source, not brands or technical tokens', () => {
    const report = softReport(item('Restart the Docker container on port 8080 via https://x.io and CPU limits'), 'Docker container를 port 8080에서 https://x.io로 다시 시작, CPU limits', glossary);

    expect(report.englishResidue).toEqual(['container', 'port', 'limits']);
  });

  it('does not expect glossary terms that only appear as placeholder names', () => {
    const registry: Glossary = { terms: [{ en: 'Registry', ko: '레지스트리' }], brands: [] };

    expect(softReport(item('Log in to :registry', 'prop-text', ['registry']), ':registry에 로그인', registry).glossaryMissing).toEqual([]);
  });

  it('does not count words inside placeholder names as English residue', () => {
    const fields = item('Set the required fields first: :fields_list', 'toast', ['fields_list']);
    const port = item('Port <0>:unrecognized_port</0> is not listed.', 'rich', ['unrecognized_port']);

    expect(softReport(fields, '먼저 필수 필드를 설정하십시오: :fields_list', glossary).englishResidue).toEqual([]);
    expect(softReport(port, '포트 <0>:unrecognized_port</0>이(가) 목록에 없습니다.', glossary).englishResidue).toEqual([]);
  });

  it('measures endings and label length', () => {
    expect(softReport(item('Server saved.', 'toast'), '서버를 저장했습니다.', glossary).formalEnding).toBe(true);
    expect(softReport(item('Server saved.', 'toast'), '서버를 저장했어요.', glossary).formalEnding).toBe(false);
    expect(softReport(item('Save', 'text'), '저장', glossary).nounLabel).toBe(true);
    expect(softReport(item('Save', 'text'), '저장합니다', glossary).nounLabel).toBe(false);
    expect(softReport(item('Save', 'text'), '변경 사항을 지금 바로 저장하기', glossary).tooLong).toBe(true);
  });
});
