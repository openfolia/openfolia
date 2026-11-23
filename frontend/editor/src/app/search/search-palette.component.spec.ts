import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { DIALOG_DURATION } from '@openfolia/ui/dialog';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { NewModuleRequest } from '../content/new-module-request';
import { HelpService } from '../help/help.service';
import { MeService, NOBODY } from '../permissions/me';
import { SEARCH_DEBOUNCE } from './palette-search';
import { RecentItems } from './recent-items';
import { SearchPaletteComponent } from './search-palette.component';
import { SearchPalette } from './search-palette.service';
import { advance } from '../testing/fake-time';

const AUTHOR = ['content.read', 'content.read.draft', 'content.edit'];

const result = (
  type: 'Module' | 'Manual',
  resourceId: string,
  title: string,
  options: {
    lang?: string;
    text?: string;
    matches?: { start: number; end: number }[];
    blockId?: string;
    /** The matching keywords, for a keyword match. */
    keywords?: string;
  } = {},
) => ({
  type: 'SearchResult',
  id: `${type.toLowerCase()}:${resourceId}`,
  attributes: {
    resourceType: type,
    resourceId,
    ...(options.lang ? { lang: options.lang } : {}),
    title,
    ...(options.blockId ? { blockId: options.blockId } : {}),
  },
  relationships: { resource: { data: { type, id: resourceId } } },
  meta: {
    matchedOn:
      options.keywords !== undefined
        ? 'keyword'
        : options.text === undefined
          ? 'title'
          : 'text',
    excerpt: options.keywords ?? options.text ?? title,
    matches: options.matches ?? [],
  },
});

const page = (
  data: ReturnType<typeof result>[],
  meta: { currentPage?: number; lastPage?: number; total?: number } = {},
) => ({
  data,
  meta: {
    page: {
      currentPage: meta.currentPage ?? 1,
      lastPage: meta.lastPage ?? 1,
      perPage: 20,
      total: meta.total ?? data.length,
    },
  },
  links: {
    self: '',
    first: '',
    last: '',
    prev: null,
    next: null,
  },
});

/** Waits out `ms` of the fake clock. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

async function setup(
  permissions: string[] = AUTHOR,
  stored: Record<string, string> = {},
) {
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideZard(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(MeService).set({
    ...NOBODY,
    id: 'a',
    permissions: new Set(permissions),
  });
  // Fake time: the search's debounce and the dialog's leave transition are waited out on the fake
  // clock. The fake clock runs every timer due in the step, in order, however slow the machine is
  // (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(SearchPaletteComponent);
  await advance();
  const http = TestBed.inject(HttpTestingController);
  const palette = TestBed.inject(SearchPalette);
  const router = TestBed.inject(Router);
  const stable = async () => {
    fixture.detectChanges();
    await advance();
  };
  const input = () =>
    document.querySelector<HTMLInputElement>('z-command-input input');
  const type = async (text: string) => {
    const field = input();
    if (!field) throw new Error('no search field');
    field.value = text;
    field.dispatchEvent(new Event('input'));
    await stable();
  };
  const key = async (name: string) => {
    input()?.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true }),
    );
    await stable();
  };
  /** Waits out the debounce and answers the search it sends. */
  const answer = async (
    respond: (req: TestRequest) => void,
  ): Promise<TestRequest> => {
    await wait(SEARCH_DEBOUNCE + 50);
    await stable();
    const req = http.expectOne((r) => r.url === '/api/search');
    respond(req);
    await stable();
    return req;
  };
  const open = async () => {
    palette.open();
    await stable();
  };
  const text = () => document.querySelector('[role=dialog]')?.textContent ?? '';
  const options = () => [
    ...document.querySelectorAll<HTMLElement>('[role=dialog] [role=option]'),
  ];
  return {
    fixture,
    http,
    palette,
    router,
    stable,
    input,
    type,
    key,
    answer,
    open,
    text,
    options,
  };
}

describe('SearchPaletteComponent', () => {
  beforeAll(() => {
    // jsdom has no layout: the highlighted option scrolls into view in a browser.
    Element.prototype.scrollIntoView ??= () => undefined;
  });
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    TestBed.inject(SearchPalette).close();
    document.querySelector('.cdk-overlay-container')?.replaceChildren();
  });

  it('opens with Ctrl+K from anywhere and closes with it again', async () => {
    const t = await setup();
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
    );
    await t.stable();
    expect(t.palette.isOpen()).toBe(true);
    await wait(0);
    expect(document.activeElement).toBe(t.input());
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }),
    );
    await t.stable();
    expect(t.palette.isOpen()).toBe(false);
  });

  it('searches as you type, groups the results and highlights the matches as text', async () => {
    const t = await setup();
    await t.open();
    await t.type('  station ');
    // A skeleton while the answer is out.
    expect(
      document.querySelector('[role=dialog] [data-state=loading]'),
    ).toBeTruthy();
    const req = await t.answer((r) =>
      r.flush(
        page([
          result('Module', 'de/charging-station', 'Ladestation', {
            lang: 'de',
            matches: [{ start: 4, end: 11 }],
          }),
          result('Module', 'en/specs', 'Technical data', {
            lang: 'en',
            text: 'Table 5 <b>station</b> for EU',
            matches: [{ start: 11, end: 18 }],
            blockId: 'tbl-5',
          }),
          result('Manual', 'handbook', 'Handbook station', {
            matches: [{ start: 9, end: 16 }],
          }),
        ]),
      ),
    );
    expect(req.request.params.get('filter[q]')).toBe('station');
    expect(req.request.params.get('page[number]')).toBe('1');
    expect(req.request.params.get('page[size]')).toBe('20');

    const headings = [
      ...document.querySelectorAll('[data-slot=command-group-heading]'),
    ].map((h) => h.textContent?.trim());
    expect(headings).toEqual(['Modules', 'Manuals', 'Actions']);
    const marks = [...document.querySelectorAll('[role=dialog] mark')].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(['station', 'station', 'station']);
    // The excerpt is text: its markup is shown, never rendered.
    expect(document.querySelector('[role=dialog] b')).toBeNull();
    expect(t.text()).toContain('Table 5 <b>station</b> for EU');
    expect(t.text()).toContain('Text match');
    expect(t.text()).toContain('Manual');
    expect(t.text()).toContain('3 results');
  });

  it('shows a keyword match as such, with the matching keywords highlighted', async () => {
    const t = await setup();
    await t.open();
    await t.type('maint');
    await t.answer((r) =>
      r.flush(
        page([
          result('Module', 'en/charging', 'Charging', {
            lang: 'en',
            keywords: 'maintenance, maintainer',
            matches: [
              { start: 0, end: 5 },
              { start: 13, end: 18 },
            ],
          }),
        ]),
      ),
    );
    const marks = [...document.querySelectorAll('[role=dialog] mark')].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(['maint', 'maint']);
    expect(t.text()).toContain('maintenance, maintainer');
    expect(t.text()).toContain('Keyword · English');
    expect(t.text()).not.toContain('Text match');
  });

  it('opens a result with the keyboard, remembers it and returns to it later', async () => {
    const t = await setup();
    const navigate = vi.spyOn(t.router, 'navigate').mockResolvedValue(true);
    await t.open();
    await t.type('data');
    await t.answer((r) =>
      r.flush(
        page([
          result('Module', 'de/one', 'One', { lang: 'de' }),
          result('Module', 'en/specs', 'Technical data', {
            lang: 'en',
            text: 'data',
            blockId: 'tbl-5',
          }),
        ]),
      ),
    );
    expect(t.options()[0]?.getAttribute('aria-selected')).toBe('true');
    expect(t.input()?.getAttribute('aria-activedescendant')).toBe(
      t.options()[0]?.id,
    );
    await t.key('ArrowDown');
    expect(t.options()[1]?.getAttribute('aria-selected')).toBe('true');
    expect(t.input()?.getAttribute('aria-activedescendant')).toBe(
      t.options()[1]?.id,
    );
    await t.key('Enter');
    expect(navigate).toHaveBeenCalledWith(['/content', 'en', 'specs'], {
      queryParams: {},
      fragment: 'tbl-5',
    });
    expect(t.palette.isOpen()).toBe(false);
    expect(TestBed.inject(RecentItems).items()).toEqual([
      { kind: 'module', id: 'specs', lang: 'en', title: 'Technical data' },
    ]);

    // Next time, with nothing typed, it is listed under Recent.
    await t.open();
    expect(t.text()).toContain('Recent');
    expect(t.text()).toContain('Technical data');
    await t.key('Enter');
    expect(navigate).toHaveBeenLastCalledWith(['/content', 'en', 'specs'], {
      queryParams: {},
    });
  });

  it("never shows the previous person's results while the next one's load", async () => {
    const t = await setup();
    await t.open();
    await t.type('pump');
    await t.answer((r) =>
      r.flush(page([result('Manual', 'm', 'Secret pump')])),
    );
    expect(t.text()).toContain('Secret pump');
    TestBed.inject(MeService).set({
      ...NOBODY,
      id: 'b',
      permissions: new Set(AUTHOR),
    });
    await t.stable();
    await wait(0);
    await t.stable();
    expect(t.text()).not.toContain('Secret pump');
    expect(
      document.querySelector('[role=dialog] [data-state=loading]'),
    ).toBeTruthy();
    await t.answer((r) => r.flush(page([])));
  });

  it('keeps the last results, dimmed and inert, while a refined search runs', async () => {
    const t = await setup();
    await t.open();
    await t.type('pump');
    await t.answer((r) => r.flush(page([result('Manual', 'm', 'Big pump')])));
    await t.type('pumps');
    // Still on screen, no skeleton in their place.
    expect(t.text()).toContain('Big pump');
    expect(
      document.querySelector('[role=dialog] [data-state=loading]'),
    ).toBeNull();
    const dimmed = document.querySelector(
      '[role=dialog] z-command-option-group[aria-busy="true"]',
    );
    expect(dimmed?.classList).toContain('opacity-60');
    expect(dimmed?.hasAttribute('inert')).toBe(true);
    await t.answer((r) => r.flush(page([result('Manual', 'm', 'Big pumps')])));
    expect(t.text()).toContain('Big pumps');
    expect(
      document.querySelector('[role=dialog] z-command-option-group[inert]'),
    ).toBeNull();
  });

  it('Enter on a focused option opens that option only', async () => {
    const t = await setup();
    const navigate = vi.spyOn(t.router, 'navigate').mockResolvedValue(true);
    await t.open();
    await t.type('data');
    await t.answer((r) =>
      r.flush(
        page([
          result('Module', 'de/one', 'One', { lang: 'de' }),
          result('Module', 'de/two', 'Two', { lang: 'de' }),
        ]),
      ),
    );
    const second = t.options()[1];
    second?.focus();
    second?.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        cancelable: true,
      }),
    );
    await t.stable();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(['/content', 'de', 'two'], {
      queryParams: {},
    });
  });

  it('says when nothing was found', async () => {
    const t = await setup();
    await t.open();
    await t.type('zzz');
    await t.answer((r) => r.flush(page([])));
    expect(t.text()).toContain('Nothing found for “zzz”');
    expect(
      document.querySelector('[role=dialog] [data-state=empty]'),
    ).toBeTruthy();
  });

  it('shows a failure with a retry that asks again', async () => {
    const t = await setup();
    await t.open();
    await t.type('pump');
    await t.answer((r) =>
      r.flush(
        { errors: [{ status: '503', code: 'database-unavailable' }] },
        { status: 503, statusText: 'Unavailable' },
      ),
    );
    expect(t.text()).toContain('The search failed.');
    const retry = document.querySelector<HTMLButtonElement>(
      '[role=dialog] [data-state=error] button',
    );
    expect(retry).toBeTruthy();
    // Enter on the Retry button is the button's: the command neither cancels it nor runs the
    // highlighted option ("Switch change set").
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    retry?.dispatchEvent(enter);
    await t.stable();
    expect(enter.defaultPrevented).toBe(false);
    expect(t.text()).not.toContain('Back to search');
    expect(t.palette.isOpen()).toBe(true);
    retry?.click();
    await t.stable();
    await t.answer((r) => r.flush(page([result('Manual', 'm', 'Pump')])));
    expect(t.text()).toContain('Pump');
  });

  it('shows no access when the search is refused', async () => {
    const t = await setup();
    await t.open();
    await t.type('pump');
    await t.answer((r) =>
      r.flush(
        { errors: [{ status: '403', code: 'forbidden' }] },
        { status: 403, statusText: 'Forbidden' },
      ),
    );
    expect(
      document.querySelector('[role=dialog] [data-state=no-access]'),
    ).toBeTruthy();
  });

  it('pages: "Show more results" appends the next page', async () => {
    const t = await setup();
    await t.open();
    await t.type('a');
    await t.answer((r) =>
      r.flush(page([result('Manual', 'm1', 'A1')], { lastPage: 2, total: 2 })),
    );
    const more = t.options().find((o) => o.textContent?.includes('1 of 2'));
    expect(more).toBeTruthy();
    more?.click();
    await t.stable();
    const req = t.http.expectOne((r) => r.url === '/api/search');
    expect(req.request.params.get('page[number]')).toBe('2');
    req.flush(
      page([result('Manual', 'm2', 'A2')], {
        currentPage: 2,
        lastPage: 2,
        total: 2,
      }),
    );
    await t.stable();
    expect(t.text()).toContain('A1');
    expect(t.text()).toContain('A2');
    expect(t.text()).not.toContain('Show more');
  });

  it('switches the change set from the palette', async () => {
    const t = await setup();
    await t.open();
    const action = t
      .options()
      .find((o) => o.textContent?.includes('Switch revision'));
    expect(action).toBeTruthy();
    action?.click();
    await t.stable();
    const id = '0f0e0d0c-0b0a-7908-8706-050403020100';
    t.http
      .expectOne((r) => r.url === '/api/change-sets')
      .flush({
        data: [
          {
            type: 'ChangeSet',
            id,
            attributes: {
              title: 'Spring update',
              description: null,
              state: 'in-review',
              author: { kind: 'user', id: 'a' },
              baseRef: 'main',
              baseCommit: 'c',
              branch: `change-sets/${id}`,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
        ],
        meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 1 } },
        links: {},
      });
    await t.stable();
    await wait(0);
    await t.stable();
    expect(document.activeElement).toBe(t.input());
    expect(t.text()).toContain('Published content');
    expect(t.text()).toContain('Current');
    expect(t.text()).toContain('In review');
    await t.type('spring');
    await t.key('Enter');
    expect(TestBed.inject(ReadRef).ref()).toBe(`change-sets/${id}`);
    expect(t.palette.isOpen()).toBe(false);
  });

  it('offers only actions to a role that cannot search', async () => {
    const t = await setup(['content.read.draft']);
    await t.open();
    await t.type('switch');
    await wait(SEARCH_DEBOUNCE + 50);
    await t.stable();
    t.http.expectNone((r) => r.url === '/api/search');
    expect(t.options().map((o) => o.textContent?.trim())).toEqual([
      expect.stringContaining('Switch revision'),
    ]);
  });

  it('hides the change-set switch from a role that can never use one', async () => {
    const t = await setup(['content.read']);
    await t.open();
    expect(t.text()).not.toContain('Switch revision');
    expect(t.text()).toContain('Type to search titles and text.');
  });

  describe('pages (#591)', () => {
    it('finds a settings topic by name and opens it, with no "nothing found"', async () => {
      const t = await setup([...AUTHOR, 'admin.roles']);
      await t.open();
      await t.type('languages');
      const navigate = vi.spyOn(t.router, 'navigate').mockResolvedValue(true);
      // The page is there before the search answers: it never waits for it.
      expect(t.options()[0]?.textContent).toContain(
        'Admin › Project settings › Languages',
      );
      // While the search runs, its skeleton shows below the pages, never above them.
      await wait(SEARCH_DEBOUNCE + 50);
      await t.stable();
      const list = document.querySelector('[role=dialog] [role=listbox]');
      const skeleton = document.querySelector(
        '[role=dialog] [data-state=loading]',
      );
      expect(skeleton).toBeTruthy();
      expect(
        list!.compareDocumentPosition(skeleton!) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      await t.answer((r) => r.flush(page([])));
      expect(t.text()).not.toContain('Nothing found');
      expect(t.options()[0]?.textContent).toContain('Languages');
      await t.key('Enter');
      expect(navigate).toHaveBeenCalledWith(
        ['/admin', 'settings', 'languages'],
        { queryParams: {} },
      );
      expect(t.palette.isOpen()).toBe(false);
    });

    it('lists an admin page under its group, and only those the role opens', async () => {
      const t = await setup(['content.read', 'webhook.manage']);
      await t.open();
      await t.type('admin');
      await t.answer((r) => r.flush(page([])));
      expect(
        t
          .options()
          .map((o) => o.querySelector('.text-xs')?.textContent?.trim()),
      ).toEqual(['Admin › Integrations › Webhooks']);
    });

    it('lists nothing while nothing is typed', async () => {
      const t = await setup([...AUTHOR, 'admin.roles']);
      await t.open();
      expect(t.text()).not.toContain('Admin ›');
    });

    it('offers the pages to a role that can neither search nor act', async () => {
      const t = await setup(['admin.branding']);
      expect(t.palette.available()).toBe(true);
      await t.open();
      await t.type('brand');
      await wait(SEARCH_DEBOUNCE + 50);
      await t.stable();
      t.http.expectNone((r) => r.url === '/api/search');
      expect(t.options().map((o) => o.textContent?.trim())).toEqual([
        expect.stringContaining('Admin › Look › Branding'),
      ]);
    });
  });

  describe('help (#221)', () => {
    const DOCS = 'https://docs.example.org/';
    /** Help links on: `GET /about` names the docs site (the guide's index is the build's). */
    const helpOn = async (
      t: Awaited<ReturnType<typeof setup>>,
      docsUrl: string | null = DOCS,
    ) => {
      TestBed.inject(HelpService).load();
      t.http.expectOne('/api/about').flush({
        data: {
          type: 'About',
          id: 'about',
          attributes: {
            license: 'AGPL-3.0-only',
            licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
            sourceUrl: null,
            docsUrl,
          },
        },
      });
      await advance();
      await t.stable();
    };

    it('finds a guide page by a word of its summary and opens it in a new tab', async () => {
      const t = await setup();
      await helpOn(t);
      await t.open();
      // "XLIFF" is in the summary of "Send a delta export", not in its title.
      await t.type('xliff');
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      const help = t
        .options()
        .find((o) => o.textContent?.includes('Send a delta export'));
      expect(help?.textContent).toContain('User guide');
      expect(t.text()).toContain('Help');
      await t.answer((r) => r.flush(page([])));
      expect(t.text()).not.toContain('Nothing found');
      help?.click();
      await t.stable();
      expect(open).toHaveBeenCalledWith(
        `${DOCS}guide/translations/export`,
        '_blank',
        'noopener,noreferrer',
      );
      expect(t.palette.isOpen()).toBe(false);
    });

    it('finds no guide page while help links are off', async () => {
      const t = await setup();
      await helpOn(t, null);
      await t.open();
      await t.type('xliff');
      await t.answer((r) => r.flush(page([])));
      expect(t.text()).not.toContain('Send a delta export');
      expect(t.text()).toContain('Nothing found');
    });

    it('offers the guide to a role that can neither search nor act', async () => {
      const t = await setup([]);
      expect(t.palette.available()).toBe(false);
      await helpOn(t);
      expect(t.palette.available()).toBe(true);
    });
  });

  describe('New module', () => {
    const CS = '0f0e0d0c-0b0a-7908-8706-050403020100';
    const chosen = {
      'openfolia.change-set': JSON.stringify({
        id: CS,
        title: 'Spring update',
        branch: `change-sets/${CS}`,
      }),
    };
    const action = (t: Awaited<ReturnType<typeof setup>>) =>
      t.options().find((o) => o.textContent?.includes('New module'));

    it('asks the content browser for its dialog, closing the palette and going there', async () => {
      const t = await setup(AUTHOR, chosen);
      await t.router.navigateByUrl('/manuals');
      const before = document.createElement('button');
      document.body.append(before);
      before.focus();
      await t.open();
      const option = action(t);
      expect(option?.getAttribute('aria-disabled')).not.toBe('true');
      option?.click();
      await t.stable();
      expect(t.palette.isOpen()).toBe(false);
      // Asked for once the palette has closed and given the focus back.
      expect(TestBed.inject(NewModuleRequest).pending()).toBe(false);
      await wait(DIALOG_DURATION + 50);
      await t.stable();
      expect(TestBed.inject(NewModuleRequest).pending()).toBe(true);
      // The focus went back to where it was before the palette.
      expect(document.activeElement).toBe(before);
      // The change set goes along.
      expect(t.router.url).toBe(`/content?cs=${CS}`);
      before.remove();
    });

    it('is disabled with the reason when there is no change set', async () => {
      const t = await setup();
      await t.open();
      const option = action(t);
      expect(option?.getAttribute('aria-disabled')).toBe('true');
      expect(option?.textContent).toContain('revision');
      option?.click();
      await t.stable();
      expect(TestBed.inject(NewModuleRequest).pending()).toBe(false);
      expect(t.palette.isOpen()).toBe(true);
    });

    it('asks for nothing when the navigation does not get to the browser', async () => {
      const t = await setup(AUTHOR, chosen);
      await t.router.navigateByUrl('/manuals');
      await t.open();
      // A guard (unsaved work, say) keeps the person where they are.
      const nav = vi.spyOn(t.router, 'navigate').mockResolvedValue(false);
      action(t)?.click();
      await t.stable();
      await wait(DIALOG_DURATION + 50);
      await t.stable();
      expect(nav).toHaveBeenCalled();
      expect(TestBed.inject(NewModuleRequest).pending()).toBe(false);
    });

    it('is hidden from a role that cannot edit', async () => {
      const t = await setup(['content.read', 'content.read.draft'], chosen);
      await t.open();
      expect(action(t)).toBeUndefined();
    });
  });
});
