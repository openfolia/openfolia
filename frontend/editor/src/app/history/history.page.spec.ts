import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  type TestRequest,
} from '@angular/common/http/testing';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ModuleDiffBodyComponent } from '../review/module-diff-body.component';
import { ChangeSetSession } from '../session/change-set-session';
import { provideChangeSetUrl } from '../session/change-set-url';
import { HistoryPage } from './history.page';
import { advance } from '../testing/fake-time';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const REV1 = '1'.repeat(40);
const REV2 = '2'.repeat(40);
const REV3 = '3'.repeat(40);
const WC = `/api/change-sets/${CS}/modules/en/charging/working-copy`;

const config = {
  languages: { source: 'en', targets: [] },
  moduleTypes: [
    { id: 'procedure', label: 'Procedure', restricted: false, snippet: false },
  ],
  audiences: [],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const text = (t: string) => [{ type: 'text', text: t }];
const p = (id: string, t: string) => ({
  type: 'paragraph',
  id,
  content: text(t),
});

const attributes = (blocks: unknown[], title = 'Charging') => ({
  moduleId: 'charging',
  lang: 'en',
  schemaVersion: 1,
  title,
  moduleType: 'procedure',
  facets: {},
  blocks,
});

const AT: Record<string, ReturnType<typeof attributes>> = {
  [REV1]: attributes([p('intro', 'It charges.')]),
  [REV2]: attributes([p('intro', 'It charges slowly.')]),
  [REV3]: attributes([
    p('intro', 'It charges slowly.'),
    p('fast', 'It also fast-charges.'),
  ]),
};

const version = (
  commit: string,
  revision: number,
  extra: {
    change?: 'added' | 'changed' | 'removed';
    releases?: { tag: string; commit: string }[];
    changeSet?: string;
  } = {},
) => ({
  type: 'ModuleVersion',
  id: `en/charging/${commit}`,
  attributes: {
    commit,
    committedAt: `2026-11-1${revision}T10:00:00Z`,
    message: `Change ${revision}`,
    merge: true,
    actor: { kind: 'user', id: 'author' },
    approvedBy: [{ kind: 'user', id: 'reviewer' }],
  },
  relationships: {
    actor: { data: { type: 'User', id: 'author' } },
    changeSet: {
      data: extra.changeSet ? { type: 'ChangeSet', id: extra.changeSet } : null,
    },
    approvers: { data: [{ type: 'User', id: 'reviewer' }] },
  },
  meta: {
    revision,
    change: extra.change ?? 'changed',
    releases: extra.releases ?? [],
    unreadable: false,
  },
});

const HISTORY = {
  data: [
    version(REV3, 3, { changeSet: CS }),
    version(REV2, 2, { releases: [{ tag: 'v1.0', commit: REV2 }] }),
    version(REV1, 1, { change: 'added' }),
  ],
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 20, total: 3 },
    truncated: false,
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
};

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 20, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const changeSet = (author = 'author') => ({
  type: 'ChangeSet',
  id: CS,
  attributes: {
    title: 'Trial',
    description: null,
    state: 'draft',
    branch: BRANCH,
    author: { kind: 'user', id: author },
    baseCommit: REV3,
    createdAt: '2026-11-18T10:00:00Z',
    updatedAt: '2026-11-18T10:00:00Z',
  },
});

const comparison = (base: string, head: string) => ({
  data: {
    type: 'ModuleComparison',
    id: `en/charging/${base}..${head}`,
    attributes: { base: AT[base], head: AT[head] },
    meta: {
      base,
      head,
      change: 'changed',
      fields: [],
      blocks: [],
      unreadable: false,
    },
  },
});

const copyDoc = (version: number, saved: boolean, blocks: unknown[]) => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/module/en/charging`,
    attributes: {
      subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      content: {
        schemaVersion: 1,
        id: 'charging',
        meta: { title: 'Charging', type: 'procedure', lang: 'en', facets: {} },
        blocks,
      },
      version,
      baseCommit: REV3,
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved, issues: [] },
  },
});

interface Options {
  readonly url?: string;
  readonly edit?: boolean;
  /** A contributor: `content.edit` without `content.read.draft` (#137). */
  readonly contributor?: boolean;
  /** The chosen change set (a draft of the person's); none: the published content. */
  readonly changeSet?: boolean;
  /** A lock on the module, held by this change set. */
  readonly lockedBy?: string;
  /** Versions on a page of the history (default 20, all three on one). */
  readonly perPage?: number;
}

/** The history's page as the API answers it. */
function historyPage(number: number, size: number) {
  const all = HISTORY.data;
  const lastPage = Math.max(1, Math.ceil(all.length / size));
  return {
    ...HISTORY,
    data: all.slice((number - 1) * size, number * size),
    meta: {
      ...HISTORY.meta,
      page: { currentPage: number, lastPage, perPage: size, total: all.length },
    },
  };
}

async function render(options: Options = {}) {
  localStorage.clear();
  sessionStorage.clear();
  if (options.changeSet) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: CS, title: 'Trial', branch: BRANCH }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'content/:lang/:moduleId/history',
          component: HistoryPage,
          data: { changeSetParam: 'session' },
        },
        {
          path: 'content/:lang/:moduleId',
          children: [],
          data: { changeSetParam: 'session' },
        },
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
      options.contributor
        ? ['content.read', 'content.edit']
        : options.edit === false
          ? ['content.read', 'content.read.draft']
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
      'modules/en/charging/history',
      'modules/en/charging/compare',
      'modules/en/charging',
      'locks',
      'manuals',
      'modules/en/charging/preview',
      `change-sets/${CS}`,
    ].map((u) => `/api/${u}`),
  );
  const known = (r: { method: string; url: string }) =>
    r.method === 'GET' && KNOWN.has(r.url);
  /** Answers what the page asks for, as the API would. */
  const answer = (r: TestRequest): void => {
    const url = r.request.url;
    const params = r.request.params;
    log.push(`${r.request.method} ${r.request.urlWithParams}`);
    if (url === '/api/config') {
      r.flush({ data: { type: 'Config', id: 'config', attributes: config } });
    } else if (url === '/api/change-sets') {
      r.flush(page(options.changeSet ? [changeSet()] : []));
    } else if (url === '/api/demo/users') {
      r.flush(page([]));
    } else if (url === '/api/modules/en/charging/history') {
      const size = Number(params.get('page[size]') ?? 20);
      r.flush(
        historyPage(
          Number(params.get('page[number]') ?? 1),
          size === 20 ? (options.perPage ?? 20) : size,
        ),
      );
    } else if (url === '/api/modules/en/charging/compare') {
      r.flush(comparison(params.get('base')!, params.get('head')!));
    } else if (url === '/api/modules/en/charging') {
      const at = AT[params.get('ref') ?? REV3];
      r.flush({
        data: {
          type: 'Module',
          id: 'en/charging',
          attributes: at,
          meta: { issues: [], status: { changeSets: [] } },
        },
      });
    } else if (url === '/api/modules/en/charging/preview') {
      r.flush('<!doctype html><p id="fast">It also fast-charges.</p>');
    } else if (url === '/api/manuals') {
      r.flush(page([]));
    } else if (url === `/api/change-sets/${CS}`) {
      r.flush({ data: changeSet() });
    } else if (url === '/api/locks') {
      r.flush(
        page(
          options.lockedBy
            ? [
                {
                  type: 'Lock',
                  id: 'l1',
                  attributes: {
                    subject: {
                      type: 'module',
                      lang: 'en',
                      moduleId: 'charging',
                    },
                    holder: { kind: 'user', id: 'someone' },
                    since: '2026-11-18T10:00:00Z',
                  },
                  relationships: {
                    changeSet: {
                      data: { type: 'ChangeSet', id: options.lockedBy },
                    },
                  },
                },
              ]
            : [],
        ),
      );
    }
  };
  const settle = async () => {
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(0);
      http.match(known).forEach(answer);
      await advance();
    }
  };
  // The shell's change-set control reads the person's change sets.
  void TestBed.inject(ChangeSetSession).refresh();
  void harness.navigateByUrl(options.url ?? '/content/en/charging/history');
  await settle();
  const el = () => harness.routeNativeElement as HTMLElement;
  return { harness, http, settle, el, log };
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-slot="history-row"]')].map((r) =>
    (r.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );

describe('HistoryPage', () => {
  afterEach(() => {
    try {
      TestBed.inject(HttpTestingController).verify();
    } finally {
      TestBed.resetTestingModule();
    }
  });

  it('lists the versions and compares the newest with the one before', async () => {
    const { el, log } = await render();
    const list = rows(el());
    expect(list).toHaveLength(3);
    expect(list[0]).toContain('v3');
    expect(list[0]).toContain('Revision');
    expect(list[0]).toContain('Approved by reviewer');
    expect(list[1]).toContain('Released · v1.0');
    expect(list[2]).toContain('Added');
    // The newest is shown, compared with v2; screen readers hear "version 3".
    const current = el().querySelector(
      '[data-slot="history-version"][aria-current]',
    );
    expect(current?.textContent).toContain('v3');
    expect(current?.getAttribute('aria-label')).toBe('version 3');
    // Running text names a version in full.
    expect(
      el().querySelector('[data-slot="history-compare"]')?.textContent,
    ).toContain('Compare with version 1');
    expect(log).toContain(
      `GET /api/modules/en/charging/compare?base=${REV2}&head=${REV3}`,
    );
    expect(el().querySelector('h2')?.textContent).toContain('v2 → v3');
    // The review screen's diff draws it: the paragraph v3 added.
    const body = el().querySelector('of-module-diff-body');
    expect(body).not.toBeNull();
    expect(body?.textContent).toContain('It also fast-charges.');
    // A change set's version links to its review.
    const link = el().querySelector<HTMLAnchorElement>(
      '[data-slot="history-change-set"]',
    );
    expect(link?.getAttribute('href')).toBe(`/review?cs=${CS}`);
  });

  it('compares v1 and v3 in all three views, with the same component as review', async () => {
    const { el, log, harness, settle } = await render({
      url: `/content/en/charging/history?version=${REV3}&base=${REV1}`,
    });
    expect(log).toContain(
      `GET /api/modules/en/charging/compare?base=${REV1}&head=${REV3}`,
    );
    const body = () =>
      harness.fixture.debugElement.query(
        (d) => d.componentInstance instanceof ModuleDiffBodyComponent,
      );
    // Inline: the words v1 → v3 changed, one column.
    expect(body()).not.toBeNull();
    expect(el().querySelector('of-diff-nodes')).not.toBeNull();
    expect(el().textContent).toContain('slowly');

    await TestBed.inject(Router).navigateByUrl(
      `/content/en/charging/history?version=${REV3}&base=${REV1}&diff=side-by-side`,
    );
    await settle();
    expect(body()).not.toBeNull();
    expect(el().querySelector('h2')?.textContent).toContain('v1 → v3');
    expect(
      el().querySelectorAll('of-diff-nodes').length,
    ).toBeGreaterThanOrEqual(1);
    expect((body()!.componentInstance as ModuleDiffBodyComponent).view()).toBe(
      'side',
    );

    await TestBed.inject(Router).navigateByUrl(
      `/content/en/charging/history?version=${REV3}&base=${REV1}&diff=rendered`,
    );
    await settle();
    expect((body()!.componentInstance as ModuleDiffBodyComponent).view()).toBe(
      'rendered',
    );
    expect(el().querySelector('of-diff-rendered')).not.toBeNull();
    // Comments are not shown in the history.
    expect(el().querySelector('of-diff-comments')).toBeNull();
  });

  it('chooses the version compared against by keyboard: a link on the other rows', async () => {
    const { el, settle, log } = await render();
    const compare = [
      ...el().querySelectorAll<HTMLAnchorElement>(
        '[data-slot="history-compare"]',
      ),
    ];
    // Not on the version shown, nor on v2, which it is compared with already.
    expect(compare).toHaveLength(1);
    expect(rows(el())[1]).toContain('Compared');
    // A link: Enter follows it, as a click does.
    compare[0]!.focus();
    expect(document.activeElement).toBe(compare[0]);
    compare[0]!.click();
    await settle();
    expect(log).toContain(
      `GET /api/modules/en/charging/compare?base=${REV1}&head=${REV3}`,
    );
    expect(TestBed.inject(Router).url).toContain(`base=${REV1}`);
    expect(rows(el())[2]).toContain('Compared');
  });

  it('shows the newest version for a commit that is no version of the module', async () => {
    const { el, log } = await render({
      url: `/content/en/charging/history?version=${'9'.repeat(40)}`,
    });
    expect(TestBed.inject(Router).url).toBe('/content/en/charging/history');
    expect(log).toContain(
      `GET /api/modules/en/charging/compare?base=${REV2}&head=${REV3}`,
    );
    expect(log.some((l) => l.includes('9'.repeat(40)))).toBe(false);
    expect(el().querySelector('h2')?.textContent).toContain('v2 → v3');
  });

  it('keeps the version shown while another page of the history is open', async () => {
    const { harness, settle, el } = await render({
      perPage: 2,
      url: `/content/en/charging/history?version=${REV2}&base=${REV3}`,
    });
    expect(el().querySelector('h2')?.textContent).toContain('v3 → v2');
    await harness.navigateByUrl(
      `/content/en/charging/history?version=${REV2}&base=${REV3}&page=2`,
    );
    await settle();
    expect(rows(el())).toHaveLength(1);
    expect(TestBed.inject(Router).url).toContain(`version=${REV2}`);
    expect(TestBed.inject(Router).url).toContain(`base=${REV3}`);
    expect(el().querySelector('h2')?.textContent).toContain('v3 → v2');
  });

  it('shows the oldest version on its own, all of it added', async () => {
    const { el, log } = await render({
      url: `/content/en/charging/history?version=${REV1}`,
    });
    expect(log).toContain(`GET /api/modules/en/charging?ref=${REV1}`);
    expect(log.some((l) => l.includes('/compare'))).toBe(false);
    expect(el().querySelector('of-module-diff-body')?.textContent).toContain(
      'It charges.',
    );
  });

  it('never offers Restore to a reader without content.edit', async () => {
    const { el } = await render({ edit: false });
    expect(rows(el())).toHaveLength(3);
    expect(el().querySelector('of-module-diff-body')).not.toBeNull();
    const restore = el().querySelector('[data-slot="history-restore"]');
    expect(restore === null || restore.hasAttribute('hidden')).toBe(true);
  });

  it('shows a contributor the history read-only: no Restore', async () => {
    const { el } = await render({
      contributor: true,
      url: `/content/en/charging/history?version=${REV2}`,
    });
    expect(rows(el())).toHaveLength(3);
    expect(el().querySelector('of-module-diff-body')).not.toBeNull();
    expect(el().querySelector('[data-slot="history-restore"]')).toBeNull();
  });

  it('blocks Restore of the current version and while another change set holds the lock', async () => {
    const current = await render({ changeSet: true });
    const button = () =>
      current.el().querySelector('[data-slot="history-restore"]');
    expect(button()?.getAttribute('aria-disabled')).toBe('true');
    TestBed.resetTestingModule();

    const locked = await render({
      changeSet: true,
      lockedBy: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a50',
      url: `/content/en/charging/history?version=${REV2}`,
    });
    expect(
      locked
        .el()
        .querySelector('[data-slot="history-restore"]')
        ?.getAttribute('aria-disabled'),
    ).toBe('true');
  });

  it('knows the current version on another page of the history too', async () => {
    const { harness, settle, el } = await render({
      changeSet: true,
      perPage: 2,
      url: `/content/en/charging/history?version=${REV3}`,
    });
    await harness.navigateByUrl(
      `/content/en/charging/history?version=${REV3}&page=2`,
    );
    await settle();
    expect(TestBed.inject(Router).url).toContain(`version=${REV3}`);
    const restore = el().querySelector('[data-slot="history-restore"]');
    expect(restore?.getAttribute('aria-disabled')).toBe('true');
  });

  it('restores a version into the open change set and opens the editor; Undo puts back what was there', async () => {
    const { el, http, settle, log } = await render({
      changeSet: true,
      url: `/content/en/charging/history?version=${REV2}`,
    });
    const restore = el().querySelector<HTMLButtonElement>(
      '[data-slot="history-restore"]',
    )!;
    expect(restore.textContent).toContain('Restore version 2 as draft');
    expect(restore.getAttribute('aria-disabled')).not.toBe('true');
    restore.click();
    await settle();
    expect(log).toContain(`GET /api/modules/en/charging?ref=${REV2}`);
    expect(log).toContain(`GET /api/change-sets/${CS}`);
    // …then the lock, the working copy as it is, and the old version saved into it.
    const lock = http.expectOne(`/api/change-sets/${CS}/locks`);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'module',
      lang: 'en',
      moduleId: 'charging',
    });
    lock.flush({}, { status: 201, statusText: 'Created' });
    await settle();
    http.expectOne(WC).flush(copyDoc(0, false, AT[REV3]!.blocks));
    await settle();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === WC);
    expect(put.request.body.data.attributes.content.blocks).toEqual(
      AT[REV2]!.blocks,
    );
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: REV3 });
    put.flush(copyDoc(1, true, AT[REV2]!.blocks));
    await settle();
    expect(TestBed.inject(Router).url).toBe(`/content/en/charging?cs=${CS}`);
    const toasts = TestBed.inject(ToastService);
    const toast = toasts.toasts().at(-1)!;
    expect(toast.message).toMatchObject({
      key: 'editor.history.restore.done',
      params: { revision: 'version 2' },
    });

    // Undo: the working copy is still the restored one, so the committed file goes back over
    // exactly that version (a DELETE could discard a save made in the meantime).
    toasts.runAction(toast.id);
    await settle();
    http
      .expectOne((r) => r.method === 'GET' && r.url === WC)
      .flush(copyDoc(1, true, AT[REV2]!.blocks));
    await settle();
    const back = http.expectOne((r) => r.method === 'PUT' && r.url === WC);
    expect(back.request.body.data.attributes.content.blocks).toEqual(
      AT[REV3]!.blocks,
    );
    expect(back.request.body.meta).toEqual({ version: 1, baseCommit: REV3 });
    back.flush(copyDoc(2, true, AT[REV3]!.blocks));
    await settle();
    expect(toasts.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.history.restore.undone',
    });
  });
});
