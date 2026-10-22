import { describe, expect, it } from 'vitest';
import { originPattern, parseOrigin } from './origins.ts';

describe('parseOrigin', () => {
  it('keeps scheme, host and port of http(s) pages and drops the rest', () => {
    expect(parseOrigin('http://127.0.0.1:18090/project/demo?x=1')).toBe('http://127.0.0.1:18090');
    expect(parseOrigin('https://coolify.example.com/')).toBe('https://coolify.example.com');
  });

  it('returns null for other schemes and broken addresses', () => {
    expect(parseOrigin('chrome://extensions')).toBeNull();
    expect(parseOrigin('file:///C:/x.html')).toBeNull();
    expect(parseOrigin('not a url')).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
  });
});

describe('originPattern', () => {
  it('keeps the port for Chrome, whose match patterns compare ports', () => {
    expect(originPattern('http://127.0.0.1:18090', false)).toBe('http://127.0.0.1:18090/*');
  });

  it('drops the port for Firefox, whose match patterns cannot carry one', () => {
    expect(originPattern('http://127.0.0.1:18090', true)).toBe('http://127.0.0.1/*');
    expect(originPattern('https://coolify.example.com', true)).toBe('https://coolify.example.com/*');
  });
});
