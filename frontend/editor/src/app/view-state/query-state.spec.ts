import { Component, effect } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Location } from '@angular/common';

import {
  idParam,
  intParam,
  listParam,
  oneOfParam,
  textParam,
} from './query-params';
import { injectQueryState } from './query-state';

const PARAMS = {
  q: textParam(),
  type: oneOfParam(['concept', 'procedure'] as const),
  id: idParam(/^[a-z]+$/),
  keyword: listParam(/^[a-z]+$/),
  page: intParam(1),
  size: intParam(50, { only: [25, 50, 100] }),
};

let reads = 0;

@Component({ selector: 'of-test-screen', template: '' })
class ScreenComponent {
  readonly view = injectQueryState(PARAMS);
  constructor() {
    effect(() => {
      this.view.values();
      reads++;
    });
  }
}

async function setup(url = '/screen') {
  reads = 0;
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'screen', component: ScreenComponent }]),
    ],
  });
  const harness = await RouterTestingHarness.create();
  // Listens to Back and Forward (`popstate`), as the app's first navigation does.
  TestBed.inject(Router).initialNavigation();
  const screen = await harness.navigateByUrl(url, ScreenComponent);
  const router = TestBed.inject(Router);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    harness,
    screen,
    router,
    settle,
    location: TestBed.inject(Location),
  };
}

describe('injectQueryState', () => {
  it('reads the address, with the defaults for what it leaves out', async () => {
    const { screen } = await setup(
      '/screen?type=procedure&keyword=a&keyword=b&page=3&q=battery',
    );
    expect(screen.view.values()).toEqual({
      q: 'battery',
      type: 'procedure',
      id: undefined,
      keyword: ['a', 'b'],
      page: 3,
      size: 50,
    });
  });

  it('drops invalid values and written-out defaults from the address, keeping the rest', async () => {
    const { router, screen } = await setup(
      '/screen?type=nope&page=0&size=7&keyword=ok&keyword=NO&id=x&id=y&cs=keep&q=%20&size=50',
    );
    expect(screen.view.values().keyword).toEqual(['ok']);
    expect(screen.view.values().page).toBe(1);
    // Parameters it does not own (`cs`) are left alone.
    expect(router.url).toBe('/screen?keyword=ok&cs=keep');
  });

  it('a clean screen has a clean address', async () => {
    const { router, screen, settle } = await setup('/screen?page=2');
    screen.view.reset();
    await settle();
    expect(router.url).toBe('/screen');
  });

  it('adds a history entry per choice, so Back and Forward step through them', async () => {
    const { router, screen, settle, location } = await setup();
    screen.view.set({ type: 'concept' });
    await settle();
    screen.view.set({ page: 2 });
    await settle();
    expect(router.url).toBe('/screen?type=concept&page=2');
    location.back();
    await settle();
    expect(screen.view.values().page).toBe(1);
    expect(screen.view.values().type).toBe('concept');
    location.back();
    await settle();
    expect(screen.view.values().type).toBeUndefined();
    location.forward();
    await settle();
    expect(screen.view.values().type).toBe('concept');
  });

  it('counts a run of typing as one step, replaced while nothing else changes', async () => {
    const { router, screen, settle, location } = await setup();
    screen.view.set({ type: 'concept' });
    await settle();
    screen.view.set({ q: 'bat' });
    await settle();
    screen.view.set({ q: 'battery' });
    await settle();
    expect(router.url).toBe('/screen?type=concept&q=battery');
    location.back();
    await settle();
    expect(router.url).toBe('/screen?type=concept');
    // A choice in between starts a new run.
    location.forward();
    await settle();
    screen.view.set({ page: 2 });
    await settle();
    screen.view.set({ q: 'charger' });
    await settle();
    location.back();
    await settle();
    expect(router.url).toBe('/screen?type=concept&q=battery&page=2');
  });

  it('adds up two quick changes, and does not read again for the same view', async () => {
    const { router, screen, settle } = await setup();
    const before = reads;
    screen.view.set({ type: 'concept' });
    screen.view.set({ page: 4 });
    await settle();
    expect(router.url).toBe('/screen?type=concept&page=4');
    const after = reads;
    expect(after).toBeGreaterThan(before);
    // The same values (written differently): nothing navigates, nothing reads again.
    screen.view.set({ page: 4 });
    await router.navigateByUrl('/screen?page=4&type=concept');
    await settle();
    expect(reads).toBe(after);
  });

  it('navigates nowhere once the screen is left', async () => {
    const { router, screen, settle, harness } = await setup();
    await harness.navigateByUrl('/');
    screen.view.set({ page: 2 });
    await settle();
    expect(router.url).toBe('/');
  });

  it('builds on a navigation under way on the same screen, rather than undoing it', async () => {
    const { router, screen, settle } = await setup('/screen?cs=x');
    // Another owner (the change set) is writing the address.
    void router.navigateByUrl('/screen?cs=y');
    screen.view.set({ page: 2 });
    await settle();
    expect(router.url).toBe('/screen?cs=y&page=2');
  });
});
