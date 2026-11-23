import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';

import { MeService, NOBODY, UNCONFIRMED } from '../permissions/me';
import { RECENT_MAX, RecentItems, type RecentItem } from './recent-items';

const module = (id: string, lang = 'de'): RecentItem => ({
  kind: 'module',
  id,
  lang,
  title: `Title ${id}`,
});

function setup(userId = 'a') {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  const me = TestBed.inject(MeService);
  me.set({ ...NOBODY, id: userId });
  return { recents: TestBed.inject(RecentItems), me };
}

describe('RecentItems', () => {
  it('keeps the newest first, once each, at most RECENT_MAX', () => {
    const { recents } = setup();
    for (let i = 0; i < RECENT_MAX + 2; i++) recents.add(module(`m${i}`));
    recents.add(module('m3'));
    const ids = recents.items().map((i) => i.id);
    expect(ids).toHaveLength(RECENT_MAX);
    expect(ids[0]).toBe('m3');
    expect(new Set(ids).size).toBe(ids.length);
    // The same module in another language is another item.
    recents.add(module('m3', 'en'));
    expect(recents.items().slice(0, 2)).toEqual([
      module('m3', 'en'),
      module('m3'),
    ]);
  });

  it('is per viewer: another person sees their own list', () => {
    const { recents, me } = setup('a');
    recents.add(module('mine'));
    me.set({ ...NOBODY, id: 'b' });
    expect(recents.items()).toEqual([]);
    recents.add({ kind: 'manual', id: 'guide', title: 'Guide' });
    me.set({ ...NOBODY, id: 'a' });
    expect(recents.items().map((i) => i.id)).toEqual(['mine']);
  });

  it('remembers nothing until it knows who is acting', () => {
    const { recents, me } = setup('a');
    me.set(NOBODY);
    recents.add(module('x'));
    expect(recents.items()).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('keeps nothing while another tab’s sign-in is unconfirmed here (#716)', () => {
    const { recents, me } = setup('a');
    localStorage.clear();
    me.set({ ...NOBODY, id: `${UNCONFIRMED}x` });
    recents.add(module('x'));
    expect(recents.items()).toEqual([]);
    expect(localStorage.length).toBe(0);
  });

  it('ignores stored data that is not a list of its items', () => {
    const { recents } = setup('a');
    localStorage.setItem('openfolia.recent.a', '{not json');
    expect(recents.items()).toEqual([]);
    localStorage.setItem(
      'openfolia.recent.a',
      JSON.stringify([
        module('ok'),
        { kind: 'module', id: '../etc', lang: 'de', title: 'x' },
        { kind: 'manual', id: 'm', lang: 'de', title: 'x' },
        { kind: 'other', id: 'x', title: 'x' },
        { kind: 'module', id: 'no-lang', title: 'x' },
        'text',
      ]),
    );
    recents.add(module('next'));
    expect(recents.items().map((i) => i.id)).toEqual(['next', 'ok']);
  });

  it('works without storage', () => {
    const { recents } = setup('a');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => recents.add(module('x'))).not.toThrow();
    expect(recents.items()).toEqual([]);
  });
});
