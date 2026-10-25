// The brief page's keys (client/src/components/ThumbKeys.tsx), as a pure rule: which key asks for what. 1–6 only ever
// ask to pick (the page opens the confirm, never decides), and only in a manager's review; a held key repeats only
// the arrows.

import { describe, expect, it } from 'vitest';
import { THUMB_KEYS, thumbKeyAction } from '../client/src/components/ThumbKeys';
import { MAX_OPTIONS } from '../shared/workflow';

const press = (key: string, manager = false, repeat = false) => thumbKeyAction({ key, repeat }, manager);

describe('the brief page’s keys', () => {
  it('gives 1 to 6 to managers only, as a pick to confirm, and nothing past the last option', () => {
    expect(press('1', true)).toEqual({ kind: 'pick', index: 0 });
    expect(press(String(MAX_OPTIONS), true)).toEqual({ kind: 'pick', index: MAX_OPTIONS - 1 });
    expect(press(String(MAX_OPTIONS + 1), true)).toBeNull();
    expect(press('0', true)).toBeNull();
    expect(press('1')).toBeNull();
  });

  it('maps the letters either case, and the arrows', () => {
    expect(['f', 'S', 'g', 'L', 'ArrowLeft', 'ArrowRight'].map((k) => press(k)?.kind)).toEqual(['feed', 'squint', 'grey', 'lights', 'prev', 'next']);
    expect(press('x')).toBeNull();
    expect(press('Enter')).toBeNull();
  });

  it('repeats only the arrows while a key is held', () => {
    expect(press('ArrowRight', false, true)).toEqual({ kind: 'next' });
    expect(press('l', false, true)).toBeNull();
    expect(press('2', true, true)).toBeNull();
  });

  it('lists the pick keys as managers’ only', () => {
    expect(THUMB_KEYS.filter((k) => k.managers).map((k) => k.keys)).toEqual([`1–${MAX_OPTIONS}`]);
  });
});
