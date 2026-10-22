import { describe, expect, it } from 'vitest';
import { keyedPseudo, keysOf, markerIds, MARK, stripMarkers } from './markers.ts';

describe('keyedPseudo', () => {
  it('wraps every English string with a short id that leads back to its key', () => {
    const { translations, keys } = keyedPseudo({ Save: 'Save', 'auth.throttle': 'Too many attempts.' });

    expect(keys).toEqual(['Save', 'auth.throttle']);
    expect(translations['Save']).toBe(`${MARK.open}0${MARK.mid}Save${MARK.close}`);
    expect(translations['auth.throttle']).toBe(`${MARK.open}1${MARK.mid}Too many attempts.${MARK.close}`);
  });
});

describe('markerIds and stripMarkers', () => {
  const nested = `Hi ${MARK.open}a${MARK.mid}Delete ${MARK.open}1z${MARK.mid}server${MARK.close}?${MARK.close} now`;

  it('finds every id in a text, nested ones too', () => {
    expect(markerIds(nested)).toEqual(['a', '1z']);
    expect(markerIds('plain text')).toEqual([]);
  });

  it('turns marked text back into the plain English the page would show', () => {
    expect(stripMarkers(nested)).toBe('Hi Delete server? now');
  });
});

describe('keysOf', () => {
  it('turns ids found on a page back into keys, ignoring ids it does not know', () => {
    const { keys } = keyedPseudo({ Save: 'Save', Cancel: 'Cancel', Delete: 'Delete' });

    expect(keysOf(['2', '0', 'zz'], keys)).toEqual(['Save', 'Cancel']);
  });
});
