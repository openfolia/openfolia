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
import { UsageReportPage } from './usage-report.page';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, perPage = 25) => ({
  currentPage: 1,
  lastPage: 1,
  perPage,
  total,
});

const use = (
  kind: 'manual' | 'module',
  id: string,
  title: string,
  direct = true,
) => ({ kind, id, title, direct, deprecated: false });

const row = (
  moduleId: string,
  title: string,
  usage: { manuals: number; modules: number },
  usedIn: ReturnType<typeof use>[],
  extra: { type?: string; deprecated?: boolean; languages?: string[] } = {},
) => ({
  type: 'ModuleUsage',
  id: moduleId,
  attributes: {
    moduleId,
    title,
    type: extra.type ?? 'concept',
    deprecated: extra.deprecated ?? false,
  },
  meta: { languages: extra.languages ?? ['en'], usage, usedIn },
});

const report = {
  data: [
    row(
      'charging',
      'Charging',
      { manuals: 2, modules: 0 },
      [
        use('manual', 'operating', 'Operating manual'),
        use('manual', 'service', 'Service manual'),
      ],
      { type: 'procedure', languages: ['en', 'de'] },
    ),
    row('safety-note', 'Safety note', { manuals: 1, modules: 1 }, [
      use('manual', 'operating', 'Operating manual', false),
      use('module', 'charging', 'Charging'),
    ]),
    row('orphan', 'Orphan', { manuals: 0, modules: 0 }, [], {
      deprecated: true,
    }),
  ],
  meta: { page: page(3) },
  links,
};

const config = {
  data: {
    type: 'Config',
    id: 'config',
    attributes: {
      languages: { source: 'en', targets: ['de'] },
      moduleTypes: [
        { id: 'concept', label: 'Concept' },
        { id: 'procedure', label: 'Procedure' },
      ],
    },
  },
};

async function render(url = '/reports/usage') {
  const save = vi.fn().mockResolvedValue(undefined);
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        { path: 'reports/usage', component: UsageReportPage },
        { path: 'manuals', children: [] },
        { path: 'content/:lang/:moduleId', children: [] },
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
    permissions: new Set(['content.read', 'content.read.draft']),
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
  http.expectOne((r) => r.url === '/api/reports/module-usage');

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('UsageReportPage', () => {
  it('lists the modules with their use counts and the manuals each is in', async () => {
    const { http, settle, el } = await render();
    const req = reportRequest(http);
    expect(req.request.params.get('sort')).toBe('title');
    expect(req.request.params.has('filter[unused]')).toBe(false);
    req.flush(report);
    await settle();

    const rows = [...el().querySelectorAll('[data-slot="usage-row"]')];
    expect(rows.map((r) => r.getAttribute('data-module'))).toEqual([
      'charging',
      'safety-note',
      'orphan',
    ]);
    const [charging, note, orphan] = rows as [Element, Element, Element];
    expect(text(charging.querySelector('[data-slot="usage-manuals"]'))).toBe(
      '2',
    );
    expect(text(charging.querySelector('[data-slot="usage-modules"]'))).toBe(
      '0',
    );
    expect(text(charging)).toContain('Procedure');
    expect(
      [...charging.querySelectorAll('[data-slot="usage-manual-link"]')].map(
        (a) => a.getAttribute('href'),
      ),
    ).toEqual(['/manuals?manual=operating', '/manuals?manual=service']);
    expect(
      charging
        .querySelector('[data-slot="usage-module-link"]')
        ?.getAttribute('href'),
    ).toBe('/content/en/charging');
    // Through a module reference, said in words; and who refers to it.
    expect(text(note.querySelector('[data-slot="usage-used-in"] li'))).toBe(
      'Operating manual (through a module reference)',
    );
    expect(text(note.querySelector('[data-slot="usage-referred-by"]'))).toBe(
      'Referred to by Charging',
    );
    expect(note.querySelector('[data-slot="usage-unused"]')).toBe(null);
    expect(text(orphan.querySelector('[data-slot="usage-unused"]'))).toBe(
      'Unused',
    );
    expect(text(orphan)).toContain('In no manual');
    expect(text(orphan)).toContain('Deprecated');
  });

  it('shows the unused modules, sorted by use, from the address', async () => {
    const { http, settle, el } = await render(
      '/reports/usage?show=unused&type=procedure&sort=most-used&size=50',
    );
    const req = reportRequest(http);
    expect(req.request.params.get('filter[unused]')).toBe('true');
    expect(req.request.params.get('filter[type]')).toBe('procedure');
    expect(req.request.params.get('sort')).toBe('-usage,title');
    expect(req.request.params.get('page[size]')).toBe('50');
    req.flush({ ...report, data: [], meta: { page: page(0, 50) } });
    await settle();
    // With a type chosen, "every module is in use" would claim too much.
    expect(text(el())).toContain('Nothing matches these filters');
  });

  it('says every module is in use when no module is unused', async () => {
    const { http, settle, el } = await render('/reports/usage?show=unused');
    reportRequest(http).flush({ ...report, data: [], meta: { page: page(0) } });
    await settle();
    expect(text(el())).toContain('Every module is in use');
  });

  it('switches to Unused with the view control, from the first page', async () => {
    const { http, settle, router, el } = await render('/reports/usage?page=2');
    reportRequest(http).flush(report);
    await settle();
    const unused = [
      ...el().querySelectorAll<HTMLInputElement>(
        '[data-filter="show"] input[type="radio"]',
      ),
    ].find((i) => i.value === 'unused')!;
    unused.click();
    await settle();
    expect(router.url).toBe('/reports/usage?show=unused');
    expect(reportRequest(http).request.params.get('filter[unused]')).toBe(
      'true',
    );
  });

  it('downloads the CSV of what it shows', async () => {
    const { http, settle, save, el } = await render(
      '/reports/usage?show=used&sort=least-used',
    );
    reportRequest(http).flush(report);
    await settle();
    el()
      .querySelector<HTMLButtonElement>('[data-slot="report-download"]')!
      .click();
    await settle();
    expect(save).toHaveBeenCalledWith(
      '/reports/module-usage/csv',
      {
        'filter[unused]': 'false',
        'filter[type]': undefined,
        sort: 'usage,title',
      },
      'module-usage.csv',
    );
  });
});
