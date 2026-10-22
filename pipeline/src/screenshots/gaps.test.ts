import { describe, expect, it } from 'vitest';
import { looksUntranslated, screensDoneKey } from './gaps.ts';

describe('looksUntranslated', () => {
  it('keeps visible English UI text that the overlay did not wrap', () => {
    expect(looksUntranslated('Observe & troubleshoot')).toBe(true);
    expect(looksUntranslated('Search this page and everything (Press / or Ctrl+K, then Tab to switch)')).toBe(true);
    expect(looksUntranslated('Loading...')).toBe(true);
  });

  it('drops data and identifiers: example resources, hosts, addresses, versions, numbers, single short tokens', () => {
    for (const text of ['demo-nixpacks', 'localhost', 'https://hello.apps.example.com', 'invitee@example.com', 'v4.4.6', '4.4.6', '127.0.0.1:8000', '/data/coolify', '12', 'OK', 'nginx:alpine', 'Ctrl+K', 'coollabsio/coolify-examples', '']) {
      expect(looksUntranslated(text), text).toBe(false);
    }
  });
});

describe('screensDoneKey', () => {
  it('names what was captured by version and the capture inputs, so changed capture code or new strings are captured again', () => {
    const ids = ['a'.repeat(40), 'b'.repeat(40)];
    const key = screensDoneKey('4.4.6', ids);

    expect(key).toMatch(/^4\.4\.6\+[0-9a-f]{12}$/);
    expect(screensDoneKey('4.4.6', ids)).toBe(key);
    expect(screensDoneKey('4.4.6', ['a'.repeat(40), 'c'.repeat(40)])).not.toBe(key);
  });
});
