import { describe, expect, it } from 'vitest';
import { zip } from './pack.ts';
import { xpiInfo } from './xpi.ts';

const manifest = (version: string): Buffer => Buffer.from(JSON.stringify({ manifest_version: 3, version, browser_specific_settings: { gecko: { id: 'coolify-ko@unofficial' } } }));

describe('xpiInfo', () => {
  it('reads the add-on id and version from the packed manifest', () => {
    expect(xpiInfo(zip([['manifest.json', manifest('0.1.1')], ['content.js', Buffer.from('(() => {})();\n')]]))).toEqual({ id: 'coolify-ko@unofficial', version: '0.1.1', signed: false });
  });

  it('sees the signature files that addons.mozilla.org adds', () => {
    const signed = zip([['manifest.json', manifest('0.1.1')], ['META-INF/cose.sig', Buffer.from('sig')], ['META-INF/mozilla.rsa', Buffer.from('rsa')]]);

    expect(xpiInfo(signed).signed).toBe(true);
  });

  it.each([
    ['not a zip', Buffer.from('hello')],
    ['no manifest', zip([['content.js', Buffer.from('x')]])],
    ['a manifest without a gecko id', zip([['manifest.json', Buffer.from('{"version":"0.1.1"}')]])],
    ['a bad version', zip([['manifest.json', manifest('latest')]])],
  ])('refuses %s', (_label, bytes) => {
    expect(() => xpiInfo(bytes)).toThrow();
  });
});
