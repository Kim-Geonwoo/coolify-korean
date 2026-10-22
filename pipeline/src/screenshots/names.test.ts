import { describe, expect, it } from 'vitest';
import { shotName } from './names.ts';

describe('shotName', () => {
  it('names a page by its screen, later parts by number and opened dialogs by their button', () => {
    expect(shotName({ path: '/server/bulajpaicdzqi0jx0fe7qzar/proxy' })).toBe('/server/{id}/proxy');
    expect(shotName({ path: '/servers', part: 1 })).toBe('/servers');
    expect(shotName({ path: '/servers', part: 3 })).toBe('/servers #3');
    expect(shotName({ path: '/security/private-key', modal: 'Add' })).toBe('/security/private-key › Add');
  });

  it('keeps names within the 200 characters Weblate stores', () => {
    expect(shotName({ path: `/${'a'.repeat(190)}`, modal: 'b'.repeat(80) })).toHaveLength(200);
  });
});
