import {
  HttpEventType,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { provideZard } from '@openfolia/ui/core';

import {
  apiErrorInterceptor,
  stateChangeInterceptor,
} from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import type { ImportReport, ReportItem } from './import-model';
import { ImportPage } from './import.page';

const u8 = (text: string) => new TextEncoder().encode(text);

@Component({ template: '' })
class Blank {}

const ID = '019a0000-0000-7000-8000-000000000001';
const SECOND = '019a0000-0000-7000-8000-000000000002';
const CHANGE_SET = 'cs-import';
const MAX = 64 * 1024 * 1024;
const links = { self: '', first: '', last: '', prev: null, next: null };

const importer = (id: string, label: string, optionsSchema = {}) => ({
  type: 'Importer',
  id,
  attributes: { label, description: `${label}: what it reads.` },
  meta: {
    optionsSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
      ...optionsSchema,
    },
    maxBytes: MAX,
  },
});

const importers = {
  // The server lists them by ID; the screen puts the documented format first.
  data: [
    importer('dita', 'DITA project', {
      properties: {
        folder: { type: 'string', title: 'Target folder' },
      },
    }),
    importer('bundle', 'Import bundle'),
  ],
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 100, total: 2 } },
  links,
};

const reportItem = (over: Partial<ReportItem>): ReportItem => ({
  kind: 'module',
  id: 'tank-filling',
  lang: 'en',
  pointer: '/modules/0',
  action: 'create',
  reasons: [],
  issues: [],
  issueCount: 0,
  ...over,
});

const ITEMS: ReportItem[] = [
  reportItem({ sourceId: 'PAGE-1042' }),
  reportItem({ lang: 'de', pointer: '/modules/1', sourceId: 'PAGE-1042' }),
  reportItem({
    id: 'pressure-limits',
    pointer: '/modules/2',
    sourceId: 'PAGE-1043',
    passthrough: 1,
  }),
  reportItem({ kind: 'manual', id: 'pump-guide', pointer: '/manuals/0' }),
];

const REFUSED = reportItem({
  id: 'odd-module',
  pointer: '/modules/3',
  sourceId: 'PAGE-2000',
  action: 'refuse',
  reasons: [
    {
      severity: 'error',
      code: 'unknown-module-type',
      message: 'The module type "widget" is not configured.',
    },
  ],
  issueCount: 1,
});

const reportOf = (
  items: ReportItem[],
  applicableWithoutRefused = true,
): ImportReport => ({
  valid: items.every((i) => i.action !== 'refuse'),
  applicable: items.every((i) => i.action !== 'refuse'),
  applicableWithoutRefused,
  issues: [],
  items,
  converterReport: [
    {
      sourceId: 'PAGE-1043',
      message: 'An embedded calculator was kept as a passthrough block.',
      module: 'pressure-limits',
    },
    { sourceId: 'PAGE-1044', message: 'An empty page; not converted.' },
  ],
  counts: {
    modules: 3,
    manuals: 1,
    assets: 0,
    create: items.filter((i) => i.action === 'create').length,
    update: 0,
    skip: 0,
    refuse: items.filter((i) => i.action === 'refuse').length,
    passthrough: 1,
    errors: 0,
    warnings: 0,
    converterReport: 2,
  },
});

const importDoc = (
  over: {
    id?: string;
    state?: 'validated' | 'applying' | 'applied' | 'failed';
    items?: ReportItem[];
    /** The rest stands without the refused items (default true). */
    rest?: boolean;
    expiresAt?: string;
    progress?: Partial<ImportReport['counts']> & {
      phase?: 'queued' | 'files' | 'done';
      files?: number;
      commits?: string[];
    };
    changeSet?: string;
    failure?: { code: string; detail: string };
  } = {},
) => ({
  data: {
    type: 'Import',
    id: over.id ?? ID,
    attributes: {
      importer: 'bundle',
      options: {},
      updateExisting: false,
      baseRef: 'main',
      baseCommit: 'abc',
      fileName: 'loading.zip',
      size: 2048,
      state: over.state ?? 'validated',
      createdBy: { kind: 'user', id: 'ada' },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt:
        over.expiresAt ?? new Date(Date.now() + 3_000_000).toISOString(),
      startedAt: null,
      finishedAt: null,
    },
    ...(over.changeSet && {
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: over.changeSet } },
      },
    }),
    meta: {
      dryRun: false,
      report: reportOf(over.items ?? ITEMS, over.rest ?? true),
      progress: {
        phase: over.progress?.phase ?? 'queued',
        assets: { done: 0, total: 0 },
        files: { done: over.progress?.files ?? 0, total: 4 },
        commits: over.progress?.commits ?? [],
      },
      failure: over.failure ?? null,
    },
  },
});

async function render(
  url: string,
  permissions = ['admin.roles', 'content.read', 'content.edit'],
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'admin/import',
          component: ImportPage,
          canDeactivate: [(p: ImportPage) => p.leave()],
        },
        { path: 'admin/roles', component: Blank },
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
    id: 'ada',
    kind: 'user',
    name: 'Ada Admin',
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
  http.expectOne((r) => r.url === '/api/importers').flush(importers);
  await settle();
  return {
    http,
    settle,
    router: TestBed.inject(Router),
    el: () => harness.fixture.nativeElement as HTMLElement,
  };
}

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

const slot = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLElement>(`[data-slot="${name}"]`);

/** Picks `file` in the drop zone's input, as the file dialog would. */
function pick(root: HTMLElement, file: File): void {
  // The drop zone's input, or, once a file is chosen, the one "Choose another file" opens.
  const input =
    root.querySelector<HTMLInputElement>(
      '[data-slot="drop-zone"] input[type="file"]',
    ) ?? root.querySelector<HTMLInputElement>('#import-file')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
}

const bundleFile = () =>
  new File([u8('PK, a bundle')], 'loading.zip', { type: 'application/zip' });

/** Runs the dry run for `file` and answers it with `doc`. */
async function dryRun(
  t: Awaited<ReturnType<typeof render>>,
  doc = importDoc(),
) {
  pick(t.el(), bundleFile());
  await t.settle();
  // A small bundle's size in kilobytes, never "0 MB".
  expect(text(slot(t.el(), 'file'))).toMatch(/\d+ kB/);
  slot(t.el(), 'dry-run')!.click();
  await t.settle();
  const req = t.http.expectOne(
    (r) => r.url === '/api/imports' && r.method === 'POST',
  );
  req.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 4 });
  await t.settle();
  expect(text(slot(t.el(), 'upload-progress'))).toContain('Uploading: 25');
  req.flush(doc, { status: 201, statusText: 'Created' });
  await t.settle();
  return req;
}

describe('ImportPage: the steps', () => {
  it('offers the importers, the documented format first and chosen, with the size limit', async () => {
    const { el } = await render('/admin/import');
    const radios = [
      ...el().querySelectorAll<HTMLElement>('[data-importer]'),
    ].map((r) => r.getAttribute('data-importer'));
    expect(radios).toEqual(['bundle', 'dita']);
    const chosen = el().querySelector(
      '[data-importer="bundle"] [role="radio"]',
    );
    expect(chosen?.getAttribute('aria-checked')).toBe('true');
    expect(text(el().querySelector('[data-importer="bundle"]'))).toContain(
      'Import bundle: what it reads.',
    );
    expect(text(slot(el(), 'size-limit'))).toMatch(/At most 64 MB per file/);
    // The drop zone is reached with the keyboard: its file input is focusable.
    const input = el().querySelector<HTMLInputElement>(
      '[data-slot="drop-zone"] input[type="file"]',
    )!;
    expect(input.tabIndex).not.toBe(-1);
    expect(input.accept).toBe('.zip,application/zip');
    // Without a file there is no dry run, and it says why.
    expect(slot(el(), 'dry-run')!.getAttribute('aria-disabled')).toBe('true');
    expect(slot(el(), 'dry-run')!.getAttribute('aria-description')).toContain(
      'Choose a file first',
    );
  });

  it('refuses a file larger than the limit before sending it', async () => {
    const { http, settle, el } = await render('/admin/import');
    const big = new File(['x'], 'huge.zip');
    Object.defineProperty(big, 'size', { value: MAX + 1 });
    pick(el(), big);
    await settle();
    expect(text(slot(el(), 'file-error'))).toContain(
      'the server takes at most 64 MB',
    );
    expect(slot(el(), 'file')).toBeNull();
    http.expectNone('/api/imports');
  });

  it('renders the chosen importer’s options and keeps the choice in the address', async () => {
    const { settle, el, router } = await render('/admin/import');
    expect(el().querySelector('[data-option]')).toBeNull();
    expect(text(slot(el(), 'step-options'))).toContain(
      'This importer takes no options of its own.',
    );
    (
      el().querySelector('[data-importer="dita"] [role="radio"]') as HTMLElement
    ).click();
    await settle();
    expect(router.url).toContain('importer=dita');
    expect(text(el().querySelector('[data-option="folder"]'))).toContain(
      'Target folder',
    );
  });

  it('sends the file with the importer, its options and "Update existing", and shows the report', async () => {
    const t = await render('/admin/import');
    (
      t.el().querySelector('[data-slot="update-existing"] input') as HTMLElement
    ).click();
    await t.settle();
    const req = await dryRun(t);
    const body = req.request.body as FormData;
    expect(body.get('importer')).toBe('bundle');
    expect(body.get('options')).toBe('{}');
    expect(body.get('updateExisting')).toBe('true');
    expect(body.get('dryRun')).toBe('false');
    expect((body.get('file') as File).name).toBe('loading.zip');
    expect(req.request.headers.get('X-Ccms-Request')).toBe('1');

    const el = t.el();
    expect(t.router.url).toContain(`import=${ID}`);
    // The setup gives way to a summary of what was checked.
    expect(text(slot(el, 'summary'))).toContain('loading.zip');
    expect(text(slot(el, 'count-create'))).toContain('4');
    expect(text(slot(el, 'count-refuse'))).toContain('0');
    expect(text(slot(el, 'count-passthrough'))).toMatch(
      /^1 ?block kept verbatim$/,
    );
    // Every item: its result in a word, the new ID beside the source ID.
    const rows = [...el.querySelectorAll('[data-slot="report-item"]')];
    expect(rows).toHaveLength(4);
    expect(text(rows[0]?.querySelector('[data-slot="result"]'))).toBe('Create');
    expect(text(rows[0]?.querySelector('[data-slot="item-id"]'))).toBe(
      'tank-filling',
    );
    expect(text(rows[0]?.querySelector('[data-slot="source-id"]'))).toBe(
      'PAGE-1042',
    );
    // The converter's note is with the module it names; the other is the bundle's.
    expect(text(rows[2])).toContain('An embedded calculator was kept');
    expect(text(slot(el, 'bundle-findings'))).toContain(
      'About the bundle: 1 note',
    );
    expect(text(slot(el, 'apply'))).toBe('Import 4 items');
  });

  it('names why the server refused the upload, under the file', async () => {
    const t = await render('/admin/import');
    pick(t.el(), bundleFile());
    await t.settle();
    slot(t.el(), 'dry-run')!.click();
    await t.settle();
    t.http.expectOne('/api/imports').flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable',
            code: 'invalid-archive',
            detail: 'Not a ZIP.',
            meta: { reason: 'not-a-zip' },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await t.settle();
    expect(text(slot(t.el(), 'file-error'))).toContain(
      'not a ZIP file the importer can read safely',
    );
    expect(t.router.url).not.toContain('import=');
  });
});

describe('ImportPage: moving away during an upload', () => {
  it('ends the upload’s busy state when the address moves on meanwhile', async () => {
    const t = await render('/admin/import');
    await dryRun(t);
    slot(t.el(), 'change')!.click();
    await t.settle();
    pick(t.el(), bundleFile());
    await t.settle();
    slot(t.el(), 'dry-run')!.click();
    await t.settle();
    const req = t.http.expectOne(
      (r) => r.url === '/api/imports' && r.method === 'POST',
    );
    // Back, as the browser's button would: the import leaves the address.
    await t.router.navigateByUrl('/admin/import');
    await t.settle();
    req.flush(importDoc({ id: SECOND }), {
      status: 201,
      statusText: 'Created',
    });
    await t.settle();
    expect(slot(t.el(), 'upload-progress')).toBeNull();
    expect(slot(t.el(), 'dry-run')?.getAttribute('aria-busy')).not.toBe('true');
    expect(t.router.url).not.toContain(SECOND);
  });
});

describe('ImportPage: the report', () => {
  it('reads the import of the address, and filters and pages it there', async () => {
    const t = await render(`/admin/import?import=${ID}`);
    t.http
      .expectOne(`/api/imports/${ID}`)
      .flush(importDoc({ items: [...ITEMS, REFUSED] }));
    await t.settle();
    const filter = slot(t.el(), 'result-filter')!;
    expect([...filter.querySelectorAll('input')].map((i) => i.value)).toEqual([
      'all',
      'create',
      'refuse',
    ]);
    (filter.querySelector('input[value="refuse"]') as HTMLInputElement).click();
    await t.settle();
    expect(t.router.url).toContain('result=refuse');
    const rows = [...t.el().querySelectorAll('[data-slot="report-item"]')];
    expect(rows.map((r) => r.getAttribute('data-id'))).toEqual(['odd-module']);
    expect(text(rows[0])).toContain(
      'Its module type is not configured in this project.',
    );
    expect(text(rows[0])).toContain('unknown-module-type');
  });

  it('runs an expired dry run again in one click', async () => {
    const t = await render('/admin/import');
    await dryRun(
      t,
      importDoc({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
    );
    expect(text(slot(t.el(), 'expired'))).toContain('more than an hour old');
    expect(slot(t.el(), 'apply')!.getAttribute('aria-disabled')).toBe('true');
    slot(t.el(), 'run-again')!.click();
    await t.settle();
    t.http
      .expectOne((r) => r.url === '/api/imports' && r.method === 'POST')
      .flush(importDoc({ id: SECOND }), { status: 201, statusText: 'Created' });
    await t.settle();
    expect(t.router.url).toContain(`import=${SECOND}`);
    expect(slot(t.el(), 'expired')).toBeNull();
  });

  it('asks before leaving a dry run not imported, and stays on "Stay"', async () => {
    const t = await render('/admin/import');
    await dryRun(t);
    let answer: 'ok' | 'cancel' = 'cancel';
    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        ((answer === 'ok' ? config.zOnOk : config.zOnCancel) as () => void)();
        return { isClosing: () => false } as never;
      });
    expect(await t.router.navigateByUrl('/admin/roles')).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    answer = 'ok';
    expect(await t.router.navigateByUrl('/admin/roles')).toBe(true);
  });

  it('blocks Import with its reason without content.edit', async () => {
    const t = await render(`/admin/import?import=${ID}`, [
      'admin.roles',
      'content.read',
    ]);
    t.http.expectOne(`/api/imports/${ID}`).flush(importDoc());
    await t.settle();
    const apply = slot(t.el(), 'apply')!;
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    expect(apply.getAttribute('aria-description')).toContain(
      'permission to edit content',
    );
  });
});

describe('ImportPage: importing', () => {
  it('applies, follows the progress and opens the revision in review', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const t = await render('/admin/import');
      await dryRun(t);
      slot(t.el(), 'apply')!.click();
      await t.settle();
      const apply = t.http.expectOne(`/api/imports/${ID}/apply`);
      expect(apply.request.method).toBe('POST');
      apply.flush(
        importDoc({
          state: 'applying',
          progress: { phase: 'files', files: 1 },
        }),
        { status: 202, statusText: 'Accepted' },
      );
      await t.settle();
      expect(text(slot(t.el(), 'applying'))).toContain(
        '1 of 4 modules and manuals saved',
      );
      expect(
        slot(t.el(), 'applying')!
          .querySelector('[role="progressbar"]')
          ?.getAttribute('aria-valuenow'),
      ).toBe('25');

      await vi.advanceTimersByTimeAsync(1_100);
      await t.settle();
      t.http.expectOne(`/api/imports/${ID}`).flush(
        importDoc({
          state: 'applied',
          changeSet: CHANGE_SET,
          progress: { phase: 'done', files: 4, commits: ['c1', 'c2'] },
        }),
      );
      await t.settle();
      t.http.expectOne(`/api/change-sets/${CHANGE_SET}`).flush({
        data: {
          type: 'ChangeSet',
          id: CHANGE_SET,
          attributes: { title: 'Import of loading.zip' },
        },
      });
      await t.settle();
      expect(text(slot(t.el(), 'done'))).toContain(
        '4 items imported into the revision “Import of loading.zip” in 2 save points',
      );
      const open = slot(t.el(), 'open-review') as HTMLAnchorElement;
      expect(open.getAttribute('href')).toBe(`/review?cs=${CHANGE_SET}`);
      // Done: leaving asks nothing.
      expect(await t.router.navigateByUrl('/admin/roles')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says why the job failed', async () => {
    const t = await render(`/admin/import?import=${ID}`);
    t.http.expectOne(`/api/imports/${ID}`).flush(
      importDoc({
        state: 'failed',
        failure: { code: 'locked', detail: 'Locked.' },
      }),
    );
    await t.settle();
    expect(text(slot(t.el(), 'failed'))).toContain(
      'Another revision holds a module or manual of this import.',
    );
  });

  it('imports the rest without the refused items, once confirmed, for any importer', async () => {
    const t = await render('/admin/import');
    const doc = importDoc({ items: [...ITEMS, REFUSED] });
    doc.data.attributes.importer = 'dita';
    await dryRun(t, doc);
    expect(slot(t.el(), 'apply')).toBeNull();
    const rest = slot(t.el(), 'import-rest')!;
    expect(text(rest)).toBe('Import 4 items without the refused');
    const confirm = vi
      .spyOn(TestBed.inject(ZardAlertDialogService), 'confirm')
      .mockImplementation((config) => {
        (config.zOnOk as () => void)();
        return { isClosing: () => false } as never;
      });
    rest.click();
    await t.settle();
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0]?.[0].zDescription).toContain(
      '1 refused item is left out',
    );
    // No second upload: the server leaves the refused items out itself.
    t.http.expectNone((r) => r.url === '/api/imports' && r.method === 'POST');
    const apply = t.http.expectOne(`/api/imports/${ID}/apply`);
    expect(apply.request.body).toEqual({ meta: { skipRefused: true } });
    apply.flush(importDoc({ state: 'applying' }), {
      status: 202,
      statusText: 'Accepted',
    });
    await t.settle();
    expect(slot(t.el(), 'applying')).not.toBeNull();
  });

  it('applies without the flag when nothing is refused', async () => {
    const t = await render('/admin/import');
    await dryRun(t);
    slot(t.el(), 'apply')!.click();
    await t.settle();
    const apply = t.http.expectOne(`/api/imports/${ID}/apply`);
    expect(apply.request.body).toEqual({});
  });

  it('blocks Import when the rest does not stand without the refused items', async () => {
    const t = await render('/admin/import');
    await dryRun(t, importDoc({ items: [...ITEMS, REFUSED], rest: false }));
    expect(slot(t.el(), 'import-rest')).toBeNull();
    const apply = slot(t.el(), 'apply')!;
    expect(apply.getAttribute('aria-disabled')).toBe('true');
    apply.click();
    await t.settle();
    t.http.expectNone(`/api/imports/${ID}/apply`);
  });
});
