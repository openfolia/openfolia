import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { advance } from '../testing/fake-time';
import { TranslationJobDownload } from './job-download';
import { TranslationJobsPage } from './translation-jobs.page';
import { TranslationStatusPage } from './translation-status.page';
import { TranslationsPage } from './translations.page';

@Component({ template: '' })
class Blank {}

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 50) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const status = (
  moduleId: string,
  lang: string,
  state: string,
  outdatedBlocks = 0,
  title = moduleId,
) => ({
  type: 'TranslationStatus',
  id: `${lang}/${moduleId}`,
  attributes: { moduleId, lang, state },
  meta: {
    title,
    totalBlocks: 3,
    outdatedBlocks,
    atProviderBlocks: state === 'at-provider' ? 3 : 0,
    sourceCommit: null,
  },
});

const statuses = {
  data: [
    status('battery', 'de', 'outdated', 2, 'Battery care'),
    status('battery', 'fr', 'outdated', 2, 'Battery care'),
    status('safety', 'de', 'up-to-date', 0, 'Safety'),
    status('safety', 'fr', 'missing', 3, 'Safety'),
  ],
  meta: { page: page(4) },
  links,
};

const config = {
  data: {
    type: 'Config',
    id: 'config',
    attributes: {
      languages: { source: 'en', targets: ['de', 'fr'] },
      moduleTypes: [{ id: 'task', label: 'Task' }],
      facets: [],
      audiences: [],
    },
  },
};

const manuals = {
  data: [
    { type: 'Manual', id: 'operating', attributes: { title: 'Operating' } },
  ],
  meta: { page: page(1, 200) },
  links,
};

const moduleDoc = (lang: string, texts: Record<string, string>) => ({
  data: {
    type: 'Module',
    id: `${lang}/battery`,
    attributes: {
      moduleId: 'battery',
      lang,
      schemaVersion: 1,
      title: 'Battery care',
      moduleType: 'task',
      facets: {},
      blocks: Object.entries(texts).map(([id, text]) => ({
        type: 'paragraph',
        id,
        content: [{ type: 'text', text }],
      })),
    },
    meta: { issues: [], status: {}, usage: {}, usedIn: [] },
  },
});

const job = (state = 'sent') => ({
  type: 'TranslationJob',
  id: 'job-1',
  attributes: {
    languages: ['de', 'fr'],
    subject: { type: 'manual', manualId: 'operating' },
    ref: 'main',
    commit: 'abc',
    state,
    dueDate: null,
    createdBy: { kind: 'user', id: 'tina' },
    createdAt: '2026-11-19T10:00:00Z',
  },
  meta: {
    modules: 2,
    units: 4,
    words: 30,
    languages: [
      { lang: 'de', modules: 1, units: 2, words: 15 },
      { lang: 'fr', modules: 2, units: 2, words: 15 },
    ],
  },
});

async function render(
  url: string,
  managedLanguages?: ReadonlySet<string> | 'all',
) {
  const save = vi.fn().mockResolvedValue(undefined);
  const savePackage = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'translations',
          component: TranslationsPage,
          children: [
            { path: '', pathMatch: 'full', component: TranslationStatusPage },
            { path: 'jobs', component: TranslationJobsPage },
          ],
        },
        { path: 'content/:lang/:id', component: Blank },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
      { provide: TranslationJobDownload, useValue: { save, savePackage } },
    ],
  });
  TestBed.inject(MeService).set({
    id: 'tina',
    kind: 'user',
    name: 'Tina Translator',
    role: '',
    permissions: new Set(['content.read', 'translation.manage']),
    managedLanguages,
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time from here: the search's and the dry run's debounces are waited out on the fake
  // clock, which runs every timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 5; i++) await advance();
  };
  await settle();
  http.expectOne((r) => r.url === '/api/config').flush(config);
  http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
  await settle();
  return {
    http,
    settle,
    save,
    savePackage,
    router: TestBed.inject(Router),
    el: () => harness.fixture.nativeElement as HTMLElement,
  };
}

const statusRequest = (http: HttpTestingController): TestRequest =>
  http.expectOne((r) => r.url === '/api/translations/status');

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** Waits out `ms` of the fake clock. */
const wait = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe('TranslationsPage: Status', () => {
  it('shows each module × language as a badge, outdated with its block count', async () => {
    const { http, settle, el } = await render('/translations');
    const req = statusRequest(http);
    // A page of rows (#689): 25 rows, each with its statuses in every language.
    expect(req.request.params.get('page[by]')).toBe('row');
    expect(req.request.params.get('page[size]')).toBe('25');
    req.flush({ ...statuses, meta: { page: page(2, 25) } });
    await settle();

    const rows = [...el().querySelectorAll('[data-slot="matrix-row"]')];
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual([
      'battery',
      'safety',
    ]);
    const cells = (row: Element) =>
      [...row.querySelectorAll('[data-slot="matrix-cell"]')].map(text);
    expect(cells(rows[0]!)).toEqual(['2 outdated', '2 outdated']);
    expect(cells(rows[1]!)).toEqual(['Up to date', 'Not translated']);
    // Status never by colour alone: each cell names its module, language and state.
    expect(
      rows[0]!
        .querySelector('[data-slot="matrix-cell"]')
        ?.getAttribute('aria-label'),
    ).toBe('Battery care in German: 2 outdated');
    expect(text(el().querySelector('[data-slot="list-pagination"]'))).toContain(
      '2 in total',
    );
  });

  it('reads the filters from the address and asks for them', async () => {
    const { http } = await render(
      '/translations?manual=operating&folder=task&lang=de&state=outdated&q=batt',
    );
    const req = statusRequest(http);
    expect(req.request.params.get('filter[manual]')).toBe('operating');
    expect(req.request.params.get('filter[folder]')).toBe('task');
    expect(req.request.params.get('filter[lang]')).toBe('de');
    expect(req.request.params.get('filter[state]')).toBe('outdated');
    expect(req.request.params.get('filter[q]')).toBe('batt');
    expect(req.request.params.get('page[by]')).toBe('row');
    expect(req.request.params.get('page[size]')).toBe('25');
  });

  it('counts the rows the API counts, though a row lacks a language (#689)', async () => {
    const { http, settle, el } = await render('/translations');
    // `safety` has no French cell (outside the reader's scope): two rows, three statuses.
    statusRequest(http).flush({
      data: [
        status('battery', 'de', 'outdated', 2, 'Battery care'),
        status('battery', 'fr', 'outdated', 2, 'Battery care'),
        status('safety', 'de', 'up-to-date', 0, 'Safety'),
      ],
      meta: { page: page(2, 25) },
      links,
    });
    await settle();
    expect(el().querySelectorAll('[data-slot="matrix-row"]')).toHaveLength(2);
    expect(text(el().querySelector('[data-slot="list-pagination"]'))).toContain(
      '2 in total',
    );
  });

  it('opens a cell in the side panel with exactly its outdated blocks, source and translation', async () => {
    const { http, settle, el, router } = await render('/translations');
    statusRequest(http).flush(statuses);
    await settle();
    el().querySelector<HTMLButtonElement>('[data-cell="de/battery"]')!.click();
    await settle();
    expect(router.url).toBe('/translations?cell=de%2Fbattery');

    http.expectOne('/api/translations/status/de/battery').flush({
      data: {
        ...status('battery', 'de', 'outdated', 2, 'Battery care'),
        meta: {
          ...status('battery', 'de', 'outdated', 2).meta,
          title: 'Battery care',
          blocks: [
            { blockId: 'p1', state: 'up-to-date' },
            { blockId: 'p2', state: 'outdated' },
            { blockId: 'p3', state: 'outdated' },
          ],
        },
      },
    });
    http.expectOne('/api/modules/en/battery').flush(
      moduleDoc('en', {
        p1: 'Charge it.',
        p2: 'Unplug it.',
        p3: 'Store it.',
      }),
    );
    await settle();
    http
      .expectOne('/api/modules/de/battery')
      .flush(moduleDoc('de', { p1: 'Laden.', p2: 'Ausstecken.' }));
    await settle();

    const panel = el().querySelector('[data-slot="cell-panel"]')!;
    const blocks = [...panel.querySelectorAll('[data-slot="panel-block"]')];
    expect(blocks.map((b) => b.getAttribute('data-block'))).toEqual([
      'p2',
      'p3',
    ]);
    expect(text(blocks[0]!.querySelector('[data-slot="block-source"]'))).toBe(
      'Unplug it.',
    );
    expect(text(blocks[0]!.querySelector('[data-slot="block-target"]'))).toBe(
      'Ausstecken.',
    );
    expect(text(blocks[1]!.querySelector('[data-slot="block-target"]'))).toBe(
      'Not translated yet',
    );
    expect(
      panel.querySelector('[data-slot="open-source"]')?.getAttribute('href'),
    ).toBe('/content/en/battery');
    // Opening a cell reads the matrix not again.
    http.expectNone((r) => r.url === '/api/translations/status');
  });

  it('counts the blocks in the panel summary by the total, the verb by those open (#694)', async () => {
    const { http, settle, el } = await render('/translations');
    statusRequest(http).flush(statuses);
    await settle();
    el().querySelector<HTMLButtonElement>('[data-cell="de/battery"]')!.click();
    await settle();
    http.expectOne('/api/translations/status/de/battery').flush({
      data: {
        ...status('battery', 'de', 'outdated', 1, 'Battery care'),
        meta: {
          ...status('battery', 'de', 'outdated', 1).meta,
          title: 'Battery care',
          totalBlocks: 1,
          blocks: [{ blockId: 'p1', state: 'outdated' }],
        },
      },
    });
    http
      .expectOne('/api/modules/en/battery')
      .flush(moduleDoc('en', { p1: 'Charge it.' }));
    await settle();
    http
      .expectOne('/api/modules/de/battery')
      .flush(moduleDoc('de', { p1: 'Laden.' }));
    await settle();
    expect(text(el().querySelector('[data-slot="panel-summary"]'))).toBe(
      '1 of 1 block needs work',
    );
  });

  it('moves between cells with the arrow keys, one cell in the tab order', async () => {
    const { http, settle, el } = await render('/translations');
    statusRequest(http).flush(statuses);
    await settle();
    const cell = (key: string) =>
      el().querySelector<HTMLButtonElement>(`[data-cell="${key}"]`)!;
    expect(cell('de/battery').tabIndex).toBe(0);
    expect(cell('fr/battery').tabIndex).toBe(-1);
    cell('de/battery').focus();
    const press = (key: string) =>
      document.activeElement!.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true }),
      );
    press('ArrowRight');
    expect(document.activeElement).toBe(cell('fr/battery'));
    press('ArrowDown');
    expect(document.activeElement).toBe(cell('fr/safety'));
    press('Home');
    expect(document.activeElement).toBe(cell('de/safety'));
    press('ArrowUp');
    expect(document.activeElement).toBe(cell('de/battery'));
    await settle();
    expect(cell('de/battery').tabIndex).toBe(0);
  });

  it('keeps the chosen rows in the address', async () => {
    const { http, settle, el, router } = await render('/translations');
    statusRequest(http).flush(statuses);
    await settle();
    el()
      .querySelector<HTMLInputElement>(
        '[data-row="safety"] [data-slot="choose-row"] input',
      )!
      .click();
    await settle();
    expect(router.url).toBe('/translations?rows=safety');
    expect(text(el().querySelector('[data-slot="chosen-count"]'))).toBe(
      '1 module chosen',
    );
    // Choosing a row reads the matrix not again.
    http.expectNone((r) => r.url === '/api/translations/status');
  });

  it('searches after a pause and keeps a trailing space in the box', async () => {
    const { http, settle, el, router } = await render('/translations');
    statusRequest(http).flush(statuses);
    await settle();
    const box = el().querySelector<HTMLInputElement>('input[type="search"]')!;
    box.value = 'battery ';
    box.dispatchEvent(new Event('input'));
    await wait(350);
    await settle();
    expect(router.url).toBe('/translations?q=battery');
    expect(statusRequest(http).request.params.get('filter[q]')).toBe('battery');
    expect(box.value).toBe('battery ');
  });

  it('shows an error with Retry when the status cannot be read', async () => {
    const { http, settle, el } = await render('/translations');
    statusRequest(http).flush(
      { errors: [{ status: '503', code: 'unavailable', title: 'x' }] },
      { status: 503, statusText: 'Unavailable' },
    );
    await settle();
    const retry = [...el().querySelectorAll('button')].find((b) =>
      /try again/i.test(text(b)),
    );
    retry!.click();
    await settle();
    statusRequest(http).flush(statuses);
    await settle();
    expect(el().querySelectorAll('[data-slot="matrix-row"]').length).toBe(2);
  });
});

describe('TranslationsPage: delta export', () => {
  it('counts with a dry run, then exports the chosen rows, downloads the file and reads the matrix again', async () => {
    const { http, settle, el, save, router } = await render(
      '/translations?rows=battery&lang=de',
    );
    statusRequest(http).flush(statuses);
    await settle();
    el().querySelector<HTMLButtonElement>('[data-slot="export"]')!.click();
    await settle();
    expect(router.url).toContain('export=open');
    await wait(300);
    await settle();

    const dry = http.expectOne(
      (r) => r.url === '/api/translations/exports' && r.method === 'POST',
    );
    expect(dry.request.body).toEqual({
      data: {
        type: 'TranslationJob',
        attributes: {
          languages: ['de'],
          subject: { type: 'modules', moduleIds: ['battery'] },
        },
      },
      meta: { dryRun: true },
    });
    dry.flush({ data: { ...job(), meta: { ...job().meta, dryRun: true } } });
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(text(dialog.querySelector('[data-slot="estimate-total"]'))).toBe(
      '2 modules · 4 blocks · 30 words',
    );

    dialog
      .querySelector<HTMLButtonElement>('[data-slot="export-confirm"]')!
      .click();
    await settle();
    const real = http.expectOne(
      (r) => r.url === '/api/translations/exports' && r.method === 'POST',
    );
    expect(real.request.body.meta).toBeUndefined();
    real.flush({ data: job() });
    await settle();
    expect(save).toHaveBeenCalledWith({ id: 'job-1', languages: ['de', 'fr'] });
    // The cells turn "at the agency": the matrix is read again.
    statusRequest(http).flush(statuses);
    await settle();
    expect(router.url).not.toContain('export=open');
  });

  it('says so when there is nothing to send', async () => {
    const { http, settle } = await render(
      '/translations?export=open',
      new Set(['de']),
    );
    statusRequest(http).flush(statuses);
    await settle();
    await wait(300);
    await settle();
    const dry = http.expectOne((r) => r.url === '/api/translations/exports');
    // Only the languages the person manages translations into.
    expect(dry.request.body.data.attributes.languages).toEqual(['de']);
    // The first manual, as none was filtered.
    expect(dry.request.body.data.attributes.subject).toEqual({
      type: 'manual',
      manualId: 'operating',
    });
    dry.flush(
      {
        errors: [
          { status: '422', code: 'nothing-to-translate', title: 'Nothing' },
        ],
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await settle();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.querySelector('[data-slot="estimate-nothing"]')).not.toBe(
      null,
    );
    expect(
      dialog
        .querySelector('[data-slot="export-confirm"]')
        ?.hasAttribute('disabled') ||
        dialog
          .querySelector('[data-slot="export-confirm"]')
          ?.getAttribute('aria-disabled') === 'true',
    ).toBe(true);
  });
});

describe('TranslationsPage: Jobs', () => {
  it('lists the jobs and cancels one with Undo, sending the cancel once the toast ends', async () => {
    const { http, settle, el } = await render('/translations/jobs');
    http
      .expectOne((r) => r.url === '/api/translations/exports')
      .flush({ data: [job()], meta: { page: page(1, 25) }, links });
    await settle();
    const row = el().querySelector('[data-slot="job-row"]')!;
    expect(text(row)).toContain('Delta export · Operating');
    expect(text(row)).toContain('2 modules · 4 blocks · 30 words');
    expect(text(row.querySelector('[data-slot="job-state"]'))).toBe(
      'At the agency',
    );

    const toasts = TestBed.inject(ToastService);
    row.querySelector<HTMLButtonElement>('[data-slot="job-cancel"]')!.click();
    await settle();
    expect(text(row.querySelector('[data-slot="job-state"]'))).toBe(
      'Cancelled',
    );
    // Undo: nothing is sent, the job is back at the agency.
    toasts.runAction(toasts.toasts().at(-1)!.id);
    await settle();
    http.expectNone((r) => r.url.endsWith('/cancel'));
    expect(text(row.querySelector('[data-slot="job-state"]'))).toBe(
      'At the agency',
    );

    // Again, and the toast ends: the cancel goes.
    row.querySelector<HTMLButtonElement>('[data-slot="job-cancel"]')!.click();
    await settle();
    toasts.dismiss(toasts.toasts().at(-1)!.id);
    await settle();
    http
      .expectOne('/api/translations/exports/job-1/cancel')
      .flush({ data: job('cancelled') });
    await settle();
    http
      .expectOne((r) => r.url === '/api/translations/exports')
      .flush({ data: [job('cancelled')], meta: { page: page(1, 25) }, links });
    await settle();
    expect(
      text(el().querySelector('[data-slot="job-row"] [data-slot="job-state"]')),
    ).toBe('Cancelled');
  });

  it('downloads a job as a COTI package, but not a cancelled one (#140)', async () => {
    const { http, settle, el, savePackage } =
      await render('/translations/jobs');
    http
      .expectOne((r) => r.url === '/api/translations/exports')
      .flush({
        data: [job(), { ...job('cancelled'), id: 'job-2' }],
        meta: { page: page(1, 25) },
        links,
      });
    await settle();
    const [sent, cancelled] = el().querySelectorAll('[data-slot="job-row"]');
    const button = sent!.querySelector<HTMLButtonElement>(
      '[data-slot="job-package"]',
    )!;
    expect(button.getAttribute('aria-label')).toBe(
      'Download Delta export · Operating as a COTI package',
    );
    expect(text(button)).toBe('COTI package');
    button.click();
    await settle();
    expect(savePackage).toHaveBeenCalledWith({ id: 'job-1' });
    expect(cancelled!.querySelector('[data-slot="job-package"]')).toBeNull();
  });

  it('says so when a package could not be downloaded', async () => {
    const { http, settle, el, savePackage } =
      await render('/translations/jobs');
    savePackage.mockRejectedValueOnce(new Error('offline'));
    http
      .expectOne((r) => r.url === '/api/translations/exports')
      .flush({ data: [job()], meta: { page: page(1, 25) }, links });
    await settle();
    el().querySelector<HTMLButtonElement>('[data-slot="job-package"]')!.click();
    await settle();
    const toasts = TestBed.inject(ToastService).toasts();
    expect(JSON.stringify(toasts.at(-1))).toContain('packageFailed');
  });
});
