import { describe, expect, it } from 'vitest';
import { mask, placeholderNames, unmask } from './masking.ts';

describe('placeholderNames', () => {
  it('unions catalog names with names Laravel would replace in the text', () => {
    expect(placeholderNames('Too many attempts. Try again in :seconds seconds.', [])).toEqual(['seconds']);
    expect(placeholderNames('v:version', ['version'])).toEqual(['version']);
    expect(placeholderNames('Time 12:30 at http://x.io', [])).toEqual([]);
  });
});

describe('mask and unmask', () => {
  it('turns placeholders into name tokens and back, keeping case variants', () => {
    const masked = mask('Delete :name? :Name and :NAME stay.', ['name']);

    expect(masked.text).toBe('Delete {{name}}? {{Name}} and {{NAME}} stay.');
    expect(unmask('{{name}}을(를) 삭제할까요? {{Name}}, {{NAME}}', masked)).toEqual({ text: ':name을(를) 삭제할까요? :Name, :NAME', missing: [], extra: [] });
  });

  it('replaces like strtr, longest name first and inside words', () => {
    expect(mask('Use :names and :name', ['name', 'names']).text).toBe('Use {{names}} and {{name}}');
    expect(mask('v:version', ['version']).text).toBe('v{{version}}');
  });

  it('reports missing and extra tokens as multisets', () => {
    const masked = mask(':count of :count items for :name', ['count', 'name']);

    expect(unmask('{{count}}개 {{name}} {{other}}', masked)).toEqual({ text: ':count개 :name {{other}}', missing: ['{{count}}'], extra: ['{{other}}'] });
  });

  it('keeps literal {{…}} text as protected pieces, placeholders inside included', () => {
    const masked = mask('Added :key as {{vault.:key}}.', ['key']);

    expect(masked.text).toBe('Added {{key}} as {{KEEP_1}}.');
    expect(unmask('{{key}}을(를) {{KEEP_1}}(으)로 추가했습니다.', masked)).toEqual({ text: ':key을(를) {{vault.:key}}(으)로 추가했습니다.', missing: [], extra: [] });
    expect(unmask('{{key}}을(를) 추가했습니다.', masked).missing).toEqual(['{{KEEP_1}}']);
  });

  it('refuses braces it cannot pair', () => {
    expect(() => mask('Use {{ to open a block', [])).toThrow(/\{\{/);
  });
});
