import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { ContentBrowserPage } from './content-browser.page';
import { ModuleCreation } from './module-creation';
import { NewModuleRequest } from './new-module-request';

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
  ],
  audiences: [{ id: 'public', label: 'Public' }],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [{ id: 'north', label: 'North' }],
    },
  ],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const summary = (
  id: string,
  title: string,
  changed = false,
  keywords: string[] = [],
) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    moduleId: id,
    title,
    titleLang: 'en',
    moduleType: 'concept',
    audience: 'public',
    facets: {},
    keywords,
    languages: ['en'],
    variants: [],
  },
  meta: { changed },
});

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 50, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

async function render(permissions: string[] = ['content.read'], url = '/') {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(permissions),
  });
  await TestBed.inject(Router).navigateByUrl(url);
  const fixture = TestBed.createComponent(ContentBrowserPage);
  const http = TestBed.inject(HttpTestingController);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    await new Promise((r) => setTimeout(r, 0));
    await fixture.whenStable();
  };
  const summaries = (): TestRequest =>
    http.expectOne((r) => r.url === '/api/module-summaries');
  /** Answers the page's translation status (#694) with no states, once it is asked. */
  const noStates = async () => {
    await settle();
    http
      .match((r) => r.url === '/api/translations/status')
      .forEach((r) => r.flush(page([])));
    await settle();
  };
  return { fixture, http, el, settle, summaries, noStates };
}

describe('ContentBrowserPage', () => {
  it('shows skeleton rows, then the modules in a table inside the frame', async () => {
    const { http, el, settle, summaries } = await render();
    expect(el.querySelector('of-skeleton-rows')).toBeTruthy();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    const req = summaries();
    expect(req.request.params.get('page[size]')).toBe('50');
    req.flush(page([summary('charging', 'Charging')]));
    await settle();
    const scroller = el.querySelector('[data-slot="list-scroller"]')!;
    const row = scroller.querySelector('tbody tr')!;
    expect(row.textContent).toContain('Charging');
    expect(row.textContent).toContain('Concept');
    expect(row.textContent).toContain('Released');
    // Every configured language, translated or not, with a word for screen readers.
    expect(
      [...row.querySelectorAll('of-language-badge')].map((b) =>
        b.getAttribute('data-state'),
      ),
    ).toEqual(['up-to-date', 'not-translated']);
    expect(row.querySelector('a')?.getAttribute('href')).toBe(
      '/content/en/charging',
    );
    expect(
      scroller.contains(el.querySelector('[data-slot="list-pagination"]')),
    ).toBe(false);
  });

  it('shows an outdated translation as outdated, read with its page, keeping the rows while reloading (#694)', async () => {
    const { http, el, settle, summaries } = await render([
      'content.read',
      'content.read.draft',
    ]);
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    const translated = (id: string, title: string) => {
      const s = summary(id, title);
      return { ...s, attributes: { ...s.attributes, languages: ['en', 'de'] } };
    };
    summaries().flush(
      page([
        translated('charging', 'Charging'),
        translated('docking', 'Docking'),
      ]),
    );
    await settle();
    const states = () =>
      [...el.querySelectorAll('tbody tr')].map((row) =>
        [...row.querySelectorAll('of-language-badge')].map((b) =>
          b.getAttribute('data-state'),
        ),
      );
    // The page's states are read with it: its rows wait for them.
    const statuses = http.expectOne(
      (r) => r.url === '/api/translations/status',
    );
    expect(statuses.request.params.get('filter[module]')).toBe(
      'charging,docking',
    );
    expect(statuses.request.params.get('page[by]')).toBe('row');
    expect(statuses.request.params.get('page[size]')).toBe('2');
    expect(el.querySelector('of-skeleton-rows')).toBeTruthy();
    const status = (moduleId: string, state: string) => ({
      type: 'TranslationStatus',
      id: `de/${moduleId}`,
      attributes: { kind: 'module', moduleId, lang: 'de', state },
      meta: { title: moduleId, totalBlocks: 2, outdatedBlocks: 1 },
    });
    statuses.flush(
      page([status('charging', 'outdated'), status('docking', 'up-to-date')]),
    );
    await settle();
    expect(states()).toEqual([
      ['up-to-date', 'outdated'],
      ['up-to-date', 'up-to-date'],
    ]);

    // Read again: the rows and their states stay until both are there.
    TestBed.inject(ReadRef).moves.update((n) => n + 1);
    await settle();
    http
      .match('/api/config')
      .forEach((r) => r.flush({ data: { attributes: config } }));
    summaries().flush(page([translated('charging', 'Charging')]));
    await settle();
    expect(states()).toEqual([
      ['up-to-date', 'outdated'],
      ['up-to-date', 'up-to-date'],
    ]);
    http
      .expectOne((r) => r.url === '/api/translations/status')
      .flush(page([status('charging', 'up-to-date')]));
    await settle();
    expect(states()).toEqual([['up-to-date', 'up-to-date']]);
  });

  it('says only that a translation is there to a reader without the translation status (#694)', async () => {
    const { http, el, settle, summaries } = await render(['content.read']);
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    const s = summary('charging', 'Charging');
    summaries().flush(
      page([
        { ...s, attributes: { ...s.attributes, languages: ['en', 'de'] } },
      ]),
    );
    await settle();
    http.expectNone((r) => r.url === '/api/translations/status');
    expect(
      [...el.querySelectorAll('tbody of-language-badge')].map((b) =>
        b.getAttribute('data-state'),
      ),
    ).toEqual(['up-to-date', 'translated']);
  });

  it('labels a module without an audience by the last level it counts as (#693)', async () => {
    const { http, el, settle, summaries } = await render();
    http.expectOne('/api/config').flush({
      data: {
        attributes: {
          ...config,
          audiences: [
            { id: 'public', label: 'Public' },
            { id: 'service', label: 'Service' },
          ],
        },
      },
    });
    const unset = summary('charging', 'Charging');
    const { audience: _, ...attributes } = unset.attributes;
    summaries().flush(page([{ ...unset, attributes }]));
    await settle();
    const row = el.querySelector('[data-slot="list-scroller"] tbody tr')!;
    expect(row.textContent).toContain('Service (not set)');
    expect(row.textContent).not.toContain('Everyone');
  });

  it('names the last audience level in the filter as including the modules without one (#699)', async () => {
    const { http, el, settle, summaries } = await render(
      ['content.read'],
      '/?audience=service',
    );
    await settle();
    const req = summaries();
    expect(req.request.params.get('filter[audience]')).toBe('service');
    req.flush(page([]));
    http.expectOne('/api/config').flush({
      data: {
        attributes: {
          ...config,
          audiences: [
            { id: 'public', label: 'Public' },
            { id: 'service', label: 'Service' },
          ],
        },
      },
    });
    await settle();
    const chips = [...el.querySelectorAll('of-filter-chip button')];
    const audience = chips.find((b) =>
      b.getAttribute('aria-label')?.startsWith('Audience'),
    );
    expect(audience?.getAttribute('aria-label')).toBe(
      'Audience: Service + not set',
    );
  });

  it('reads again, from page 1, when a group is chosen', async () => {
    const { http, el, settle, summaries } = await render();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(page([]));
    await settle();
    expect(el.textContent).toContain('No modules');
    const group = [
      ...el.querySelectorAll<HTMLButtonElement>('nav button'),
    ].find((b) => b.textContent?.includes('Concept'));
    group?.click();
    await settle();
    const req = summaries();
    expect(req.request.params.get('filter[type]')).toBe('concept');
    expect(req.request.params.get('page[number]')).toBe('1');
    req.flush(page([]));
    await settle();
    expect(group?.getAttribute('aria-current')).toBe('true');
  });

  it('filters by keywords typed into the keyword chip, and shows each row’s keywords', async () => {
    const { http, el, settle, summaries } = await render();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(page([]));
    await settle();
    const chip = [
      ...el.querySelectorAll<HTMLButtonElement>(
        'of-keyword-filter-chip button',
      ),
    ][0];
    expect(chip?.getAttribute('aria-label')).toBe('Keyword: All');
    chip?.click();
    await settle();
    const field = document.querySelector<HTMLInputElement>(
      '#browser-keyword-filter',
    );
    expect(field).toBeTruthy();
    field!.value = 'Maintenance';
    field!.dispatchEvent(new Event('input'));
    field!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    const req = summaries();
    expect(req.request.params.getAll('filter[keyword]')).toEqual([
      'Maintenance',
    ]);
    expect(req.request.params.get('page[number]')).toBe('1');
    req.flush(page([summary('charging', 'Charging', false, ['maintenance'])]));
    await settle();
    expect(chip?.getAttribute('aria-label')).toBe('Keyword: Maintenance');
    const row = el.querySelector('[data-slot="list-scroller"] tbody tr');
    expect(row?.textContent).toContain('maintenance');
    // A second keyword narrows further; Backspace in the empty field takes it back.
    field!.value = 'battery,';
    field!.dispatchEvent(new Event('input'));
    await settle();
    const both = summaries();
    expect(both.request.params.getAll('filter[keyword]')).toEqual([
      'Maintenance',
      'battery',
    ]);
    both.flush(page([]));
    await settle();
    field!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true }),
    );
    await settle();
    const back = summaries();
    expect(back.request.params.getAll('filter[keyword]')).toEqual([
      'Maintenance',
    ]);
    back.flush(page([]));
  });

  it('resets every filter and the search text, from the bar or the empty state', async () => {
    const { http, el, settle, summaries } = await render();
    // Focus needs the element in the document.
    document.body.appendChild(el);
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(page([]));
    await settle();
    // Shown ones only: the bar's button keeps its place while hidden (inert), so the bar never
    // wraps or moves the list when it appears (#385).
    const resetButtons = () =>
      [...el.querySelectorAll<HTMLButtonElement>('button')].filter(
        (b) =>
          b.textContent?.includes('Reset filters') && !b.closest('[inert]'),
      );
    const barReset = () =>
      el.querySelector<HTMLButtonElement>('[data-slot="filters-reset"]');
    // Nothing set: nothing to reset, but its place is kept.
    expect(resetButtons()).toHaveLength(0);
    expect(barReset()?.classList).toContain('invisible');

    [...el.querySelectorAll<HTMLButtonElement>('nav button')]
      .find((b) => b.textContent?.includes('Concept'))
      ?.click();
    await settle();
    summaries().flush(page([]));
    await settle();
    // In the filter bar, and as the empty state's action.
    expect(resetButtons()).toHaveLength(2);

    resetButtons()[0]!.click();
    await settle();
    const req = summaries();
    expect(req.request.params.has('filter[type]')).toBe(false);
    expect(req.request.params.get('page[number]')).toBe('1');
    req.flush(page([]));
    await settle();
    expect(resetButtons()).toHaveLength(0);
    expect(barReset()?.getAttribute('aria-hidden')).toBe('true');
    // The button that had focus is hidden: focus is in the search box.
    expect(document.activeElement).toBe(
      el.querySelector('input[type="search"]'),
    );
    el.remove();
  });

  it('focuses the search box on /, which shows a / keycap', async () => {
    const { http, el, settle, summaries } = await render();
    document.body.appendChild(el);
    try {
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      summaries().flush(page([]));
      await settle();
      const input = el.querySelector(
        'input[type="search"]',
      ) as HTMLInputElement;
      expect(input.getAttribute('aria-keyshortcuts')).toBe('/');
      expect(input.parentElement!.querySelector('kbd')?.textContent).toBe('/');
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: '/',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(document.activeElement).toBe(input);
    } finally {
      el.remove();
    }
  });

  it('resets the keyword filter too', async () => {
    const { http, el, settle, summaries } = await render();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(page([]));
    await settle();
    const chip = () =>
      el.querySelector<HTMLButtonElement>('of-keyword-filter-chip button');
    chip()?.click();
    await settle();
    const field = document.querySelector<HTMLInputElement>(
      '#browser-keyword-filter',
    );
    field!.value = 'maintenance';
    field!.dispatchEvent(new Event('input'));
    field!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    const filtered = summaries();
    expect(filtered.request.params.getAll('filter[keyword]')).toEqual([
      'maintenance',
    ]);
    filtered.flush(page([]));
    await settle();
    expect(chip()?.getAttribute('aria-label')).toBe('Keyword: maintenance');

    [...el.querySelectorAll<HTMLButtonElement>('button')]
      .find((b) => b.textContent?.includes('Reset filters'))!
      .click();
    await settle();
    const req = summaries();
    expect(req.request.params.has('filter[keyword]')).toBe(false);
    req.flush(page([]));
    await settle();
    expect(chip()?.getAttribute('aria-label')).toBe('Keyword: All');
  });

  it('says a failure in a toast with Retry, which reads again', async () => {
    const { http, settle, summaries } = await render();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(null, { status: 503, statusText: 'Unavailable' });
    await settle();
    const toast = TestBed.inject(ToastService);
    const failure = toast.toasts().find((t) => t.kind === 'error');
    expect(failure?.actionLabel).toBeTruthy();
    toast.runAction(failure?.id ?? 0);
    await settle();
    summaries().flush(page([]));
  });

  it('hides New module without content.edit, and blocks it without a change set', async () => {
    const hidden = await render(['content.read']);
    hidden.http
      .expectOne('/api/config')
      .flush({ data: { attributes: config } });
    await hidden.settle();
    const button = () =>
      [...hidden.el.querySelectorAll('of-page-header button')][0];
    expect(button()?.hasAttribute('hidden')).toBe(true);
    TestBed.resetTestingModule();

    const blocked = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    await blocked.settle();
    const newButton = blocked.el.querySelector('of-page-header button');
    expect(newButton?.getAttribute('aria-disabled')).toBe('true');
    expect(newButton?.getAttribute('aria-description')).toContain('revision');
  });

  it('offers a contributor “Suggest a new module” without a change set, and no row actions (#137)', async () => {
    const { http, el, settle, summaries } = await render([
      'content.read',
      'content.edit',
    ]);
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    summaries().flush(page([summary('charging', 'Charging')]));
    await settle();
    const newButton = el.querySelector('of-page-header button');
    expect(newButton?.textContent).toContain('Suggest a new module');
    expect(newButton?.getAttribute('aria-disabled')).not.toBe('true');
    // Deleting is no suggestion: the rows have no actions.
    expect(el.querySelector('[data-slot="row-actions"]')).toBeNull();
    expect(el.querySelector('tbody tr')?.textContent).toContain('Charging');
    http.match(() => true).forEach((r) => r.flush(page([])));
  });

  it('suggests a new module in a change set started for it, then opens it (#137)', async () => {
    const { http, settle, fixture } = await render([
      'content.read',
      'content.edit',
    ]);
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    await settle();
    const creation = TestBed.inject(ModuleCreation);
    const create = vi.spyOn(creation, 'create').mockResolvedValue(true);
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    const module = {
      id: 'wiring',
      title: 'Wiring',
      lang: 'en',
      type: 'concept',
      facets: {},
    };
    (
      fixture.componentInstance as unknown as {
        create(m: typeof module): void;
      }
    ).create(module);
    await settle();
    const started = http.expectOne(
      (r) => r.url === '/api/change-sets' && r.method === 'POST',
    );
    expect(started.request.body.data.attributes.title).toBe('Wiring');
    const CS = '0f0e0d0c-0b0a-7908-8706-050403020100';
    started.flush(
      {
        data: {
          type: 'ChangeSet',
          id: CS,
          attributes: {
            title: 'Wiring',
            description: null,
            state: 'draft',
            author: { kind: 'user', id: 'a' },
            baseRef: 'main',
            baseCommit: 'c0',
            branch: `change-sets/${CS}`,
            reviewHead: null,
            mergeCommit: null,
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
          },
        },
      },
      { status: 201, statusText: 'Created' },
    );
    await settle();
    await settle();
    expect(create).toHaveBeenCalledWith(
      module,
      { id: CS, branch: `change-sets/${CS}` },
      expect.anything(),
    );
    expect(navigate.mock.calls[0]?.[0]).toEqual(['/content', 'en', 'wiring']);
    http.match(() => true).forEach((r) => r.flush(page([])));
  });

  it('opens the new-module dialog asked for elsewhere, once the configuration is there', async () => {
    const CS = '0f0e0d0c-0b0a-7908-8706-050403020100';
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: CS, title: 'Spring', branch: `change-sets/${CS}` }),
    );
    const { http, settle } = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    TestBed.inject(NewModuleRequest).request();
    await settle();
    expect(document.querySelector('#new-module-title')).toBeNull();
    http.expectOne('/api/config').flush({ data: { attributes: config } });
    await settle();
    expect(document.querySelector('#new-module-title')).toBeTruthy();
    expect(TestBed.inject(NewModuleRequest).pending()).toBe(false);
    http.match(() => true).forEach((r) => r.flush(page([])));
  });

  describe('deleting', () => {
    const CS = '0f0e0d0c-0b0a-7908-8706-050403020100';
    beforeEach(() =>
      localStorage.setItem(
        'openfolia.change-set',
        JSON.stringify({
          id: CS,
          title: 'Spring',
          branch: `change-sets/${CS}`,
        }),
      ),
    );

    it('lists a module the change set deleted in every language as Deleted, by its old title', async () => {
      const { http, el, settle } = await render([
        'content.read',
        'content.read.draft',
        'content.edit',
      ]);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      http
        .expectOne(
          (r) =>
            r.url === '/api/module-summaries' && !r.params.has('filter[q]'),
        )
        .flush(page([summary('charging', 'Charging')]));
      const changes = http.expectOne(
        (r) => r.url === `/api/change-sets/${CS}/changes`,
      );
      expect(changes.request.params.get('page[size]')).toBe('200');
      const removed = (lang: string, id: string) => ({
        type: 'ChangeSetChange',
        id: `module/${lang}/${id}`,
        attributes: { subject: { type: 'module', lang, moduleId: id } },
        meta: { change: 'removed', fields: [], blocks: [], unreadable: false },
      });
      changes.flush({
        ...page([
          removed('en', 'old-guide'),
          removed('de', 'old-guide'),
          // Only its German version is gone: it is still listed.
          removed('de', 'charging'),
        ]),
        meta: { ...page([]).meta, base: 'base1', head: 'head1' },
      });
      await settle();
      // One module at a time: is a language of it left, and what was it called at the base.
      const seenRefs: (string | null)[] = [];
      for (let i = 0; i < 6; i++) {
        for (const r of http.match(
          (r) => r.url === '/api/module-summaries' && r.params.has('filter[q]'),
        )) {
          const id = r.request.params.get('filter[q]') ?? '';
          r.flush(
            page(id === 'charging' ? [summary('charging', 'Charging')] : []),
          );
        }
        for (const r of http.match(
          (r) => r.url === '/api/modules/en/old-guide',
        )) {
          seenRefs.push(r.request.params.get('ref'));
          r.flush({
            data: {
              attributes: {
                title: 'Old guide',
                moduleType: 'concept',
                audience: 'public',
              },
            },
          });
        }
        await settle();
      }
      expect(seenRefs).toEqual(['base1']);
      const rows = [...el.querySelectorAll('[data-slot="deleted-row"]')];
      expect(rows.length).toBe(1);
      expect(rows[0]?.textContent).toContain('Old guide');
      expect(rows[0]?.textContent).toContain('old-guide');
      expect(rows[0]?.textContent).toContain('Deleted');
      expect(rows[0]?.querySelector('a')).toBeNull();
    });

    it('has Delete in each row’s actions, which asks first', async () => {
      const { http, el, settle, noStates } = await render([
        'content.read',
        'content.read.draft',
        'content.edit',
      ]);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      http
        .expectOne((r) => r.url === '/api/module-summaries')
        .flush(page([summary('charging', 'Charging')]));
      http
        .expectOne((r) => r.url === `/api/change-sets/${CS}/changes`)
        .flush({
          ...page([]),
          meta: { ...page([]).meta, base: 'b', head: 'h' },
        });
      await noStates();
      const actions = el.querySelector<HTMLButtonElement>(
        '[data-slot="row-actions"]',
      );
      expect(actions?.getAttribute('aria-label')).toBe(
        'Actions for “Charging”',
      );
      actions?.click();
      await settle();
      document.querySelector<HTMLElement>('[data-slot="row-delete"]')?.click();
      await settle();
      const dialog = document.querySelector('z-dialog-panel');
      expect(dialog?.textContent).toContain('Delete “Charging”?');
      expect(dialog?.textContent).toContain('Spring');
      // Opening the row did not happen: the menu's click stays in its cell.
      expect(TestBed.inject(Router).url).toBe('/');
      http.match(() => true).forEach((r) => r.flush(page([])));
    });

    it('opens the row actions from the keyboard for that row', async () => {
      const { http, el, settle, noStates } = await render([
        'content.read',
        'content.read.draft',
        'content.edit',
      ]);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      http
        .expectOne((r) => r.url === '/api/module-summaries')
        .flush(
          page([summary('charging', 'Charging'), summary('safety', 'Safety')]),
        );
      http
        .expectOne((r) => r.url === `/api/change-sets/${CS}/changes`)
        .flush({
          ...page([]),
          meta: { ...page([]).meta, base: 'b', head: 'h' },
        });
      await noStates();
      const buttons = el.querySelectorAll<HTMLButtonElement>(
        '[data-slot="row-actions"]',
      );
      // The first row's menu by mouse, then the second's by keyboard only.
      buttons[0]?.click();
      await settle();
      document.body.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape' }),
      );
      buttons[1]?.focus();
      buttons[1]?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      );
      await settle();
      document.querySelector<HTMLElement>('[data-slot="row-delete"]')?.click();
      await settle();
      expect(document.querySelector('z-dialog-panel')?.textContent).toContain(
        'Delete “Safety”?',
      );
      http.match(() => true).forEach((r) => r.flush(page([])));
    });

    it('shows no row actions without content.edit', async () => {
      const { http, el, settle } = await render(['content.read']);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      http
        .expectOne((r) => r.url === '/api/module-summaries')
        .flush(page([summary('charging', 'Charging')]));
      http
        .match(() => true)
        .forEach((r) =>
          r.flush({
            ...page([]),
            meta: { ...page([]).meta, base: 'b', head: 'h' },
          }),
        );
      await settle();
      expect(el.querySelector('tbody tr')?.textContent).toContain('Charging');
      expect(el.querySelector('[data-slot="row-actions"]')).toBeNull();
    });
  });

  it('drops a request it did not take when it is left', async () => {
    const { fixture } = await render([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]);
    TestBed.inject(NewModuleRequest).request();
    fixture.destroy();
    expect(TestBed.inject(NewModuleRequest).pending()).toBe(false);
    TestBed.inject(HttpTestingController)
      .match(() => true)
      .forEach((r) => r.flush(page([])));
  });

  describe('view state in the address', () => {
    it('reads filters, search and page from the address, so a reload or a link shows the same', async () => {
      const { http, el, settle, summaries } = await render(
        ['content.read'],
        '/?type=concept&facet=region:north&keyword=battery&keyword=cable&q=charge&page=2&size=25',
      );
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      const req = summaries();
      const p = req.request.params;
      expect(p.get('filter[type]')).toBe('concept');
      expect(p.get('filter[facet]')).toBe('region:north');
      expect(p.getAll('filter[keyword]')).toEqual(['battery', 'cable']);
      expect(p.get('filter[q]')).toBe('charge');
      expect(p.get('page[number]')).toBe('2');
      expect(p.get('page[size]')).toBe('25');
      req.flush(page([]));
      await settle();
      expect(
        el.querySelector<HTMLInputElement>('input[type="search"]')?.value,
      ).toBe('charge');
    });

    it('writes a filter into the address, from page 1, and Reset filters clears it', async () => {
      const { http, el, settle, summaries } = await render(
        ['content.read'],
        '/?page=3',
      );
      const router = TestBed.inject(Router);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      summaries().flush({
        ...page([]),
        meta: { page: { currentPage: 3, lastPage: 5, perPage: 50, total: 0 } },
      });
      await settle();
      const group = [
        ...el.querySelectorAll<HTMLButtonElement>('nav button'),
      ].find((b) => b.textContent?.includes('North'));
      group?.click();
      await settle();
      expect(router.url).toBe('/?type=concept&facet=region:north');
      summaries().flush(page([]));
      await settle();
      const reset = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
        (b) => b.textContent?.includes('Reset filters'),
      );
      reset?.click();
      await settle();
      expect(router.url).toBe('/');
      summaries().flush(page([]));
    });

    it('hides deprecated modules unless "Show deprecated" is on, kept in the address (#266)', async () => {
      const { http, el, settle, summaries } = await render();
      const router = TestBed.inject(Router);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      const first = summaries();
      expect(first.request.params.get('filter[deprecated]')).toBe('false');
      first.flush(page([summary('charging', 'Charging')]));
      await settle();
      el.querySelector<HTMLElement>(
        '[data-slot="show-deprecated"] button',
      )?.click();
      await settle();
      expect(router.url).toBe('/?show=deprecated');
      const shown = summaries();
      expect(shown.request.params.has('filter[deprecated]')).toBe(false);
      shown.flush(
        page([
          {
            ...summary('old', 'Old module'),
            attributes: {
              ...summary('old', 'Old module').attributes,
              deprecated: { reason: 'Superseded.' },
            },
          },
        ]),
      );
      await settle();
      const badge = el.querySelector('[data-slot="row-deprecated"]');
      expect(badge?.textContent).toContain('Deprecated');
      expect(badge?.getAttribute('title')).toBe('Superseded.');
    });

    it('adds the deleted modules with "Show deleted", each opening its history (#320)', async () => {
      const { http, el, settle, summaries, noStates } = await render([
        'content.read',
        'content.read.draft',
      ]);
      const router = TestBed.inject(Router);
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      const first = summaries();
      expect(first.request.params.has('filter[status]')).toBe(false);
      first.flush(page([summary('charging', 'Charging')]));
      await noStates();
      expect(el.querySelector('[data-slot="removed-row"]')).toBeNull();
      el.querySelector<HTMLElement>(
        '[data-slot="show-deleted"] button',
      )?.click();
      await settle();
      expect(router.url).toBe('/?show=deleted');
      const shown = summaries();
      expect(shown.request.params.get('filter[status]')).toBe('any');
      shown.flush(
        page([
          summary('charging', 'Charging'),
          {
            ...summary('gone', 'Gone module'),
            attributes: {
              ...summary('gone', 'Gone module').attributes,
              languages: ['en', 'de'],
            },
            meta: {
              changed: true,
              deleted: {
                commit: 'c'.repeat(40),
                committedAt: '2026-03-01T10:00:00Z',
              },
            },
          },
        ]),
      );
      await noStates();
      const rows = el.querySelectorAll('[data-slot="removed-row"]');
      expect(rows).toHaveLength(1);
      const row = rows[0] as HTMLElement;
      expect(row.textContent).toContain('Gone module');
      expect(row.textContent).toContain('Deleted');
      expect(row.textContent).toContain('Mar 1, 2026');
      expect(row.textContent).toContain('en de');
      // No status of a module there, and no actions.
      expect(row.querySelector('of-status-badge')).toBeNull();
      expect(row.querySelector('[data-slot="row-actions"]')).toBeNull();
      const link = row.querySelector<HTMLAnchorElement>(
        '[data-slot="removed-history"]',
      );
      expect(link?.getAttribute('href')).toBe('/content/en/gone/history');
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      row.querySelector<HTMLElement>('td:nth-child(2)')?.click();
      expect(navigate).toHaveBeenCalledWith(
        ['/content', 'en', 'gone', 'history'],
        { queryParams: {} },
      );
    });

    it('disables "Show deleted", with the reason, for a reader without draft access, and asks for no deleted modules (#418)', async () => {
      const { http, el, settle, summaries } = await render(
        ['content.read'],
        '/?show=deleted',
      );
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      // The address asks for them, but they are not asked for.
      const req = summaries();
      expect(req.request.params.has('filter[status]')).toBe(false);
      req.flush(page([summary('charging', 'Charging')]));
      await settle();
      const toggle = el.querySelector<HTMLButtonElement>(
        '[data-slot="show-deleted"] button',
      );
      expect(toggle?.disabled).toBe(true);
      expect(toggle?.getAttribute('aria-checked')).toBe('false');
      const reason = el.querySelector('[data-slot="show-deleted-reason"]');
      expect(reason?.textContent).toContain(
        'Listing deleted modules needs access to drafts.',
      );
      expect(
        el
          .querySelector('[data-slot="show-deleted"]')
          ?.getAttribute('aria-describedby'),
      ).toBe('content-show-deleted-reason');
    });

    it('drops what is not valid, and a filter the configuration does not know', async () => {
      const { http, settle, summaries } = await render(
        ['content.read'],
        '/?type=gone&audience=public&page=abc&size=7&status=maybe',
      );
      const router = TestBed.inject(Router);
      await settle();
      expect(router.url).toBe('/?type=gone&audience=public');
      summaries().flush(page([]));
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      await settle();
      expect(router.url).toBe('/?audience=public');
      const req = summaries();
      expect(req.request.params.get('filter[type]')).toBeNull();
      expect(req.request.params.get('filter[audience]')).toBe('public');
      req.flush(page([]));
    });

    it('keeps the rows, dimmed, when the address changes the filters', async () => {
      const { http, el, settle, summaries } = await render();
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      summaries().flush(page([summary('charging', 'Charging')]));
      await settle();
      await TestBed.inject(Router).navigateByUrl('/?type=concept');
      await settle();
      expect(el.querySelector('of-skeleton-rows')).toBeNull();
      expect(el.querySelector('tbody')?.textContent).toContain('Charging');
      summaries().flush(page([]));
    });

    it('reads the list and the configuration again when the branch gets a new head, keeping the rows meanwhile (#466)', async () => {
      const { http, el, settle, summaries } = await render();
      http.expectOne('/api/config').flush({ data: { attributes: config } });
      summaries().flush(page([summary('charging', 'Charging')]));
      await settle();

      // An update from main moved the branch read; its name stayed.
      TestBed.inject(ReadRef).moves.update((n) => n + 1);
      await settle();
      const configRead = http.expectOne('/api/config');
      const req = summaries();
      // What was shown stays until the new list is there: no skeleton, no empty filters.
      expect(el.querySelector('of-skeleton-rows')).toBeNull();
      expect(el.querySelector('tbody')?.textContent).toContain('Charging');
      expect(el.querySelector('nav')?.textContent).toContain('Concept');

      configRead.flush({ data: { attributes: config } });
      req.flush(
        page([summary('charging', 'Charging'), summary('docking', 'Docking')]),
      );
      await settle();
      expect(el.querySelector('tbody')?.textContent).toContain('Docking');
    });
  });
});
