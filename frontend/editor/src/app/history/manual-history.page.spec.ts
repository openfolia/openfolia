import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from '../session/change-set-session';
import { provideChangeSetUrl } from '../session/change-set-url';
import { HistoryPage } from './history.page';
import { advance } from '../testing/fake-time';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const REV1 = 'a'.repeat(40);
const REV2 = 'b'.repeat(40);
/** The released commits holding them, for a reader of released content only (#410). */
const REL1 = 'c'.repeat(40);
const REL2 = 'd'.repeat(40);
const WC = `/api/change-sets/${CS}/manuals/guide/working-copy`;

const config = {
  languages: { source: 'en', targets: [] },
  moduleTypes: [],
  audiences: [],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const manual = (title: string, ...modules: string[]) => ({
  schemaVersion: 1,
  title,
  variants: [{ model: 'l' }],
  textAttributes: {},
  entries: modules.map((module) => ({ module })),
});

const AT: Record<string, ReturnType<typeof manual>> = {
  [REV1]: manual('Guide', 'intro'),
  [REV2]: manual('Guide, longer', 'intro', 'safety'),
  [REL1]: manual('Guide', 'intro'),
  [REL2]: manual('Guide, longer', 'intro', 'safety'),
};

const version = (
  commit: string,
  revision: number,
  change: string,
  readAt = commit,
) => ({
  type: 'ManualVersion',
  id: `guide/${commit}`,
  attributes: {
    commit,
    committedAt: `2026-11-1${revision}T10:00:00Z`,
    message: `Change ${revision}`,
    merge: true,
    actor: { kind: 'user', id: 'author' },
    approvedBy: [],
  },
  relationships: {
    actor: { data: { type: 'User', id: 'author' } },
    changeSet: { data: null },
    approvers: { data: [] },
  },
  meta: { revision, change, releases: [], unreadable: false, readAt },
});

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 20, total: data.length },
    truncated: false,
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const changeSet = () => ({
  type: 'ChangeSet',
  id: CS,
  attributes: {
    title: 'Trial',
    description: null,
    state: 'draft',
    branch: BRANCH,
    author: { kind: 'user', id: 'author' },
    baseCommit: REV2,
    createdAt: '2026-11-18T10:00:00Z',
    updatedAt: '2026-11-18T10:00:00Z',
  },
});

const copyDoc = (version: number, entries: unknown[]) => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/manual/guide`,
    attributes: {
      subject: { type: 'manual', manualId: 'guide' },
      content: {
        schemaVersion: 1,
        id: 'guide',
        title: 'Guide, longer',
        variants: [{ model: 'l' }],
        attributes: {},
        entries,
      },
      version,
      baseCommit: REV2,
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved: version > 0, issues: [] },
  },
});

interface Options {
  /** The old version names a module outside the reader's scope (`outside-scope`). */
  readonly hidden?: boolean;
  /** A reader of released content only (#410): no `content.read.draft`, versions read at releases. */
  readonly releasedOnly?: boolean;
}

async function render(url: string, options: Options = {}) {
  localStorage.clear();
  sessionStorage.clear();
  localStorage.setItem(
    'openfolia.change-set',
    JSON.stringify({ id: CS, title: 'Trial', branch: BRANCH }),
  );
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'manuals/:manualId/history',
          component: HistoryPage,
          data: { changeSetParam: 'session' },
        },
        { path: 'manuals', children: [], data: { changeSetParam: 'session' } },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(
      options.releasedOnly
        ? ['content.read']
        : ['content.read', 'content.read.draft', 'content.edit'],
    ),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  // Fake time: the page's timers are waited out on the fake clock. The fake clock runs every timer
  // due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const http = TestBed.inject(HttpTestingController);
  const log: string[] = [];
  const KNOWN = new Set(
    [
      'config',
      'change-sets',
      'demo/users',
      'manuals/guide/history',
      'manuals/guide/compare',
      'manuals/guide',
      'locks',
      'manuals',
      `change-sets/${CS}`,
    ].map((u) => `/api/${u}`),
  );
  const known = (r: { method: string; url: string }) =>
    r.method === 'GET' &&
    (KNOWN.has(r.url) || r.url.startsWith('/api/modules/en/'));
  const answer = (r: TestRequest): void => {
    const u = r.request.url;
    const params = r.request.params;
    log.push(`${r.request.method} ${r.request.urlWithParams}`);
    if (u === '/api/config') {
      r.flush({ data: { type: 'Config', id: 'config', attributes: config } });
    } else if (u === '/api/change-sets') {
      r.flush(page([changeSet()]));
    } else if (u === `/api/change-sets/${CS}`) {
      r.flush({ data: changeSet() });
    } else if (u === '/api/manuals/guide/history') {
      r.flush(
        page(
          options.releasedOnly
            ? [
                version(REV2, 2, 'changed', REL2),
                version(REV1, 1, 'added', REL1),
              ]
            : [version(REV2, 2, 'changed'), version(REV1, 1, 'added')],
        ),
      );
    } else if (u === '/api/manuals/guide/compare') {
      const base = params.get('base')!;
      const head = params.get('head')!;
      r.flush({
        data: {
          type: 'ManualComparison',
          id: `guide/${base}..${head}`,
          attributes: { base: AT[base], head: AT[head] },
          meta: {
            base,
            head,
            change: 'changed',
            fields: ['title', 'entries'],
            unreadable: false,
          },
        },
      });
    } else if (u === '/api/manuals/guide') {
      const ref = params.get('ref') ?? REV2;
      r.flush({
        data: {
          type: 'Manual',
          id: 'guide',
          attributes: AT[ref],
          meta: {
            variants: [],
            issues:
              options.hidden && ref === REV1
                ? [
                    {
                      severity: 'warning',
                      code: 'outside-scope',
                      message: 'Outside your scope',
                    },
                  ]
                : [],
          },
        },
      });
    } else if (u.startsWith('/api/modules/en/')) {
      const id = u.slice('/api/modules/en/'.length);
      r.flush({
        data: {
          type: 'Module',
          id: `en/${id}`,
          attributes: { moduleId: id, lang: 'en', title: `Module ${id}` },
          meta: { issues: [] },
        },
      });
    } else {
      r.flush(page([]));
    }
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(0);
      http.match(known).forEach(answer);
      await advance();
    }
  };
  void TestBed.inject(ChangeSetSession).refresh();
  void harness.navigateByUrl(url);
  await settle();
  const el = () => harness.routeNativeElement as HTMLElement;
  return { harness, http, settle, el, log };
}

describe('HistoryPage, a manual’s (#321)', () => {
  afterEach(() => {
    try {
      TestBed.inject(HttpTestingController).verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('lists the manual’s versions and compares them with the review screen’s manual diff', async () => {
    const { el, log } = await render(`/manuals/guide/history?cs=${CS}`);
    const rows = el().querySelectorAll('[data-slot="history-row"]');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('v2');
    expect(log).toContain(
      `GET /api/manuals/guide/compare?base=${REV1}&head=${REV2}`,
    );
    const body = el().querySelector('of-manual-diff-body');
    expect(body?.textContent).toContain(', longer');
    expect(body?.textContent).toContain('Module safety');
    // A reader of drafts is listed every version: no note.
    expect(
      el().querySelector('[data-slot="history-released-only"]'),
    ).toBeNull();
    // No view switch: a manual has only its details and outline.
    expect(el().querySelector('of-segmented')).toBeNull();
    // The title leads back to the builder on the manual.
    const back = el().querySelector<HTMLAnchorElement>(
      '[data-slot="history-module"]',
    );
    expect(back?.getAttribute('href')).toBe(`/manuals?cs=${CS}&manual=guide`);
    expect(
      log.some(
        (l) =>
          l.startsWith('GET /api/locks') &&
          decodeURIComponent(l).includes('filter[subject]=manual/guide'),
      ),
    ).toBe(true);
  });

  it('restores an older version into the open change set as the manual’s working copy', async () => {
    const { el, http, settle } = await render(
      `/manuals/guide/history?cs=${CS}&version=${REV1}`,
    );
    el()
      .querySelector<HTMLButtonElement>('[data-slot="history-restore"]')!
      .click();
    await settle();
    const lock = http.expectOne(`/api/change-sets/${CS}/locks`);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'manual',
      manualId: 'guide',
    });
    lock.flush({}, { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne(WC).flush(copyDoc(0, AT[REV2]!.entries));
    await settle();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === WC);
    expect(put.request.body.data.attributes.content).toMatchObject({
      id: 'guide',
      title: 'Guide',
      entries: [{ module: 'intro' }],
    });
    put.flush(copyDoc(1, AT[REV1]!.entries));
    await settle();
    expect(TestBed.inject(Router).url).toBe(`/manuals?manual=guide&cs=${CS}`);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toMatchObject(
      { key: 'editor.history.restore.done' },
    );
  });

  it('refuses to restore a version naming modules hidden from the person', async () => {
    const { el, http, settle } = await render(
      `/manuals/guide/history?cs=${CS}&version=${REV1}`,
      { hidden: true },
    );
    el()
      .querySelector<HTMLButtonElement>('[data-slot="history-restore"]')!
      .click();
    await settle();
    http.expectNone(`/api/change-sets/${CS}/locks`);
    expect(TestBed.inject(ToastService).toasts().at(-1)?.message).toMatchObject(
      { key: 'editor.history.restore.hiddenEntries' },
    );
  });

  it('reads each version at its released commit for a reader of released content only, and says only released versions are listed (#410)', async () => {
    const { el, log } = await render('/manuals/guide/history', {
      releasedOnly: true,
    });
    expect(
      el().querySelector('[data-slot="history-released-only"]')?.textContent,
    ).toContain('Only released versions are listed');
    expect(log).toContain(
      `GET /api/manuals/guide/compare?base=${REL1}&head=${REL2}`,
    );
    expect(log.filter((l) => l.includes(REV1) || l.includes(REV2))).toEqual([]);
    expect(el().querySelector('of-manual-diff-body')?.textContent).toContain(
      ', longer',
    );
    // Without content.edit: no Restore.
    expect(
      el().querySelector<HTMLButtonElement>('[data-slot="history-restore"]')
        ?.hidden ?? true,
    ).toBe(true);
  });
});
