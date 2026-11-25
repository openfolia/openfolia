import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';
import { TipOverlay, type TipOpenOptions } from '@openfolia/ui/tip';
import { ToastService } from '@openfolia/ui/toast';

import { provideApi } from '../api';
import { HelpService } from '../help/help.service';
import { MeService, type Me } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { advance } from '../testing/fake-time';
import { PreferencesService } from './preferences.service';
import {
  MAX_TRIES,
  RESIZE_SETTLE_MS,
  RETRY_MS,
  SETTLE_MS,
  TipsController,
} from './tips.controller';

@Component({
  template: `
    <nav>
      <a data-tip="nav.content" href="/content">Content</a>
      <a data-tip="nav.manuals" href="/manuals">Manuals</a>
      <a data-tip="nav.review" href="/review">Review</a>
    </nav>
    <table>
      <tr data-tip="content.module">
        <td><a href="/content/en/m1" id="row-link">A module</a></td>
      </tr>
    </table>
    <button type="button" data-tip="shell.change-set">Revision</button>
    <button type="button" data-tip="shell.search">Search</button>
    <button type="button" data-tip="content.new-module">New module</button>
    <input id="field" />
    <button type="button" id="outside">Elsewhere</button>
  `,
})
class Shell {}

@Component({ template: '' })
class Blank {}

const writer: Me = {
  id: 'pat',
  kind: 'user',
  name: 'Pat',
  role: 'Author',
  permissions: new Set(['content.read', 'content.read.draft', 'content.edit']),
};
const reader: Me = {
  ...writer,
  role: 'Reader',
  permissions: new Set(['content.read']),
};
const me = signal(writer);

/** The module editor's text, as the page has it once the module is editable. */
function editorText(): HTMLElement {
  const text = document.createElement('div');
  text.setAttribute('data-tip', 'module-editor.text');
  text.innerHTML =
    '<div contenteditable="true"><h2>Title</h2><p id="first">Open the cover.</p><p>Check the seal.</p></div>';
  document.body.append(text);
  return text;
}

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
const stepOf = () =>
  card()?.querySelector('[data-slot="tip-step"]')?.textContent?.trim();
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
          {
            path: 'content/:lang/:id',
            component: Blank,
            data: { help: 'guide.writing.edit-a-module' },
          },
        ]),
        { provide: MeService, useValue: { me } },
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
    sessionStorage.clear();
    me.set(writer);
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

  it('welcomes a new person once the screen settles; Not now ends it for good', async () => {
    await start(prefs({}));
    expect(card()).toBeNull();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    expect(stepOf()).toBe('1 of 4');
    // Focus moved in, so it is announced.
    expect(document.activeElement).toBe(card());
    expect(card()?.querySelector('[data-action="back"]')).toBeNull();
    press('dismiss');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: true }]);

    await TestBed.inject(Router).navigateByUrl('/review');
    await advance(SETTLE_MS);
    // Not the tour again; the content screen's tip waits for its own screen.
    expect(card()?.dataset['tipId'] ?? '').not.toMatch(/^tour\./);
  });

  it('walks a writer to a first edit: open a module, type, then Review; Done says where search is (#869)', async () => {
    await start(prefs({}));
    const tips = TestBed.inject(TipsController);
    const router = TestBed.inject(Router);
    // The row's link, as its routerLink does it: the list goes, the module comes.
    document.querySelector('#row-link')!.addEventListener('click', (event) => {
      event.preventDefault();
      document.querySelector('table')!.remove();
      void router.navigateByUrl('/content/en/m1');
    });
    await advance(SETTLE_MS);
    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    expect(tips.tourStep()).toBe('tour.open-module');
    expect(stepOf()).toBe('2 of 4');

    // Opening a module (here by the step's own button) moves it on, to a screen still loading.
    press('next');
    await advance();
    expect(router.url).toBe('/content/en/m1');
    expect(card()).toBeNull();
    expect(tips.tourStep()).toBe('tour.edit');
    await advance(SETTLE_MS + RETRY_MS * 2);
    expect(card()).toBeNull();

    // The module editable: the step lights up its first sentence.
    const text = editorText();
    await advance(RETRY_MS);
    expect(card()?.dataset['tipId']).toBe('tour.edit');
    // Start typing: the caret in the text, the card still there.
    press('next');
    await advance();
    expect(text.contains(document.activeElement)).toBe(true);
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.edit');

    tips.stepDone('tour.edit');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(stepOf()).toBe('4 of 4');
    // The focus stays in the text.
    expect(text.contains(document.activeElement)).toBe(true);
    // Typing on, or a click in the text, leaves it there.
    text
      .querySelector('#first')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(
      card()?.querySelector('[data-action="next"]')?.textContent?.trim(),
    ).toBe('Done');
    press('next');
    await advance();
    expect(card()).toBeNull();
    expect(tips.tourStep()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: true }]);
    expect(TestBed.inject(ToastService).toasts()).toEqual([
      expect.objectContaining({
        message: { key: 'editor.tour.done', params: { keys: 'Ctrl+K' } },
      }),
    ]);
  });

  it('waits on the list for a row that comes late, keeping its search, until the list has loaded (issue 903)', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/content?q=late');
    // The search has no row yet (a module merged a moment ago).
    const table = document.querySelector('table')!;
    const row = table.querySelector('tr')!;
    row.remove();
    await start(prefs({}));
    await advance(SETTLE_MS);
    press('next');
    await advance();
    // Already on the list: the step waits there, the search kept.
    expect(router.url).toBe('/content?q=late');
    expect(card()).toBeNull();

    // The row comes while the list still loads: not yet, it may move or go.
    table.setAttribute('aria-busy', 'true');
    table.append(row);
    await advance(SETTLE_MS + RETRY_MS * 2);
    expect(card()).toBeNull();

    table.removeAttribute('aria-busy');
    await advance(RETRY_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    expect(router.url).toBe('/content?q=late');
  });

  it('shows the whole list when its search, once loaded, has no row to open (issue 903)', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/content?q=nothing');
    const table = document.querySelector('table')!;
    const row = table.querySelector('tr')!;
    row.remove();
    table.setAttribute('aria-busy', 'true');
    await start(prefs({}));
    await advance(SETTLE_MS);
    press('next');
    await advance(SETTLE_MS + RETRY_MS * 2);
    // Still loading: the search is kept.
    expect(router.url).toBe('/content?q=nothing');

    // Loaded, and nothing found: the list without its search.
    table.removeAttribute('aria-busy');
    await advance(RETRY_MS);
    expect(router.url).toBe('/content');
    table.append(row);
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
  });

  it('leaves a search the person made alone, and waits for a row drawn again instead of centring (issue 903)', async () => {
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/content');
    const table = document.querySelector('table')!;
    const row = table.querySelector('tr')!;
    await start(prefs({}));
    await advance(SETTLE_MS);
    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');

    // The list draws its rows again: the row goes, the new one comes a moment later.
    row.remove();
    await advance(50);
    expect(card()).toBeNull();
    const drawn = row.cloneNode(true) as HTMLElement;
    table.append(drawn);
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    expect(
      document
        .querySelector('[data-slot="tip-spotlight"]')
        ?.hasAttribute('data-empty'),
    ).toBe(false);

    // The person searches for something with no module: the search stays theirs.
    drawn.remove();
    await router.navigateByUrl('/content?q=mine');
    await advance(SETTLE_MS + RETRY_MS * 3);
    expect(router.url).toBe('/content?q=mine');
  });

  it('pauses on a click elsewhere, a dialog or another screen, and resumes at the same step (#869)', async () => {
    await start(prefs({}));
    await advance(SETTLE_MS);
    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');

    // A click outside the card and the lit row: paused, not ended.
    document
      .querySelector('#outside')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await advance();
    expect(card()).toBeNull();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');

    // A dialog (the palette, say) takes the focus: paused while it is open.
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = '<input id="palette" />';
    document.body.append(dialog);
    dialog.querySelector<HTMLInputElement>('#palette')!.focus();
    await advance(SETTLE_MS + RETRY_MS * 3);
    expect(card()).toBeNull();
    dialog.remove();
    await advance(RETRY_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');

    // Another screen: paused, then the same step where it can be shown.
    await TestBed.inject(Router).navigateByUrl('/review');
    await advance();
    expect(card()).toBeNull();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    expect(await patches()).toEqual([]);
  });

  it('shows Send it for review while the person is still in the text, after a pause (#869)', async () => {
    sessionStorage.setItem('openfolia.tour:pat', 'tour.review');
    const text = editorText();
    text.querySelector<HTMLElement>('[contenteditable]')!.focus();
    const open = vi.spyOn(TestBed.inject(TipOverlay), 'open');
    await start(prefs({}));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.review');
    // It keeps clear of the sentence the person changed: the caret's, else the one the step lit.
    const options = open.mock.calls.at(-1)![0] as TipOpenOptions;
    expect(options.keepClear?.()).toBe(text.querySelector('#first'));
    const second = text.querySelectorAll('p')[1]!;
    document.getSelection()!.collapse(second.firstChild, 3);
    expect(options.keepClear?.()).toBe(second);
    // It comes without taking the caret out of the text.
    expect(text.contains(document.activeElement)).toBe(true);
    // Escape in the text is the editor's: the step only pauses, and comes back.
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await advance();
    expect(card()).toBeNull();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(await patches()).toEqual([]);
  });

  it('lets the tour start one revision, not one per module; a new tour may again (#869)', async () => {
    await start(prefs({ tourDone: true }));
    const tips = TestBed.inject(TipsController);
    expect(tips.claimRevision()).toBe(true);
    expect(tips.claimRevision()).toBe(false);
    expect(sessionStorage.getItem('openfolia.tour-revision:pat')).toBe(
      'started',
    );
    tips.restartTour();
    expect(tips.claimRevision()).toBe(true);
    await advance();
    expect(await patches()).toEqual([{ tourDone: false }]);
  });

  it('shows where the change went at the revision picker, naming the person’s revision, while they type (#869)', async () => {
    const sets = TestBed.inject(ChangeSetSession) as unknown as {
      value: WritableSignal<string>;
      options: WritableSignal<object[]>;
    };
    sets.options.set([
      { id: 'cs1', title: 'Charge the battery', authorId: 'pat' },
    ]);
    sets.value.set('cs1');
    // The top bar's picker, as the shell has it for a person who may use it.
    const picker = document.createElement('div');
    picker.setAttribute('data-tip', 'shell.revision');
    picker.innerHTML =
      '<button type="button" data-tip="shell.change-set">Revision</button>';
    document.body.append(picker);
    sessionStorage.setItem('openfolia.tour:pat', 'tour.edit');
    const text = editorText();
    await start(prefs({}));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.edit');
    expect(stepOf()).toBe('3 of 5');
    text.querySelector<HTMLElement>('[contenteditable]')!.focus();

    TestBed.inject(TipsController).stepDone('tour.edit');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.revision');
    expect(stepOf()).toBe('4 of 5');
    const body = document.getElementById(
      card()!.getAttribute('aria-describedby')!,
    );
    expect(body?.textContent).toContain(
      '“Charge the battery”, a revision of your own',
    );
    // The picker stays closed, and the caret in the text.
    expect(text.contains(document.activeElement)).toBe(true);

    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(stepOf()).toBe('5 of 5');
  });

  it('takes → and ← from a presenter: on to the next step and back, never from a field (#869)', async () => {
    await start(prefs({}));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    const key = (target: Element, key: string) =>
      target.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    // From the card (it has the focus as it opens).
    key(document.activeElement!, 'ArrowRight');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    // With nothing focused.
    (document.activeElement as HTMLElement).blur();
    key(document.body, 'ArrowLeft');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    key(document.body, 'ArrowLeft');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    // A field keeps its arrows.
    key(document.querySelector('#field')!, 'ArrowRight');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
  });

  it('keeps the revision a tour typed into for the next tour, and finds a picker that came late (#869)', async () => {
    const sets = TestBed.inject(ChangeSetSession) as unknown as {
      value: WritableSignal<string>;
      options: WritableSignal<object[]>;
    };
    sets.options.set([{ id: 'cs1', title: 'Battery', authorId: 'pat' }]);
    sets.value.set('cs1');
    sessionStorage.setItem('openfolia.tour:pat', 'tour.edit');
    editorText();
    await start(prefs({}));
    await advance(SETTLE_MS);
    const tips = TestBed.inject(TipsController);
    // No picker yet (a slow top bar): four steps.
    expect(stepOf()).toBe('3 of 4');
    expect(tips.tourRevision()).toBeNull();

    // The picker comes; the next showing counts its step.
    const picker = document.createElement('div');
    picker.setAttribute('data-tip', 'shell.revision');
    document.body.append(picker);
    document
      .querySelector('#outside')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await advance(SETTLE_MS);
    expect(stepOf()).toBe('3 of 5');

    tips.stepDone('tour.edit');
    await advance();
    expect(tips.tourRevision()).toBe('cs1');
    // Taken again (a demo given twice): the same revision is there for it.
    tips.restartTour();
    await advance();
    expect(tips.tourRevision()).toBe('cs1');
    await patches();
  });

  it('keeps the step open while the person types where it asks (#869)', async () => {
    sessionStorage.setItem('openfolia.tour:pat', 'tour.edit');
    const text = editorText();
    await start(prefs({}));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.edit');
    text.querySelector<HTMLElement>('[contenteditable]')!.focus();
    text
      .querySelector('#first')!
      .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.edit');
  });

  it('picks up after a reload at the step this tab was at; a module left before typing asks to open one again (#869)', async () => {
    sessionStorage.setItem('openfolia.tour:pat', 'tour.edit');
    await start(prefs({}));
    await advance(SETTLE_MS);
    // No module open here: the step before it.
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    expect(sessionStorage.getItem('openfolia.tour:pat')).toBe(
      'tour.open-module',
    );
  });

  it('gives a reader the reading tour, never the step that starts a revision (#869)', async () => {
    me.set(reader);
    await start(prefs({}));
    const tips = TestBed.inject(TipsController);
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    expect(stepOf()).toBe('1 of 3');
    press('next');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
    await TestBed.inject(Router).navigateByUrl('/content/en/m1');
    await advance();
    expect(tips.tourStep()).toBe('tour.manuals');
    editorText();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.manuals');
    expect(stepOf()).toBe('3 of 3');
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
      prefs({
        tourDone: true,
        dismissedTips: ['content.new-module', 'shell.search'],
      }),
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
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    press('skip');
    await advance();
    tips.resetTips();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('content.new-module');
    expect(await patches()).toEqual([
      { tourDone: false },
      { tourDone: true },
      { dismissedTips: [], showTips: true },
    ]);
  });

  it('takes the tour from the menu with tips off, and leaves them off (#868)', async () => {
    await start(prefs({ tourDone: true, showTips: false }));
    const tips = TestBed.inject(TipsController);
    tips.restartTour();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    // The preferences' change (tourDone) does not close it.
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    press('skip');
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: false }, { tourDone: true }]);
    expect(TestBed.inject(PreferencesService).showTips()).toBe(false);
    // No tip afterwards: tips are still off.
    await advance(SETTLE_MS * 2);
    expect(card()).toBeNull();
  });

  it('does not bring a requested tour back once tips are turned off', async () => {
    await start(prefs({ tourDone: true, showTips: false }));
    const tips = TestBed.inject(TipsController);
    tips.restartTour();
    await advance(SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    // The account menu takes the focus (the tour pauses), then tips are switched off.
    document.querySelector<HTMLInputElement>('#field')!.focus();
    await advance();
    expect(card()).toBeNull();
    document.querySelector<HTMLInputElement>('#field')!.blur();
    tips.setShowTips(false);
    await advance(SETTLE_MS * 2);
    expect(card()).toBeNull();
    await patches();
  });

  it('moves on when the step on show says its task is done, and only then', async () => {
    await start(prefs({}));
    await advance(SETTLE_MS);
    const tips = TestBed.inject(TipsController);
    tips.stepDone('tour.review');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.welcome');
    tips.stepDone('tour.welcome');
    await advance();
    expect(card()?.dataset['tipId']).toBe('tour.open-module');
  });

  it('ends the tour on Escape pressed anywhere on the page', async () => {
    await start(prefs({}));
    await advance(SETTLE_MS);
    document
      .querySelector('#outside')!
      .dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    await advance();
    expect(card()).toBeNull();
    expect(await patches()).toEqual([{ tourDone: true }]);
  });

  it('points a step about the closed sidebar at the menu button, and again after a resize', async () => {
    // A narrow screen: the sidebar is a closed sheet (inert), its menu button shows.
    const sidebar = document.querySelector<HTMLElement>('nav')!;
    sidebar.setAttribute('data-sidebar', 'sidebar');
    sidebar.setAttribute('inert', '');
    const menu = document.createElement('button');
    menu.setAttribute('data-tip', 'shell.menu');
    document.body.append(menu);

    sessionStorage.setItem('openfolia.tour:pat', 'tour.review');
    await start(prefs({}));
    await advance(SETTLE_MS);
    // Every step is kept: the review step's anchor is in the closed sidebar, not missing.
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(stepOf()).toBe('4 of 4');
    const spotlight = () =>
      document.querySelector('[data-slot="tip-spotlight"]');
    expect(spotlight()).not.toBeNull();
    expect(spotlight()?.hasAttribute('data-empty')).toBe(false);

    // Wide again: the sidebar shows, the menu button goes; the card follows after a resize.
    sidebar.removeAttribute('inert');
    menu.remove();
    window.dispatchEvent(new Event('resize'));
    await advance(RESIZE_SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(spotlight()?.hasAttribute('data-empty')).toBe(false);

    // Narrow with no menu button either: centred, the whole page dimmed.
    sidebar.setAttribute('inert', '');
    window.dispatchEvent(new Event('resize'));
    await advance(RESIZE_SETTLE_MS);
    expect(card()?.dataset['tipId']).toBe('tour.review');
    expect(spotlight()?.hasAttribute('data-empty')).toBe(true);
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
