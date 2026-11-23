import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ReportDownload } from './report-download';
import { TranslationReportPage } from './translation-report.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 25) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const counts = (
  upToDate: number,
  outdated: number,
  atProvider: number,
  missing: number,
) => ({
  total: upToDate + outdated + atProvider + missing,
  upToDate,
  outdated,
  atProvider,
  missing,
});

const row = (
  manualId: string,
  lang: string,
  title: string,
  modules: ReturnType<typeof counts>,
  blocks: ReturnType<typeof counts>,
  deprecated = false,
) => ({
  type: 'TranslationCoverage',
  id: `${manualId}/${lang}`,
  attributes: { manualId, lang },
  meta: { title, deprecated, modules, blocks },
});

const report = {
  data: [
    row(
      'operating',
      'de',
      'Operating manual with a title long enough to wrap across the cell',
      counts(3, 1, 0, 0),
      counts(7, 1, 0, 0),
    ),
    row(
      'operating',
      'fr',
      'Operating manual',
      counts(0, 0, 0, 0),
      counts(0, 0, 0, 0),
    ),
    row(
      'old',
      'de',
      'Old manual',
      counts(1, 0, 1, 2),
      counts(2, 0, 1, 3),
      true,
    ),
  ],
  meta: { page: page(3) },
  links,
};

const manuals = {
  data: [
    {
      type: 'Manual',
      id: 'operating',
      attributes: { title: 'Operating manual' },
    },
  ],
  meta: { page: page(1, 200) },
  links,
};

const config = {
  data: {
    type: 'Config',
    id: 'config',
    attributes: {
      languages: { source: 'en', targets: ['de', 'fr'] },
      moduleTypes: [],
    },
  },
};

async function render(
  url = '/reports/translations',
  permissions = ['content.read', 'content.read.draft', 'translation.manage'],
) {
  const save = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'reports/translations', component: TranslationReportPage },
        { path: 'translations', children: [] },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
      { provide: ReportDownload, useValue: { save } },
    ],
  });
  TestBed.inject(MeService).set({
    id: 'lea',
    kind: 'user',
    name: 'Lea Lead',
    role: '',
    permissions: new Set(permissions),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
  http.expectOne((r) => r.url === '/api/config').flush(config);
  return {
    http,
    settle,
    save,
    router: TestBed.inject(Router),
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

const reportRequest = (http: HttpTestingController) =>
  http.expectOne((r) => r.url === '/api/reports/translations');

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('TranslationReportPage', () => {
  it('shows each manual and language with a bar, the share and the counts in words', async () => {
    const { http, settle, el } = await render();
    const req = reportRequest(http);
    expect(req.request.params.get('page[size]')).toBe('25');
    expect(req.request.params.has('filter[manual]')).toBe(false);
    req.flush(report);
    await settle();

    const rows = [...el().querySelectorAll('[data-slot="coverage-row"]')];
    expect(rows.map((r) => r.getAttribute('data-row'))).toEqual([
      'operating/de',
      'operating/fr',
      'old/de',
    ]);
    const first = rows[0]!;
    const meter = first.querySelector('[data-slot="meter-bar"]');
    expect(meter?.getAttribute('aria-valuenow')).toBe('75');
    expect(meter?.getAttribute('aria-valuetext')).toBe('75%');
    expect(text(first.querySelector('[data-slot="coverage-share"]'))).toBe(
      '75%',
    );
    // The status is in words too, never by the bar alone.
    expect(
      [...first.querySelectorAll('[data-slot="coverage-status"] > span')].map(
        text,
      ),
    ).toEqual([
      '3 of 4 modules up to date · 1 outdated · 0 at the agency · 0 missing',
      'Blocks: 7 of 8 up to date · 1 outdated · 0 at the agency · 0 missing',
    ]);
    // A language with nothing to translate says so instead of an empty bar.
    expect(rows[1]!.querySelector('[data-slot="meter-bar"]')).toBe(null);
    expect(text(rows[1]!)).toContain('No modules to translate');
    expect(text(rows[2]!)).toContain('Deprecated');
    expect(text(rows[2]!.querySelector('[data-slot="coverage-share"]'))).toBe(
      '25%',
    );
  });

  it('links each row to the Translations screen filtered to its manual and language', async () => {
    const { http, settle, el } = await render();
    reportRequest(http).flush(report);
    await settle();
    const link = el().querySelector('[data-slot="coverage-link"]');
    expect(link?.getAttribute('href')).toBe(
      '/translations?manual=operating&lang=de',
    );
  });

  it('leaves the link out for someone who may not open Translations', async () => {
    const { http, settle, el } = await render('/reports/translations', [
      'content.read',
      'content.read.draft',
    ]);
    reportRequest(http).flush(report);
    await settle();
    expect(el().querySelector('[data-slot="coverage-link"]')).toBe(null);
    expect(el().querySelectorAll('[data-slot="coverage-row"]').length).toBe(3);
  });

  it('reads the filters and the page from the address, and downloads what they show', async () => {
    const { http, settle, save, el } = await render(
      '/reports/translations?manual=operating&lang=de&page=2&size=50',
    );
    const req = reportRequest(http);
    expect(req.request.params.get('filter[manual]')).toBe('operating');
    expect(req.request.params.get('filter[lang]')).toBe('de');
    expect(req.request.params.get('page[number]')).toBe('2');
    expect(req.request.params.get('page[size]')).toBe('50');
    req.flush({ ...report, data: [] });
    await settle();
    expect(text(el())).toContain('Nothing matches these filters');
    el()
      .querySelector<HTMLButtonElement>('[data-slot="report-download"]')!
      .click();
    await settle();
    expect(save).toHaveBeenCalledWith(
      '/reports/translations/csv',
      { 'filter[manual]': 'operating', 'filter[lang]': 'de' },
      'translation-coverage.csv',
    );
  });

  it('clears the filters back to the whole report', async () => {
    const { http, settle, router, el } = await render(
      '/reports/translations?lang=fr',
    );
    reportRequest(http).flush(report);
    await settle();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="report-clear"]')!
      .click();
    await settle();
    expect(router.url).toBe('/reports/translations');
    expect(reportRequest(http).request.params.has('filter[lang]')).toBe(false);
  });

  it('shows an error with Retry when the report cannot be read', async () => {
    const { http, settle, el } = await render();
    reportRequest(http).flush(
      {
        errors: [{ status: '503', code: 'unavailable', title: 'Unavailable' }],
      },
      { status: 503, statusText: 'Unavailable' },
    );
    await settle();
    const retry = [...el().querySelectorAll('button')].find((b) =>
      /try again/i.test(text(b)),
    );
    expect(retry).toBeDefined();
    retry!.click();
    await settle();
    reportRequest(http).flush(report);
    await settle();
    expect(el().querySelectorAll('[data-slot="coverage-row"]').length).toBe(3);
  });
});
