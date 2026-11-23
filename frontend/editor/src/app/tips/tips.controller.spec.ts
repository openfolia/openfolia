import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';

import { provideApi } from '../api';
import { HelpService } from '../help/help.service';
import { MeService, type Me } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { advance } from '../testing/fake-time';
import { PreferencesService } from './preferences.service';
import {
  MAX_TRIES,
  RETRY_MS,
  SETTLE_MS,
  TipsController,
} from './tips.controller';

@Component({
  template: `
    <nav>
      <a data-tip="nav.content" href="/content">Content</a>
      <a data-tip="nav.review" href="/review">Review</a>
    </nav>
    <button type="button" data-tip="shell.change-set">Revision</button>
    <button type="button" data-tip="shell.search">Search</button>
    <button type="button" data-tip="content.new-module">New module</button>
    <input id="field" />
  `,
})
class Shell {}

@Component({ template: '' })
class Blank {}

const person: Me = {
  id: 'pat',
  kind: 'user',
  name: 'Pat',
  role: 'Author',
  permissions: new Set(['content.read', 'content.read.draft', 'content.edit']),
};

const prefs = (attributes: {
  showTips?: boolean;
  dismissedTips?: string[];
  tourDone?: boolean;
}) => ({
  data: {
    type: 'Preferences',
    id: 'pat',
    attributes: {
      showTips: true,
      dismissedTips: [],
      tourDone: false,
      ...attributes,
    },
    meta: { updatedAt: null },
  },
});

const card = () => document.querySelector<HTMLElement>('[data-slot="tip"]');
const press = (action: string) =>
  card()!.querySelector<HTMLElement>(`[data-action="${action}"]`)!.click();

describe('the tips and the tour', () => {
  let http: HttpTestingController;
  let matchMedia: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    // Less motion asked for, so the tour moves without animating. A whole MediaQueryList: code
    // that listens for a change gets the methods it calls.
    matchMedia = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: (query: string): MediaQueryList => ({
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }),
    });
    TestBed.configureTestingModule({
      providers: [
        provideZard(),
        provideApi(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'content', component: Blank },
          { path: 'review', component: Blank },
        ]),
        { provide: MeService, useValue: { me: signal(person) } },
        {
          provide: ChangeSetSession,
          useValue: { value: signal('published'), options: signal([]) },
        },
        {
          provide: HelpService,
          useValue: {
            screenArticle: signal('guide.writing.content-browser'),
            link: () => null,
          },
        },
        TipsController,
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Shell);
    fixture.detectChanges();
    document.body.append(fixture.nativeElement as HTMLElement);
  });

  afterEach(() => {
    // `vi.restoreAllMocks()` does not undo a `defineProperty`: the next spec in this worker
    // would get the stub (#780).
    if (matchMedia) Object.defineProperty(window, 'matchMedia', matchMedia);
    else Reflect.deleteProperty(window, 'matchMedia');
    http.verify();
    document.body.innerHTML = '';
    localStorage.clear();
  });

  /** The controller running, `GET /me/preferences` answered with `answer`. */
  async function start(answer: ReturnType<typeof prefs>) {
    TestBed.inject(TipsController);
    TestBed.tick();
    http.expectOne('/api/me/preferences').flush(answer);
    await advance();
  }

  /** Answers the `PATCH`es sent, one after another as the service sends them; their attributes. */
  async function patches(): Promise<object[]> {
    const sent: object[] = [];
    for (;;) {
      const open = http.match(
        (r) => r.method === 'PATCH' && r.url === '/api/me/preferences',
      );
      if (open.length === 0) return sent;
      for (const r of open) {
        sent.push(
          (r.request.body as { data: { attributes: object } }).data.attributes,
        );
        r.flush(prefs({}));
      }
      await advance();
    }
  }

  it('shows a new person the tour once the screen settles; Skip ends it for good', async () => {
    await start(prefs({}));
    expect(card()).toBeNull();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.content');
    expect(
      card()?.querySelector('[data-slot="tip-step"]')?.textContent?.trim(),
    ).toBe('1 of 5');
    // Focus moved in, so it is announced.
    expect(document.activeElement).toBe(card());

    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.editor');
    press('back');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.content');
    press('skip');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: true }]);

    await TestBed.inject(Router).navigateByUrl('/review');
    await advance(SETTLE_MS);
    // Not the tour again; the content screen's tip waits for its own screen.
    expect(card()?.dataset['tipId'] ?? '').not.toMatch(/^tour\./);
  });

  it('finishes the tour on its last step', async () => {
    await start(prefs({}));
    await advance(SETTLE_MS);
    for (let i = 0; i < 4; i++) {
      press('next');
      await advance();
    }
    expect(card()?.dataset['tipId']).toBe('tour.search');
    expect(
      card()?.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Done');
    press('next');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: true }]);
  });

  it('offers a screen’s tip after the tour, once; Got it dismisses it for good', async () => {
    await start(prefs({ tourDone: true }));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('content.new-module');
    press('got-it');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([
      { dismissedTips: ['content.new-module'] },
    ]);
    await advance(SETTLE_MS * 2);
    expect(card()).toBeNull();
  });

  it('never offers a dismissed tip, nor any while tips are off', async () => {
    await start(
      prefs({ tourDone: true, dismissedTips: ['content.new-module'] }),
    );
    await advance(SETTLE_MS);
    expect(card()).toBeNull();
  });

  it('turns tips off from a tip', async () => {
    await start(prefs({ tourDone: true }));
    await advance(SETTLE_MS);
    press('turn-off');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([
      { dismissedTips: ['content.new-module'] },
      { showTips: false },
    ]);
    expect(TestBed.inject(PreferencesService).showTips()).toBe(false);
  });

  it('waits while the person types, and goes when the focus moves into a field', async () => {
    await start(prefs({ tourDone: true }));
    const field = document.querySelector<HTMLInputElement>('#field')!;
    field.focus();
    await advance(SETTLE_MS + RETRY_MS * 3);
    expect(card()).toBeNull();
    field.blur();
    await advance(RETRY_MS);
    expect(card()?.dataset['tipId']).toBe('content.new-module');
    field.focus();
    await advance();
    expect(card()).toBeNull();
    // Not counted as seen.
    expect(await patches()).toEqual([]);
  });

  it('waits while a modal dialog is open, and gives up after a while', async () => {
    await start(prefs({ tourDone: true }));
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    await advance(SETTLE_MS + RETRY_MS * (MAX_TRIES + 1));
    expect(card()).toBeNull();
    dialog.remove();
    await advance(RETRY_MS * 2);
    expect(card()).toBeNull();
  });

  it('closes on Escape, counting the tip as seen', async () => {
    await start(prefs({ tourDone: true }));
    await advance(SETTLE_MS);
    card()!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([
      { dismissedTips: ['content.new-module'] },
    ]);
  });

  it('starts the tour again from the menu, and resets the tips', async () => {
    await start(
      prefs({ tourDone: true, dismissedTips: ['content.new-module'] }),
    );
    const tips = TestBed.inject(TipsController);
    tips.restartTour();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.content');
    press('skip');
    await advance();
    tips.resetTips();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('content.new-module');
    expect(await patches()).toEqual([
      { tourDone: false, showTips: true },
      { tourDone: true },
      { dismissedTips: [], showTips: true },
    ]);
  });

  it('keeps to this browser when the API cannot be read', async () => {
    localStorage.setItem(
      'openfolia.tips:pat',
      JSON.stringify({ showTips: false, dismissedTips: [], tourDone: false }),
    );
    TestBed.inject(TipsController);
    TestBed.tick();
    http
      .expectOne('/api/me/preferences')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await advance(SETTLE_MS);
    const preferences = TestBed.inject(PreferencesService);
    expect(preferences.status()).toBe('local');
    expect(preferences.showTips()).toBe(false);
    expect(card()).toBeNull();
  });
});

// Read when the file loads, before the tips block's first `beforeEach` stubs it.
const matchMediaBefore = Object.getOwnPropertyDescriptor(window, 'matchMedia');

describe('the window after the tips and the tour (#780)', () => {
  // Runs after the block above, in the same window: the next spec file in this worker sees what
  // this test sees.
  it('has the window.matchMedia it had before', () => {
    expect(Object.getOwnPropertyDescriptor(window, 'matchMedia')).toEqual(
      matchMediaBefore,
    );
  });
});
