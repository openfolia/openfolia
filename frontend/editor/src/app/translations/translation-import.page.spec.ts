import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import {
  apiErrorInterceptor,
  stateChangeInterceptor,
} from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { TranslationImportPage } from './translation-import.page';

@Component({ template: '' })
class Blank {}

const ID = '019a0000-0000-7000-8000-000000000001';
const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (total: number, lastPage = 1, currentPage = 1) => ({
  currentPage,
  lastPage,
  perPage: 10,
  total,
});

const counts = {
  units: 4,
  ok: 2,
  sourceChanged: 1,
  brokenMarkup: 1,
  unknownBlock: 0,
  unknownModule: 0,
  outsideScope: 0,
};

const report = [
  {
    lang: 'de',
    moduleId: 'battery',
    title: 'Battery care',
    units: [
      { blockId: 'intro', kind: 'paragraph', state: 'ok' },
      {
        blockId: 'weight',
        kind: 'paragraph',
        state: 'source-changed',
        texts: {
          exported: 'The weight is 40 kg.',
          current: 'The weight is 42 kg.',
          target: 'Das Gewicht beträgt 40 kg.',
          truncated: false,
        },
      },
      {
        blockId: 'drive',
        kind: 'paragraph',
        state: 'broken-markup',
        reason: 'missing-code',
        detail: 'The code 1 is missing.',
      },
    ],
  },
  {
    lang: 'de',
    moduleId: 'safety',
    title: 'Safety',
    units: [{ blockId: 's1', kind: 'paragraph', state: 'ok' }],
  },
];

const importDoc = (
  overrides: {
    state?: 'validated' | 'applied';
    changeSet?: string | null;
    report?: typeof report;
    expiresAt?: string;
  } = {},
) => ({
  data: {
    type: 'TranslationImport',
    id: ID,
    attributes: {
      languages: ['de'],
      baseRef: 'main',
      baseCommit: 'abc',
      state: overrides.state ?? 'validated',
      createdBy: { kind: 'user', id: 'tina' },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt:
        overrides.expiresAt ?? new Date(Date.now() + 3_000_000).toISOString(),
    },
    relationships: {
      job: { data: { type: 'TranslationJob', id: 'job-1' } },
      changeSet: {
        data: overrides.changeSet
          ? { type: 'ChangeSet', id: overrides.changeSet }
          : null,
      },
    },
    meta: { counts, report: overrides.report ?? report },
  },
  meta: { page: page(2) },
  links,
});

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
  meta: { page: page(1) },
  links,
};

const job = {
  data: {
    type: 'TranslationJob',
    id: 'job-1',
    attributes: {
      languages: ['de'],
      subject: { type: 'manual', manualId: 'operating' },
      ref: 'main',
      commit: 'abc',
      state: 'sent',
      dueDate: null,
      createdBy: { kind: 'user', id: 'tina' },
      createdAt: '2026-11-19T10:00:00Z',
    },
    meta: { modules: 2, units: 4, words: 30, languages: [] },
  },
};

async function render(
  url: string,
  permissions = ['content.read', 'content.edit', 'translation.manage'],
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'translations/import',
          component: TranslationImportPage,
          canDeactivate: [(p: TranslationImportPage) => p.leave()],
        },
        { path: 'translations', component: Blank },
        { path: 'review', component: Blank },
      ]),
      provideHttpClient(
        withInterceptors([stateChangeInterceptor, apiErrorInterceptor]),
      ),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'tina',
    kind: 'user',
    name: 'Tina Translator',
    role: '',
    permissions: new Set(permissions),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  http.expectOne((r) => r.url === '/api/config').flush(config);
  http.expectOne((r) => r.url === '/api/manuals').flush(manuals);
  await settle();
  return {
    http,
    settle,
    harness,
    router: TestBed.inject(Router),
    el: () => harness.fixture.nativeElement as HTMLElement,
  };
}

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const slot = (root: HTMLElement, name: string) =>
  root.querySelector(`[data-slot="${name}"]`);

const flushJob = (http: HttpTestingController) =>
  http
    .match((r) => r.url === '/api/translations/exports/job-1')
    .forEach((r) => r.flush(job));

/** Picks `file` in the drop zone's input, as the file dialog would. */
function pick(root: HTMLElement, file: File): void {
  const input = root.querySelector<HTMLInputElement>(
    '[data-slot="drop-zone"] input[type="file"]',
  )!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

const xliff = () =>
  new File(['<xliff version="2.0"/>'], 'battery_de.xlf', {
    type: 'application/xliff+xml',
  });

describe('TranslationImportPage: validating', () => {
  it('uploads the file as a dry run and shows the counts and the report', async () => {
    const { http, settle, el, router } = await render('/translations/import');
    expect(slot(el(), 'drop-zone')).not.toBeNull();
    // The drop zone is reached with the keyboard: its file input is focusable.
    const input = el().querySelector<HTMLInputElement>(
      '[data-slot="drop-zone"] input[type="file"]',
    )!;
    expect(input.tabIndex).not.toBe(-1);
    expect(input.accept).toBe('.xlf,.xliff,.zip,.coti');

    pick(el(), xliff());
    await settle();
    const req: TestRequest = http.expectOne(
      (r) => r.url === '/api/translations/imports' && r.method === 'POST',
    );
    const body = req.request.body as FormData;
    expect(body.get('dryRun')).toBe('true');
    expect((body.get('file') as File).name).toBe('battery_de.xlf');
    expect(req.request.headers.get('X-Ccms-Request')).toBe('1');
    expect(req.request.params.get('page[size]')).toBe('10');
    req.flush(importDoc(), { status: 201, statusText: 'Created' });
    await settle();
    flushJob(http);
    await settle();

    expect(router.url).toContain(`import=${ID}`);
    expect(text(slot(el(), 'file'))).toContain('battery_de.xlf');
    expect(text(slot(el(), 'file-meta'))).toContain('Delta export · Operating');
    expect(text(slot(el(), 'count-ready'))).toContain('2');
    expect(text(slot(el(), 'count-decide'))).toContain('1');
    expect(text(slot(el(), 'count-refused'))).toContain('1');

    const modules = [...el().querySelectorAll('[data-slot="report-module"]')];
    expect(modules.map((m) => m.getAttribute('data-module'))).toEqual([
      'battery',
      'safety',
    ]);
    // A broken unit is listed with its reason; the rest go in.
    const broken = el().querySelector('[data-block="drive"]');
    expect(text(broken)).toContain('Broken markup');
    expect(text(broken)).toContain(
      'A formatting tag was removed in the translation.',
    );
    expect(text(slot(el(), 'apply'))).toBe('Import 3 units');
  });

  it('refuses a file of another type before uploading it', async () => {
    const { http, settle, el } = await render('/translations/import');
    pick(el(), new File(['x'], 'notes.txt'));
    await settle();
    http.expectNone('/api/translations/imports');
    expect(text(slot(el(), 'upload-error'))).toContain('Choose an XLIFF file');
  });

  it('names why a whole document is refused', async () => {
    const { http, settle, el } = await render('/translations/import');
    pick(el(), xliff());
    await settle();
    http.expectOne('/api/translations/imports?page%5Bsize%5D=10').flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable',
            code: 'xliff-dtd-forbidden',
            detail: 'A DOCTYPE.',
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();
    expect(text(slot(el(), 'upload-error'))).toContain(
      'declares a document type',
    );
    expect(slot(el(), 'drop-zone')).not.toBeNull();
  });
});

describe('TranslationImportPage: the report', () => {
  it('reads the import of the address, and pages and filters it there', async () => {
    const { http, settle, el, router } = await render(
      `/translations/import?import=${ID}`,
    );
    const first = http.expectOne(
      (r) => r.url === `/api/translations/imports/${ID}`,
    );
    expect(first.request.params.get('filter[state]')).toBeNull();
    first.flush(importDoc());
    await settle();
    flushJob(http);
    await settle();

    // The filter offers the states the report has, with their counts.
    const filter = slot(el(), 'state-filter')!;
    expect([...filter.querySelectorAll('input')].map((i) => i.value)).toEqual([
      'all',
      'ok',
      'source-changed',
      'broken-markup',
    ]);
    const broken = filter.querySelector<HTMLInputElement>(
      'input[value="broken-markup"]',
    )!;
    broken.click();
    await settle();
    expect(router.url).toContain('state=broken-markup');
    const filtered = http.expectOne(
      (r) => r.url === `/api/translations/imports/${ID}`,
    );
    expect(filtered.request.params.get('filter[state]')).toBe('broken-markup');
    expect(filtered.request.params.get('page[number]')).toBe('1');
    filtered.flush(
      importDoc({ report: [{ ...report[0]!, units: [report[0]!.units[2]!] }] }),
    );
    await settle();
    expect(el().querySelectorAll('of-import-unit')).toHaveLength(1);
    // The counts stay the whole report's.
    expect(text(slot(el(), 'apply'))).toBe('Import 3 units');
  });

  it('ignores a page that answers after the address went back to the one shown', async () => {
    const { http, settle, el, router } = await render(
      `/translations/import?import=${ID}`,
    );
    http
      .expectOne((r) => r.url === `/api/translations/imports/${ID}`)
      .flush(importDoc());
    await settle();
    flushJob(http);
    await settle();

    await router.navigateByUrl(`/translations/import?import=${ID}&page=2`);
    await settle();
    const stale = http.expectOne(
      (r) =>
        r.url === `/api/translations/imports/${ID}` &&
        r.params.get('page[number]') === '2',
    );
    // Back to page 1 before page 2 answers: page 1 is already shown.
    await router.navigateByUrl(`/translations/import?import=${ID}`);
    await settle();
    http.expectNone((r) => r.url === `/api/translations/imports/${ID}`);
    expect(
      (slot(el(), 'replace') as HTMLButtonElement).hasAttribute('disabled'),
    ).toBe(false);

    stale.flush(importDoc({ report: [report[1]!] }));
    await settle();
    expect(el().querySelectorAll('of-import-unit')).toHaveLength(4);
  });

  it('reads the import again when the address comes back to it before another answered', async () => {
    const other = '019a0000-0000-7000-8000-000000000002';
    const { http, settle, el, router } = await render(
      `/translations/import?import=${ID}`,
    );
    http
      .expectOne((r) => r.url === `/api/translations/imports/${ID}`)
      .flush(importDoc());
    await settle();
    flushJob(http);
    await settle();

    await router.navigateByUrl(`/translations/import?import=${other}`);
    await settle();
    const stale = http.expectOne(
      (r) => r.url === `/api/translations/imports/${other}`,
    );
    await router.navigateByUrl(`/translations/import?import=${ID}`);
    await settle();
    http
      .expectOne((r) => r.url === `/api/translations/imports/${ID}`)
      .flush(importDoc());
    await settle();
    stale.flush(
      { errors: [{ status: '404', title: 'Not found', code: 'not-found' }] },
      { status: 404, statusText: 'Not Found' },
    );
    await settle();
    flushJob(http);
    await settle();
    expect(el().querySelectorAll('of-import-unit')).toHaveLength(4);
    expect(slot(el(), 'apply')).not.toBeNull();
  });

  it('shows an expired validation, and checks the file again in one click', async () => {
    const { http, settle, el } = await render('/translations/import');
    pick(el(), xliff());
    await settle();
    http
      .expectOne((r) => r.url === '/api/translations/imports')
      .flush(
        importDoc({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        { status: 201, statusText: 'Created' },
      );
    await settle();
    flushJob(http);
    await settle();
    expect(slot(el(), 'expired')).not.toBeNull();
    expect(slot(el(), 'apply')?.getAttribute('aria-disabled')).toBe('true');

    (slot(el(), 'revalidate') as HTMLButtonElement).click();
    await settle();
    const again = http.expectOne((r) => r.url === '/api/translations/imports');
    expect((again.request.body as FormData).get('file')).toBeInstanceOf(File);
    again.flush(importDoc(), { status: 201, statusText: 'Created' });
    await settle();
    expect(slot(el(), 'expired')).toBeNull();
  });

  it('says so when the import is gone (404), with no file to check again', async () => {
    const { http, settle, el } = await render(
      `/translations/import?import=${ID}`,
    );
    http
      .expectOne((r) => r.url === `/api/translations/imports/${ID}`)
      .flush(
        { errors: [{ status: '404', title: 'Not found', code: 'not-found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    await settle();
    expect(text(slot(el(), 'expired'))).toContain('Choose the file again');
  });
});

describe('TranslationImportPage: deciding and importing', () => {
  async function validated(permissions?: string[]) {
    const t = await render(`/translations/import?import=${ID}`, permissions);
    t.http
      .expectOne((r) => r.url === `/api/translations/imports/${ID}`)
      .flush(importDoc());
    await t.settle();
    flushJob(t.http);
    await t.settle();
    return t;
  }

  it('shows the old and the new source with diff marks, and the translation', async () => {
    const { el } = await validated();
    const unit = el().querySelector('[data-block="weight"]')!;
    expect(text(unit)).toContain('Source changed');
    expect(text(unit.querySelector('[data-slot="before"] del'))).toContain(
      '40',
    );
    expect(text(unit.querySelector('[data-slot="after"] ins'))).toContain('42');
    expect(text(unit.querySelector('[data-slot="target"]'))).toBe(
      'Das Gewicht beträgt 40 kg.',
    );
    // Keep is the default (#240).
    const keep = unit.querySelector<HTMLInputElement>('input[value="keep"]')!;
    expect(keep.checked).toBe(true);
  });

  it('skips one unit, imports with that decision and opens the change set in review', async () => {
    const { http, settle, el, router } = await validated();
    el()
      .querySelector<HTMLInputElement>(
        '[data-block="weight"] input[value="skip"]',
      )!
      .click();
    await settle();
    expect(text(slot(el(), 'apply'))).toBe('Import 2 units');
    expect(text(slot(el(), 'skipped'))).toBe('1 of 1 skipped');

    (slot(el(), 'apply') as HTMLButtonElement).click();
    await settle();
    // Every changed unit is read first, so the decisions name them all.
    const changed = http.expectOne(
      (r) =>
        r.url === `/api/translations/imports/${ID}` &&
        r.params.get('filter[state]') === 'source-changed',
    );
    expect(changed.request.params.get('page[size]')).toBe('200');
    changed.flush(
      importDoc({ report: [{ ...report[0]!, units: [report[0]!.units[1]!] }] }),
    );
    await settle();
    const apply = http.expectOne(
      (r) => r.url === `/api/translations/imports/${ID}/apply`,
    );
    expect(apply.request.body).toEqual({
      meta: {
        decisions: [
          {
            lang: 'de',
            moduleId: 'battery',
            blockId: 'weight',
            decision: 'skip',
          },
        ],
      },
    });
    apply.flush(importDoc({ state: 'applied', changeSet: 'cs-1' }));
    await settle();
    http
      .expectOne((r) => r.url === '/api/change-sets/cs-1')
      .flush({
        data: {
          type: 'ChangeSet',
          id: 'cs-1',
          attributes: { title: 'Translation: Operating' },
        },
      });
    await settle();

    expect(text(slot(el(), 'done'))).toContain(
      '2 units are in the change set “Translation: Operating”',
    );
    const open = slot(el(), 'open-review') as HTMLAnchorElement;
    expect(open.getAttribute('href')).toBe('/review?cs=cs-1');
    open.click();
    await settle();
    // Applied: leaving asks nothing.
    expect(router.url).toBe('/review?cs=cs-1');
  });

  it('skips all with Undo, and imports without decisions when every one is kept', async () => {
    const { http, settle, el } = await validated();
    (slot(el(), 'skip-all') as HTMLButtonElement).click();
    await settle();
    expect(text(slot(el(), 'apply'))).toBe('Import 2 units');
    const toast = TestBed.inject(ToastService).toasts().at(-1)!;
    expect(toast.actionLabel).toBeTruthy();
    TestBed.inject(ToastService).runAction(toast.id);
    await settle();
    expect(text(slot(el(), 'apply'))).toBe('Import 3 units');

    (slot(el(), 'apply') as HTMLButtonElement).click();
    await settle();
    http
      .expectOne((r) => r.params.get('filter[state]') === 'source-changed')
      .flush(importDoc());
    await settle();
    const apply = http.expectOne(
      (r) => r.url === `/api/translations/imports/${ID}/apply`,
    );
    expect(apply.request.body).toEqual({});
  });

  it('blocks Import with its reason without content.edit', async () => {
    const { el } = await validated(['content.read', 'translation.manage']);
    const apply = slot(el(), 'apply')!;
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(apply.getAttribute('aria-description')).toContain(
      'permission to edit content',
    );
  });

  it('asks before leaving an unapplied validation, and stays on "Stay"', async () => {
    const { settle, router } = await validated();
    let answer: 'ok' | 'cancel' = 'cancel';
    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        ((answer === 'ok' ? config.zOnOk : config.zOnCancel) as () => void)();
        return { isClosing: () => false } as never;
      });
    expect(await router.navigateByUrl('/translations')).toBe(false);
    await settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(router.url).toContain('/translations/import');
    answer = 'ok';
    expect(await router.navigateByUrl('/translations')).toBe(true);
    expect(router.url).toBe('/translations');
  });
});
