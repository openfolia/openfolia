import {
  HttpEventType,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { provideZard } from '@openfolia/ui/core';
import { LanguageService, provideI18nTesting } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import uiEn from '../../../../ui/src/i18n/en.json';
// eslint-disable-next-line no-restricted-imports, @nx/enforce-module-boundaries
import uiDe from '../../../../ui/src/i18n/de.json';
import editorDe from '../../i18n/de.json';
import editorEn from '../../i18n/en.json';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ReleaseDetailPage } from './release-detail.page';
import {
  answer,
  change,
  config,
  detail,
  manual,
  output,
  paged,
  progress,
  release,
  RELEASE_ID,
} from './testing/releases';
import { advance } from '../testing/fake-time';

type Req = TestRequest['request'];

const files = [
  output('o1'),
  output('o2', {
    lang: 'de',
    state: 'failed',
    error: { code: 'render-failed', detail: 'Font missing' },
  }),
  output('o3', { manual: 'service', state: 'rendering' }),
];

const handlers = (
  over: {
    release?: unknown;
    outputs?: () => unknown;
  } = {},
) =>
  [
    [
      (r: Req) => r.url === '/api/config',
      () => ({
        data: { type: 'ProjectConfig', id: 'main', attributes: config() },
      }),
    ],
    [
      (r: Req) => r.url === `/api/releases/${RELEASE_ID}`,
      () =>
        over.release ??
        detail(
          release({ notesByLanguage: { de: 'Drehmomente korrigiert.' } }),
          progress('rendering', 3, 1, 1, 1),
        ),
    ],
    [
      (r: Req) => r.url === `/api/releases/${RELEASE_ID}/outputs`,
      over.outputs ?? (() => paged(files)),
    ],
    [
      (r: Req) => r.url === `/api/releases/${RELEASE_ID}/changes`,
      () =>
        paged(
          [
            change('operating', 'en', [
              { moduleId: 'torque', change: 'changed', fields: [], blocks: [] },
              {
                moduleId: 'old-step',
                change: 'removed',
                fields: [],
                blocks: [],
              },
            ]),
            change('service', 'de', [], 'added'),
          ],
          2,
          { previous: { id: 'p', revision: '2.0', tag: 'release/north/2.0' } },
        ),
    ],
    [
      (r: Req) => r.url === '/api/manuals',
      () =>
        paged([manual('operating', 'Operating'), manual('service', 'Service')]),
    ],
  ] as const;

async function render(
  url: string,
  permissions = ['content.read'],
  { german = false } = {},
) {
  TestBed.configureTestingModule({
    providers: [
      // The interface in German too, for the notes' language (#794).
      ...(german
        ? [
            provideI18nTesting({
              en: { ui: uiEn, editor: editorEn },
              de: { ui: uiDe, editor: editorDe },
            }),
          ]
        : []),
      provideRouter([
        { path: 'releases/:releaseId', component: ReleaseDetailPage },
        { path: 'releases', children: [] },
        { path: 'preview', children: [] },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'reader',
    kind: 'user',
    name: 'Reader',
    role: '',
    permissions: new Set(permissions),
  });
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  void harness.navigateByUrl(url);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      // On fake time (a test of the polling), the fake clock runs what is due (#562).
      if (vi.isFakeTimers()) {
        await advance();
        continue;
      }
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  await settle();
  return {
    harness,
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
    url: () => TestBed.inject(Router).url,
  };
}

const webhooks = (el: HTMLElement) =>
  el.querySelector<HTMLElement>(
    'a[href="/admin/webhooks?event=manual.released"]',
  );

const text = (el: Element | null | undefined) =>
  el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

describe('ReleaseDetailPage', () => {
  it('shows the release: its notes per language, changes and files by manual, read-only for a reader', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(http, handlers(), settle);
    expect(text(el().querySelector('h1'))).toContain('North 2.1');
    expect(text(el())).toContain('Published');
    expect(text(el())).toContain('release/north/2.1');
    expect(text(el().querySelector('[data-slot="notes"]'))).toBe(
      'Torque values corrected.',
    );

    // Changes since the previous release; a row opens to its modules.
    expect(text(el())).toContain(
      'Since 2.0, the previous release of this product.',
    );
    expect(text(el())).toContain('Operating');
    expect(text(el())).toContain('2 modules');

    // Files by manual, then variant and language; Retry only for a publisher.
    const groups = [...el().querySelectorAll('th[scope="colgroup"]')];
    expect(groups.map((g) => text(g.querySelector('span > span')))).toEqual([
      'Operating',
      'Service',
    ]);
    // Each manual names the page design its files are printed with (#589).
    expect(
      groups.map((g) => text(g.querySelector('[data-slot="design-in-use"]'))),
    ).toEqual([
      'Design: Classic, project default',
      'Design: Classic, project default',
    ]);
    const failed = el().querySelector('[data-state-file="failed"]');
    expect(text(failed)).toContain('Failed');
    const retry = [...(failed?.querySelectorAll('button') ?? [])].find((b) =>
      text(b).includes('Try again'),
    );
    expect(retry?.hidden).toBe(true);
    expect(
      el().querySelector<HTMLElement>('[data-slot="withdraw"]')?.hidden,
    ).toBe(true);
    expect(webhooks(el())?.hidden).toBe(true);
  });

  it('shows the offline packages with the files, by audience level and language, with no address (#59)', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    const pkg = (id: string, audience: string, lang: string) =>
      output(id, {
        kind: 'offline-package',
        manual: null,
        variant: null,
        audience,
        lang,
      });
    const withPackages = handlers({
      outputs: () =>
        paged([
          pkg('p1', 'public', 'en'),
          pkg('p2', 'internal', 'de'),
          output('o1'),
        ]),
    }).map(([test, body]) =>
      test({ url: '/api/config' } as Req)
        ? ([
            test,
            () => ({
              data: {
                type: 'ProjectConfig',
                id: 'main',
                attributes: {
                  ...config(),
                  audiences: [
                    { id: 'public', label: 'Public' },
                    { id: 'internal', label: 'Internal' },
                  ],
                },
              },
            }),
          ] as const)
        : ([test, body] as const),
    );
    await answer(http, withPackages, settle);
    const groups = [...el().querySelectorAll('th[scope="colgroup"]')];
    expect(groups.map((g) => text(g.querySelector('span > span')))).toEqual([
      'Offline packages',
      'Operating',
    ]);
    const body = groups[0]?.closest('tbody');
    const rows = [...(body?.querySelectorAll('tr[data-state-file]') ?? [])];
    expect(rows.map((r) => text(r.querySelector('td')))).toEqual([
      'Public · English',
      'Internal · German',
    ]);
    // A package downloads like any file, and has no stable address (#450).
    expect(rows[0]?.querySelector('[data-slot="file-address"]')).toBeNull();
    const download = [...(rows[0]?.querySelectorAll('button') ?? [])].find(
      (b) => text(b).includes('Download'),
    );
    expect(download?.getAttribute('aria-label')).toBe(
      'Download Offline packages, Public · English',
    );
    expect(
      el().querySelector('[data-state-file] [data-slot="file-address"]'),
    ).not.toBeNull();
  });

  it('opens the notes on the summary in the interface language, and keeps a chosen one in the address (#794)', async () => {
    const { http, settle, el, url } = await render(
      `/releases/${RELEASE_ID}`,
      undefined,
      { german: true },
    );
    await TestBed.inject(LanguageService).choose('de');
    await answer(http, handlers(), settle);
    const notes = () => text(el().querySelector('[data-slot="notes"]'));
    const radio = (name: string) =>
      [...el().querySelectorAll<HTMLInputElement>('input[type="radio"]')].find(
        (r) => text(r.closest('label')) === name,
      );
    expect(notes()).toBe('Drehmomente korrigiert.');
    expect(radio('Deutsch')?.checked).toBe(true);
    expect(url()).not.toContain('notes=');

    // The summary, chosen: in the address, so a reload keeps it.
    radio('Zusammenfassung')?.click();
    await settle();
    expect(url()).toContain('notes=summary');
    expect(notes()).toBe('Torque values corrected.');
  });

  it('opens the notes on the summary when there is none in the interface language, or the address says so (#794)', async () => {
    const english = await render(`/releases/${RELEASE_ID}`);
    await answer(english.http, handlers(), english.settle);
    expect(text(english.el().querySelector('[data-slot="notes"]'))).toBe(
      'Torque values corrected.',
    );
    TestBed.resetTestingModule();

    const chosen = await render(
      `/releases/${RELEASE_ID}?notes=summary`,
      undefined,
      { german: true },
    );
    await TestBed.inject(LanguageService).choose('de');
    await answer(chosen.http, handlers(), chosen.settle);
    expect(text(chosen.el().querySelector('[data-slot="notes"]'))).toBe(
      'Torque values corrected.',
    );
  });

  it('opens a changed manual to its modules, each linking to the module at the release’s tag', async () => {
    const { http, settle, el, url } = await render(`/releases/${RELEASE_ID}`);
    await answer(http, handlers(), settle);
    const row = el().querySelector<HTMLButtonElement>(
      'of-release-changes button[aria-expanded]',
    );
    expect(row?.getAttribute('aria-expanded')).toBe('false');
    row?.click();
    await settle();
    await answer(http, handlers(), settle);
    expect(url()).toContain('change=en%2Foperating');
    expect(row?.getAttribute('aria-expanded')).toBe('true');
    const link = el().querySelector<HTMLAnchorElement>(
      'of-release-changes a[href*="/preview"]',
    );
    expect(link?.getAttribute('href')).toBe(
      '/preview?module=torque&lang=en&tag=release%2Fnorth%2F2.1',
    );
    // A removed module has nothing to open.
    expect(text(el().querySelector('of-release-changes'))).toContain(
      'old-step',
    );
    expect(
      el().querySelectorAll('of-release-changes a[href*="/preview"]'),
    ).toHaveLength(1);
  });

  it('retries a failed file for a publisher, showing it queued at once', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`, [
      'content.read',
      'release.publish',
      'webhook.manage',
    ]);
    await answer(http, handlers(), settle);
    expect(webhooks(el())?.hidden).toBe(false);
    const toast = vi.spyOn(TestBed.inject(ToastService), 'success');
    expect(
      el().querySelector<HTMLElement>('[data-slot="withdraw"]')?.hidden,
    ).toBe(false);
    const retry = [
      ...el().querySelectorAll<HTMLButtonElement>(
        '[data-state-file="failed"] button',
      ),
    ].find((b) => text(b).includes('Try again'));
    retry?.click();
    await settle();
    // Optimistic: queued before the answer.
    expect(el().querySelector('[data-state-file="failed"]')).toBeNull();
    const req = http.expectOne(`/api/releases/${RELEASE_ID}/outputs/o2/retry`);
    expect(req.request.method).toBe('POST');
    req.flush(
      {
        data: {
          type: 'ReleaseOutput',
          id: 'o2',
          attributes: { state: 'queued' },
        },
      },
      { status: 202, statusText: 'Accepted' },
    );
    await settle();
    expect(
      el().querySelectorAll('[data-state-file="queued"]').length,
    ).toBeGreaterThan(0);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'editor.releases.files.retried' }),
    );
  });

  it('reads where the files stand again while they render, and the page of files as they get further', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
      const releaseDoc = () => {
        reads++;
        return detail(
          release(),
          reads > 1
            ? progress('failed', 3, 2, 1)
            : progress('rendering', 3, 1, 1, 1),
        );
      };
      const outputs = () =>
        paged(
          reads > 1
            ? [
                output('o1'),
                output('o2', { lang: 'de', state: 'failed' }),
                output('o3', { manual: 'service' }),
              ]
            : files,
        );
      const routes = [
        [(r: Req) => r.url === `/api/releases/${RELEASE_ID}`, releaseDoc],
        ...handlers({ outputs }),
      ] as const;
      await answer(http, routes, settle);
      expect(text(el().querySelector('[data-slot="files-progress"]'))).toBe(
        '1 of 3 files ready · 1 failed',
      );
      expect(
        el().querySelector('[data-state-file="rendering"]'),
      ).not.toBeNull();
      const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(reads).toBe(2);
      expect(el().querySelector('[data-state-file="rendering"]')).toBeNull();
      expect(text(el().querySelector('[data-slot="files-progress"]'))).toBe(
        '1 file failed, 2 of 3 ready',
      );
      // It ended while the page was open: a toast says some failed.
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'editor.releases.files.toast.failed' }),
        expect.objectContaining({ actionLabel: expect.anything() }),
      );
      // Done: no more reads.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(http.match(() => true)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how many files of newer releases its own wait for, then no more once one of its own renders (#497)', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const waiting = {
        ...progress('rendering', 3),
        queue: { ahead: 1240, releases: 0 },
      };
      const releaseDoc = () => {
        reads++;
        return detail(
          release(),
          reads > 1 ? progress('rendering', 3, 1, 0, 1) : waiting,
        );
      };
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
      const routes = [
        [(r: Req) => r.url === `/api/releases/${RELEASE_ID}`, releaseDoc],
        ...handlers(),
      ] as const;
      await answer(http, routes, settle);
      // On the summary's own line: nothing below it moves.
      const line = el().querySelector('[data-slot="files-progress"] p');
      expect(text(line)).toBe(
        '0 of 3 files ready · Waiting for 1,240 files of newer releases',
      );
      expect(
        line?.querySelector('[data-slot="files-waiting"]')?.className,
      ).toContain('text-muted-foreground');
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(reads).toBe(2);
      expect(el().querySelector('[data-slot="files-waiting"]')).toBeNull();
      expect(text(el().querySelector('[data-slot="files-progress"] p'))).toBe(
        '1 of 3 files ready',
      );
      http.match(() => true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says how many earlier releases are prepared first while its own wait, in the line kept for the progress (#497, #527)', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const releaseDoc = () => {
        reads++;
        return detail(
          release(),
          reads > 1
            ? progress('rendering', 3)
            : {
                ...progress('planning'),
                queue: { ahead: 0, releases: 2 },
              },
        );
      };
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
      const routes = [
        [(r: Req) => r.url === `/api/releases/${RELEASE_ID}`, releaseDoc],
        ...handlers({ outputs: () => paged([]) }),
      ] as const;
      await answer(http, routes, settle);
      const waiting = el().querySelector('[data-slot="files-waiting"]');
      expect(text(waiting)).toBe(
        'Waiting for 2 earlier releases to be prepared first',
      );
      expect(waiting?.getAttribute('role')).toBe('status');
      expect(waiting?.className).toContain('min-h-5');
      // No progress line yet: the files are not planned.
      expect(el().querySelector('[data-slot="files-progress"]')).toBeNull();
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(reads).toBe(2);
      expect(el().querySelector('[data-slot="files-waiting"]')).toBeNull();
      expect(text(el().querySelector('[data-slot="files-progress"] p'))).toBe(
        '0 of 3 files ready',
      );
      http.match(() => true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a planning wait beside the files a release planned again has (#497)', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(
      http,
      handlers({
        release: detail(release(), {
          ...progress('planning', 3, 3),
          queue: { ahead: 0, releases: 1 },
        }),
      }),
      settle,
    );
    expect(text(el().querySelector('[data-slot="files-progress"] p'))).toBe(
      'Preparing the files… · Waiting for 1 earlier release to be prepared first',
    );
    http.match(() => true);
  });

  it('tells a planning that failed after some batches as such, never "0 files failed", and offers it again (#477)', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
      const releaseDoc = () => {
        reads++;
        return detail(
          release(),
          reads > 1
            ? progress('failed', 3, 3)
            : progress('rendering', 3, 2, 0, 1),
        );
      };
      const routes = [
        [(r: Req) => r.url === `/api/releases/${RELEASE_ID}`, releaseDoc],
        ...handlers({ outputs: () => paged(files) }),
      ] as const;
      await answer(http, routes, settle);
      const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(reads).toBe(2);
      expect(text(el().querySelector('[data-slot="files-progress"]'))).toBe(
        'The files could not be prepared.',
      );
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'editor.releases.progress.planFailed' }),
      );
      expect(toast).not.toHaveBeenCalledWith(
        expect.objectContaining({ key: 'editor.releases.files.toast.failed' }),
        expect.anything(),
      );
      expect(
        [...el().querySelectorAll('button')].some(
          (b) => text(b) === 'Plan the files again',
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows a fresh release’s files as being prepared, then rendering, then ready, without a reload', async () => {
    vi.useFakeTimers();
    try {
      let stage = 0;
      const stages = [
        progress('planning'),
        progress('rendering', 2, 1, 0, 1),
        progress('done', 2, 2),
      ];
      const rowsAt = [
        [],
        [output('o1'), output('o3', { manual: 'service', state: 'rendering' })],
        [output('o1'), output('o3', { manual: 'service' })],
      ];
      const routes = [
        [
          (r: Req) => r.url === `/api/releases/${RELEASE_ID}`,
          () => detail(release(), stages[stage] ?? null),
        ],
        [
          (r: Req) => r.url === `/api/releases/${RELEASE_ID}/outputs`,
          () => paged(rowsAt[stage] ?? []),
        ],
        ...handlers(),
      ] as const;
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
      await answer(http, routes, settle);
      const files = () => text(el().querySelector('of-release-files'));
      expect(files()).toContain('Preparing the files…');
      expect(files()).not.toContain('No files');
      // Said once, by the frame: no progress line above it yet.
      expect(el().querySelector('[data-slot="files-progress"]')).toBeNull();
      expect(files().match(/Preparing the files…/g)).toHaveLength(1);

      stage = 1;
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(text(el().querySelector('[data-slot="files-progress"]'))).toBe(
        '1 of 2 files ready',
      );
      expect(
        el().querySelector('[data-state-file="rendering"]'),
      ).not.toBeNull();
      expect(
        el().querySelector('[role="meter"]')?.getAttribute('aria-valuenow'),
      ).toBe('50');

      const toast = vi.spyOn(TestBed.inject(ToastService), 'success');
      stage = 2;
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(el().querySelector('[data-state-file="rendering"]')).toBeNull();
      expect(text(el().querySelector('[data-slot="files-progress"]'))).toBe(
        'All 2 files ready',
      );
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'editor.releases.files.toast.ready',
          params: { total: 2 },
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('says so when a release truly has no files, with why, and offers to plan them again', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`, [
      'content.read',
      'release.publish',
    ]);
    await answer(
      http,
      handlers({
        release: detail(release(), progress('done')),
        outputs: () => paged([]),
      }),
      settle,
    );
    const files = text(el().querySelector('of-release-files'));
    expect(files).toContain('No files');
    expect(files).toContain('there are no manuals at its tag');
    expect(files).not.toContain('Preparing');
    const plan = [...el().querySelectorAll('button')].find((b) =>
      text(b).includes('Plan the files again'),
    );
    expect(plan?.hidden).toBe(false);
  });

  it('says so when preparing the files failed', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(
      http,
      handlers({
        release: detail(release(), progress('failed')),
        outputs: () => paged([]),
      }),
      settle,
    );
    expect(text(el().querySelector('of-release-files'))).toContain(
      'The files could not be prepared',
    );
  });

  it('shows a retried file failed again when it fails at once, though the counts are as before', async () => {
    vi.useFakeTimers();
    try {
      const failedFiles = [
        output('o1'),
        output('o2', {
          lang: 'de',
          state: 'failed',
          error: { code: 'render-failed', detail: 'Font missing' },
        }),
      ];
      const routes = [
        [
          (r: Req) => r.url === `/api/releases/${RELEASE_ID}`,
          () => detail(release(), progress('failed', 2, 1, 1)),
        ],
        [
          (r: Req) => r.url === `/api/releases/${RELEASE_ID}/outputs`,
          () => paged(failedFiles),
        ],
        ...handlers(),
      ] as const;
      const { http, settle, el } = await render(`/releases/${RELEASE_ID}`, [
        'content.read',
        'release.publish',
      ]);
      await answer(http, routes, settle);
      [
        ...el().querySelectorAll<HTMLButtonElement>(
          '[data-state-file="failed"] button',
        ),
      ]
        .find((b) => text(b).includes('Try again'))
        ?.click();
      await settle();
      http.expectOne(`/api/releases/${RELEASE_ID}/outputs/o2/retry`).flush(
        {
          data: {
            type: 'ReleaseOutput',
            id: 'o2',
            attributes: { state: 'queued' },
          },
        },
        { status: 202, statusText: 'Accepted' },
      );
      await settle();
      expect(el().querySelector('[data-state-file="failed"]')).toBeNull();
      // It failed again before the next read: the same counts as before.
      await vi.advanceTimersByTimeAsync(5_100);
      await answer(http, routes, settle);
      expect(el().querySelector('[data-state-file="failed"]')).not.toBeNull();
      expect(el().querySelector('[data-state-file="queued"]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('downloads all ready files as one ZIP, saying how many are left out (#469)', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    // 1 of 3 ready: one failed, one rendering.
    await answer(http, handlers(), settle);
    const note = el().querySelector('[data-slot="archive-note"]');
    expect(text(note)).toBe(
      '2 of 3 files are not ready and are left out of the ZIP.',
    );
    const button = el().querySelector<HTMLButtonElement>(
      '[data-slot="archive-download"]',
    );
    expect(text(button)).toBe('Download all (ZIP)');
    expect(button?.getAttribute('aria-disabled')).not.toBe('true');
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:zip');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const saved: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      saved.push(this.download);
    });
    const toast = vi.spyOn(TestBed.inject(ToastService), 'success');
    button?.click();
    await settle();
    expect(button?.getAttribute('aria-busy')).toBe('true');
    const [req] = http.match(`/api/releases/${RELEASE_ID}/outputs/archive`);
    expect(req?.request.method).toBe('GET');
    req?.flush(new Blob(['PK']), {
      headers: {
        'Content-Disposition':
          'attachment; filename="north_2.1.zip"; filename*=UTF-8\'\'north_2.1.zip',
        'X-Ccms-Archive-Files': '1',
        'X-Ccms-Archive-Left-Out': '2',
      },
    });
    await settle();
    expect(saved).toEqual(['north_2.1.zip']);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'editor.releases.files.archive.savedPartly',
        params: { files: 1, leftOut: 2 },
      }),
    );
    expect(button?.getAttribute('aria-busy')).toBeNull();
  });

  it('says why the ZIP was refused, from the error the API sends, without Retry', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(http, handlers(), settle);
    const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
    el()
      .querySelector<HTMLButtonElement>('[data-slot="archive-download"]')
      ?.click();
    await settle();
    const [req] = http.match(`/api/releases/${RELEASE_ID}/outputs/archive`);
    req?.flush(
      new Blob(
        [
          JSON.stringify({
            errors: [
              {
                status: '422',
                code: 'release-archive-too-large',
                detail: 'Too large.',
                meta: { size: 3, limit: 2 },
              },
            ],
          }),
        ],
        { type: 'application/vnd.api+json' },
      ),
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await settle();
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, options] = toast.mock.calls[0] ?? [];
    expect(JSON.stringify(message)).toContain(
      'too large for one ZIP: download them one by one',
    );
    expect(options).toBeUndefined();
    // Done: the button can be used again.
    expect(
      el()
        .querySelector('[data-slot="archive-download"]')
        ?.getAttribute('aria-busy'),
    ).toBeNull();
  });

  it('cuts off a ZIP too large to save from the page at its first bytes', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(http, handlers(), settle);
    const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
    el()
      .querySelector<HTMLButtonElement>('[data-slot="archive-download"]')
      ?.click();
    await settle();
    const [req] = http.match(`/api/releases/${RELEASE_ID}/outputs/archive`);
    req?.event({
      type: HttpEventType.DownloadProgress,
      loaded: 64 * 1024,
      total: 2 * 1024 * 1024 * 1024,
    });
    await settle();
    expect(req?.cancelled).toBe(true);
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'editor.releases.files.archive.tooLarge',
      }),
    );
  });

  it('blocks Download all, with the reason, while no file is ready', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(
      http,
      handlers({ release: detail(release(), progress('planning')) }),
      settle,
    );
    const button = el().querySelector<HTMLButtonElement>(
      '[data-slot="archive-download"]',
    );
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-description')).toBe(
      'No file is ready yet.',
    );
    expect(text(el().querySelector('[data-slot="archive-note"]'))).toBe('');
    button?.click();
    await settle();
    expect(http.match(`/api/releases/${RELEASE_ID}/outputs/archive`)).toEqual(
      [],
    );
  });

  it('says so when there is no such release', async () => {
    const { http, settle, el } = await render(`/releases/${RELEASE_ID}`);
    await answer(
      http,
      [
        [
          (r: Req) => r.url === `/api/releases/${RELEASE_ID}`,
          () => [
            404,
            {
              errors: [
                { status: '404', code: 'not-found', title: 'Not found' },
              ],
            },
          ],
        ],
        ...handlers(),
      ],
      settle,
    );
    expect(text(el())).toContain('There is no such release');
  });

  it('treats an address that is no release ID as not found, without asking', async () => {
    const { http, settle, el } = await render('/releases/not-an-id');
    const seen = await answer(http, handlers(), settle);
    expect(seen.some((r) => r.url.startsWith('/api/releases/'))).toBe(false);
    expect(text(el())).toContain('There is no such release');
  });
});
