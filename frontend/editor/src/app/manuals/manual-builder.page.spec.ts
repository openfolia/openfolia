import { provideHttpClient, type HttpRequest } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { provideChangeSetUrl } from '../session/change-set-url';
import { ManualBuilderPage } from './manual-builder.page';
import { NewManualRequest } from './new-manual-request';
import { advance } from '../testing/fake-time';

const CS = '0190a0b0-0000-7000-8000-000000000001';
const links = { self: '', first: '', last: '', prev: null, next: null };
const paged = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: data.length },
  },
  links,
});

const ENTRIES = [
  { module: 'intro' },
  { title: 'Operation', entries: [{ module: 'charging' }] },
];

const manualDoc = {
  data: {
    type: 'Manual',
    id: 'guide',
    attributes: {
      schemaVersion: 1,
      title: 'Guide',
      variants: [{ model: 'l' }],
      textAttributes: {},
      entries: ENTRIES,
    },
    meta: {
      variants: [{ slug: 'model=l', label: 'L', values: { model: 'l' } }],
      issues: [],
    },
  },
};

const summary = (id: string, title: string, languages: string[]) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    moduleId: id,
    title,
    titleLang: 'en',
    moduleType: 'concept',
    facets: {},
    keywords: [],
    languages,
    variants: [],
  },
  meta: { changed: false },
});

async function render(url: string, changeSet = false) {
  if (changeSet) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({
        id: CS,
        title: 'Edits',
        branch: `change-sets/${CS}`,
        owner: 'author',
      }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: '**',
          component: ManualBuilderPage,
          data: { changeSetParam: 'session' },
        },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'author',
    role: '',
    permissions: new Set([
      'content.read',
      'content.read.draft',
      'content.edit',
    ]),
  });
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  // Fake time: the menus' and the add list's timers are waited out on the fake clock. The fake
  // clock runs every timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(ManualBuilderPage);
  const el = fixture.nativeElement as HTMLElement;
  document.body.appendChild(el);
  const outlineReads: HttpRequest<unknown>[] = [];
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      await advance();
      answerOutline(http, outlineReads);
    }
  };
  await settle();
  const answer = (url: string, body: object) =>
    http.expectOne((r) => r.url === url).flush(body);
  const rows = () =>
    Array.from(el.querySelectorAll<HTMLElement>('[role=treeitem]'));
  return { fixture, http, el, settle, router, answer, rows, outlineReads };
}

/** The modules the branch has, as the outline's reads by ID find them. */
const SUMMARIES = [
  summary('intro', 'Introduction', ['en', 'de']),
  summary('charging', 'Charging', ['en']),
  summary('safety', 'Safety', ['en']),
];

/**
 * Answers the outline's reads of summaries by ID (`filter[id]`, #481) from `SUMMARIES`, and
 * keeps them in `seen`; a list read whole would wait unanswered (and fail `verify`).
 */
function answerOutline(
  http: HttpTestingController,
  seen: HttpRequest<unknown>[],
) {
  for (const req of http.match(
    (r) => r.url === '/api/module-summaries' && r.params.has('filter[id]'),
  )) {
    seen.push(req.request);
    const ids = new Set(req.request.params.get('filter[id]')?.split(','));
    req.flush(paged(SUMMARIES.filter((s) => ids.has(s.id))));
  }
}

/** Opens a header control's menu or popover (they render in the overlay, on the body). */
async function openMenu(t: Harness, testId: string) {
  t.el.querySelector<HTMLElement>(`[data-testid=${testId}]`)?.click();
  await t.settle();
}

/** An entry of an open menu or list, by its test ID (in the overlay). */
const entry = (testId: string) =>
  document.querySelector<HTMLElement>(`[data-testid=${testId}]`);

/** Starts renaming the manual from the header's menu (the field opens once the menu closed). */
async function startRename(t: Harness) {
  await openMenu(t, 'manual-menu');
  entry('manual-rename')?.click();
  await vi.advanceTimersByTimeAsync(80);
  await t.settle();
}

const CONFIG = {
  languages: { source: 'en', targets: ['de'] },
  audiences: [
    { id: 'public', label: 'Public' },
    { id: 'internal', label: 'Internal' },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'l', label: 'L' },
        { id: 'xl', label: 'XL' },
      ],
    },
  ],
  textAttributes: [{ id: 'product', label: 'Product name' }],
  moduleTypes: [{ id: 'concept', label: 'Concept' }],
  facets: [],
};

type Harness = Awaited<ReturnType<typeof render>>;

const MANUALS = [
  { type: 'Manual', id: 'alpha', attributes: { title: 'Alpha' } },
  { type: 'Manual', id: 'guide', attributes: { title: 'Guide' } },
];

/** What the change set did to manuals (its changes) and the manual locks it holds. */
interface ChangeSetLists {
  readonly changes?: readonly { id: string; change: string }[];
  readonly locks?: readonly string[];
}

/** Answers the lists every load reads; in a change set (`cs`), its changes and locks too. */
async function lists(
  t: Harness,
  cs?: ChangeSetLists,
  manuals: readonly object[] = MANUALS,
) {
  t.answer('/api/manuals', paged([...manuals]));
  t.answer('/api/config', { data: { attributes: CONFIG } });
  await t.settle();
  if (cs) await changeSetLists(t, cs);
  await t.settle();
}

async function changeSetLists(t: Harness, cs: ChangeSetLists) {
  t.http
    .expectOne((r) => r.url === `/api/change-sets/${CS}/changes`)
    .flush({
      ...paged(
        (cs.changes ?? []).map((c) => ({
          type: 'ChangeSetChange',
          id: `manual/${c.id}`,
          attributes: { subject: { type: 'manual', manualId: c.id } },
          meta: { change: c.change, fields: [], blocks: [], unreadable: false },
        })),
      ),
      meta: {
        page: { currentPage: 1, lastPage: 1, perPage: 200, total: 0 },
        base: 'b0',
        head: 'h0',
      },
    });
  t.http
    .expectOne(
      (r) => r.url === '/api/locks' && r.params.get('filter[changeSet]') === CS,
    )
    .flush(
      paged(
        (cs.locks ?? []).map((id) => ({
          type: 'Lock',
          id: `lock-${id}`,
          attributes: { subject: { type: 'manual', manualId: id } },
          relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
        })),
      ),
    );
  await t.settle();
}

const HEADER = {
  schemaVersion: 1,
  id: 'guide',
  title: 'Guide',
  variants: [{ model: 'l' }],
  attributes: {},
};

/** A derived manual (#451): its rule, and the entries the API gathered from its source. */
const RULE = {
  source: 'alpha',
  exclude: [],
  front: ['intro'],
  back: [],
};
const GATHERED = [{ module: 'intro' }, { module: 'safety' }];
const DERIVED_HEADER = { ...HEADER, kind: 'derived', rule: RULE };
const derivedDoc = {
  data: {
    ...manualDoc.data,
    attributes: {
      ...manualDoc.data.attributes,
      kind: 'derived',
      rule: RULE,
      entries: GATHERED,
    },
  },
};

/** Answers the reads of what a derived manual's working copy gathers (`?workingCopy=true`). */
function answerGathered(t: Harness, doc: object = derivedDoc) {
  for (const r of t.http.match(
    (r) =>
      r.url === '/api/manuals/guide' && r.params.get('workingCopy') === 'true',
  )) {
    r.flush(doc);
  }
}

const workingCopy = (content: object, version = 0, manualId = 'guide') => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/manual/${manualId}`,
    attributes: {
      subject: { type: 'manual', manualId },
      content,
      version,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved: version > 0, issues: [] },
  },
});

/** The draft's own reads in a change set: the working copy and the manual's lock. */
async function draftReads(
  t: Harness,
  content: object = { ...HEADER, entries: ENTRIES },
) {
  t.answer(
    `/api/change-sets/${CS}/manuals/guide/working-copy`,
    workingCopy(content),
  );
  t.http
    .expectOne((r) => r.url === '/api/locks' && r.params.has('filter[subject]'))
    .flush(paged([]));
  await t.settle();
}

const notFound = [
  { errors: [{ status: '404', code: 'not-found' }] },
  { status: 404, statusText: 'Not Found' },
] as const;

/** Answers whatever is still open with a 404 (binary reads, the PDF pages, with an empty one). */
function drain(t: Harness) {
  t.http
    .match(() => true)
    .forEach((r) =>
      r.request.responseType === 'blob'
        ? r.flush(new Blob(), notFound[1])
        : r.cancelled || r.flush(...notFound),
    );
}

/** The add list's searches (#481): reads of summaries not by ID. */
const isChoices = (r: HttpRequest<unknown>) =>
  r.url === '/api/module-summaries' && !r.params.has('filter[id]');

/** Answers the add list's searches waiting, after the typing pause, with these modules. */
async function answerChoices(
  t: Harness,
  found: readonly object[] = SUMMARIES,
  total = found.length,
) {
  await vi.advanceTimersByTimeAsync(250);
  await t.settle();
  const reads = t.http.match(isChoices).filter((r) => !r.cancelled);
  for (const r of reads) {
    r.flush({
      ...paged([...found]),
      meta: {
        page: {
          currentPage: 1,
          lastPage: Math.max(1, Math.ceil(total / 50)),
          perPage: 50,
          total,
        },
      },
    });
  }
  await t.settle();
  return reads.map((r) => r.request);
}

/** The add list's options, by their text. */
const addOptions = () =>
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid=manual-add-list] [role=option]',
    ),
  ).map((o) => o.textContent?.trim());

/** The add list's option the keyboard highlights, by its text. */
async function highlighted(t: Harness) {
  await vi.advanceTimersByTimeAsync(0);
  await t.settle();
  return document
    .querySelector(
      '[data-testid=manual-add-list] [role=option][aria-selected=true]',
    )
    ?.textContent?.trim();
}

/** Chooses an option of the add list by its text. */
async function chooseAdd(t: Harness, text: string) {
  Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid=manual-add-list] [role=option]',
    ),
  )
    .find((o) => o.textContent?.trim() === text)
    ?.click();
  await t.settle();
}

/** Presses a key in the add list's search, as the keyboard does. */
async function pressInAdd(t: Harness, key: string) {
  // The simulated DOM scrolls nothing: the highlighted option is kept in view in a browser.
  Element.prototype.scrollIntoView ??= () => undefined;
  document
    .querySelector<HTMLInputElement>('z-command-input input')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  await t.settle();
}

/** A page after the first of the add list's search. */
const choicesPage = (
  number: number,
  found: readonly object[],
  total: number,
) => ({
  ...paged([...found]),
  meta: {
    page: {
      currentPage: number,
      lastPage: Math.max(1, Math.ceil(total / 50)),
      perPage: 50,
      total,
    },
  },
});

/** The builder's own methods for row conditions (the variant picker answers through them). */
interface RowConditions {
  variantPicked(pick: unknown): void;
  clearRowCondition(id: string): void;
}

/** The builder's own methods, for what its dropdown menu and dialog call. */
interface Builder {
  newModuleState(): { kind: string; reason?: string };
  duplicate(): void;
  deleteManual(): Promise<void>;
  openNew(prefill: unknown): void;
}

describe('ManualBuilderPage', () => {
  afterEach(() => {
    const http = TestBed.inject(HttpTestingController);
    // The PDF preview card's pages (cover-preview.component.spec.ts covers them).
    http.match((r) => r.url.includes('/pdf/pages/'));
    // The stable addresses card's list (stable-addresses.spec.ts covers it).
    http.match((r) => r.url === '/api/stable-addresses');
    // The settings panel's page designs (manual-settings-panel.component.spec.ts covers them).
    http.match((r) => r.url === '/api/page-designs');
    try {
      http.verify();
    } finally {
      // A failed test leaves nothing behind for the next one (or the next file).
      TestBed.resetTestingModule();
    }
  });

  it('shows the manual the address names, read-only without a change set', async () => {
    const t = await render('/manuals?manual=guide&lang=de&node=charging');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    expect(t.el.querySelector('h1')?.textContent).toContain('Guide');
    expect(
      t.rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['1Introduction', '2Operation', '2.1Charging']);
    // The outline's modules are read by ID, in one read: never the whole list (#481).
    expect(t.outlineReads.map((r) => r.params.get('filter[id]'))).toEqual([
      'intro,charging',
    ]);
    // The address's row is selected; nothing can be dragged.
    expect(t.rows()[2]?.getAttribute('aria-selected')).toBe('true');
    expect(t.el.querySelector('[cdkDragHandle]')).toBeNull();
    const add = Array.from(t.el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Add module'),
    );
    expect(add?.getAttribute('aria-disabled')).toBe('true');
    // German is chosen: one of its two modules falls back to the source.
    const outputs = t.el.querySelector('of-outputs-card');
    expect(
      outputs?.querySelector('[data-lang=de]')?.getAttribute('data-state'),
    ).toBe('selected');
    expect(outputs?.textContent).toContain('Partial');
    expect(t.router.url).toContain('manual=guide');
    expect(t.router.url).toContain('lang=de');
    // One primary action: the web preview of this manual, in the chosen language.
    expect(
      t.el.querySelector('[data-testid=manual-preview]')?.getAttribute('href'),
    ).toBe('/preview?manual=guide&lang=de&variant=model%3Dl');
    // "Run checks", in the menu, opens this manual's checks; Rename waits for a change set.
    await openMenu(t, 'manual-menu');
    expect(entry('manual-rename')?.getAttribute('aria-disabled')).toBe('true');
    entry('manual-run-checks')?.click();
    await t.settle();
    expect(t.router.url).toBe('/checks?manual=guide');
  });

  it('reads the lists and the open manual again when the branch gets a new head, keeping the outline meanwhile (#466)', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    expect(t.rows()).toHaveLength(3);

    // An update from main moved the branch read; its name stayed.
    TestBed.inject(ReadRef).moves.update((n) => n + 1);
    await t.settle();
    // The outline and its titles stay while everything is read again.
    expect(t.rows()).toHaveLength(3);
    expect(t.rows()[0]?.textContent).toContain('Introduction');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    expect(t.rows()).toHaveLength(3);
    // The PDF thumbnail is asked for again once the manual is read again (its card reloads).
    expect(
      t.http.match((r) => r.url.endsWith('/pdf/pages/1.png')),
    ).toHaveLength(2);
  });

  it('switches manuals from the title, the search field taking the focus', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    await openMenu(t, 'manual-switcher');
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement?.closest('z-command-input')).not.toBeNull();
    const alpha = Array.from(
      document.querySelectorAll<HTMLElement>('z-command-option [role=option]'),
    ).find((o) => o.textContent?.includes('Alpha'));
    alpha?.click();
    await t.settle();
    // Alpha is the first manual, the default: the address leaves it out.
    expect(t.router.url).toBe('/manuals');
    t.http
      .match((r) => r.url === '/api/manuals/alpha')
      .forEach((r) =>
        r.flush({
          data: {
            ...manualDoc.data,
            id: 'alpha',
            attributes: { ...manualDoc.data.attributes, title: 'Alpha' },
          },
        }),
      );
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain('Alpha');
  });

  it('opens the manual’s history from its menu (#321)', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    await openMenu(t, 'manual-menu');
    entry('manual-history')?.click();
    await t.settle();
    expect(t.router.url).toBe('/manuals/guide/history');
    // The catch-all route draws the builder again: what it reads is not this test's.
    drain(t);
    await t.settle();
    drain(t);
  });

  it('lists the deleted manuals in the switcher on "Show deleted", each opening its history (#321)', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    await openMenu(t, 'manual-switcher');
    const toggle = document.querySelector<HTMLElement>(
      '[data-testid=manual-show-deleted] button, [data-testid=manual-show-deleted] [role=switch]',
    );
    toggle?.click();
    await t.settle();
    // The switch is in the address, as the rest of the view.
    expect(t.router.url).toContain('deleted=shown');
    const read = t.http.expectOne(
      (r) =>
        r.url === '/api/manuals' &&
        r.params.get('filter[status]') === 'deleted',
    );
    read.flush(
      paged([
        {
          type: 'Manual',
          id: 'old',
          attributes: { title: 'Old guide' },
          meta: {
            deleted: { commit: 'c9', committedAt: '2026-11-01T10:00:00Z' },
          },
        },
      ]),
    );
    await t.settle();
    const removed = document.querySelector<HTMLElement>(
      '[data-testid=manual-removed] [role=option]',
    );
    expect(removed?.textContent).toContain('Old guide');
    removed?.click();
    await t.settle();
    expect(t.router.url).toBe('/manuals/old/history');
    // The catch-all route draws the builder again: what it reads is not this test's.
    drain(t);
    await t.settle();
    drain(t);
  });

  it('disables "Show deleted", with the reason, for a reader without draft access, and reads no deleted manuals (#410)', async () => {
    const t = await render('/manuals?manual=guide&deleted=shown');
    // Read for the person before (who reads drafts).
    t.http
      .match(
        (r) =>
          r.url === '/api/manuals' &&
          r.params.get('filter[status]') === 'deleted',
      )
      .forEach((r) =>
        r.flush(
          paged([
            {
              type: 'Manual',
              id: 'old',
              attributes: { title: 'Old guide' },
              meta: {
                deleted: { commit: 'c9', committedAt: '2026-11-01T10:00:00Z' },
              },
            },
          ]),
        ),
      );
    TestBed.inject(MeService).set({
      id: 'reader',
      kind: 'user',
      name: 'reader',
      role: '',
      permissions: new Set(['content.read']),
    });
    await t.settle();
    t.http
      .match((r) => r.url === '/api/manuals/guide')
      .forEach((r) => r.flush(manualDoc));
    t.http
      .match((r) => r.url === '/api/manuals' && !r.params.has('filter[status]'))
      .forEach((r) => r.flush(paged(MANUALS)));
    t.http
      .match((r) => r.url === '/api/config')
      .forEach((r) => r.flush({ data: { attributes: CONFIG } }));
    await t.settle();
    t.http
      .match((r) => r.url === '/api/manuals/guide')
      .forEach((r) => r.flush(manualDoc));
    await t.settle();
    await openMenu(t, 'manual-switcher');
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-testid=manual-show-deleted] button',
    );
    expect(toggle?.disabled).toBe(true);
    expect(
      document.querySelector('[data-testid=manual-show-deleted-reason]')
        ?.textContent,
    ).toContain('needs access to drafts');
    // The address asks for them, but none are read for this person, and none listed.
    t.http.expectNone(
      (r) =>
        r.url === '/api/manuals' &&
        r.params.get('filter[status]') === 'deleted',
    );
    expect(document.querySelector('[data-testid=manual-removed]')).toBeNull();
  });

  it('offers New manual in the empty state when there is no manual yet', async () => {
    const t = await render('/manuals');
    await lists(t, undefined, []);
    expect(t.el.textContent).toContain('No manuals yet');
    const button = t.el.querySelector<HTMLElement>(
      '[data-testid=manual-new-empty]',
    );
    // Without a draft change set it says why it cannot create one.
    expect(button?.getAttribute('aria-disabled')).toBe('true');
    expect(button?.getAttribute('aria-description')).toContain(
      'draft revision',
    );
  });

  it('drops values it does not know and leaves defaults out of the address', async () => {
    const t = await render(
      '/manuals?manual=gone&lang=xx&node=nope&cs=no%20id&variant=!!',
    );
    t.http
      .expectOne((r) => r.url === '/api/manuals/gone')
      .flush(
        { errors: [{ status: '404', code: 'not-found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    await lists(t);
    t.answer('/api/manuals/alpha', {
      data: { ...manualDoc.data, id: 'alpha' },
    });
    await t.settle();
    expect(t.router.url).toBe('/manuals');
  });

  it('saves a keyboard move into the change set: lock, then working copy', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    expect(t.router.url).toContain(`cs=${CS}`);
    const first = t.rows()[0] as HTMLElement;
    first.focus();
    first.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await t.settle();
    expect(
      t.rows().map((r) => r.querySelector('.font-mono')?.textContent?.trim()),
    ).toEqual(['1', '1.1', '2']);
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content.entries).toEqual([
      { title: 'Operation', entries: [{ module: 'charging' }] },
      { module: 'intro' },
    ]);
    put.flush({ errors: [] }, { status: 503, statusText: 'busy' });
    await t.settle();
    // An unknown outcome: the manual is read again.
    t.http
      .match((r) => !r.url.includes('/pdf/pages/'))
      .forEach((r) =>
        r.flush({ errors: [] }, { status: 503, statusText: 'busy' }),
      );
    await t.settle();
  });

  it('never edits a derived manual’s outline as entries: no moves, no adding, nothing saved (#669)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    expect(
      t.rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['1IntroductionFront matter', '2Safety']);
    const first = t.rows()[0] as HTMLElement;
    first.focus();
    for (const key of ['ArrowDown', 'Delete']) {
      first.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          altKey: key === 'ArrowDown',
          bubbles: true,
          cancelable: true,
        }),
      );
      await t.settle();
    }
    // The outline stays as gathered, and nothing is sent: no lock, no working copy.
    expect(
      t.rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim()),
    ).toEqual(['1IntroductionFront matter', '2Safety']);
    // The rule card's levels list has grips of its own (#676): none in the outline.
    expect(
      t.el.querySelector('[data-testid=manual-outline] [cdkDragHandle]'),
    ).toBeNull();
    expect(t.el.querySelector('[data-testid=manual-add]')).toBeNull();
    expect(t.el.querySelector('[data-row-menu]')).toBeNull();
    expect(
      t.http.match((r) => r.method !== 'GET' && !r.url.includes('/pdf/pages/')),
    ).toEqual([]);
    answerGathered(t);
  });

  it('shows an update guide’s steps by version and phase in place of the outline, and saves nothing on its own (#906, #908)', async () => {
    const guide = {
      attribute: 'software',
      versions: ['1.0', '2.0'],
      steps: [
        { module: 'intro', version: '2.0', phase: 'before' },
        { module: 'safety', version: '2.0', phase: 'after' },
      ],
    };
    const doc = {
      data: {
        ...manualDoc.data,
        attributes: {
          ...manualDoc.data.attributes,
          kind: 'update-guide',
          guide,
          entries: GATHERED,
        },
      },
    };
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', doc);
    await lists(t, {});
    await draftReads(t, {
      ...HEADER,
      kind: 'update-guide',
      guide,
      entries: GATHERED,
    });
    await t.settle();
    // The steps, each in its version and phase: no outline row, nothing to drag between them.
    const steps = Array.from(
      t.el.querySelectorAll<HTMLElement>('[data-testid=guide-step]'),
    );
    expect(steps.map((s) => s.dataset['module'])).toEqual(['intro', 'safety']);
    expect(
      steps.map((s) => s.closest('[data-phase]')?.getAttribute('data-phase')),
    ).toEqual(['before', 'after']);
    expect(t.el.querySelector('[data-testid=manual-outline]')).toBeNull();
    expect(
      t.http.match((r) => r.method !== 'GET' && !r.url.includes('/pdf/pages/')),
    ).toEqual([]);
  });

  it('leaves a gathered module out by its rule: saves the rule, never entries, and reads what it gathers again (#669)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    const card = t.el.querySelector('[data-testid=derived-rule]');
    expect(card?.textContent).toContain('Gathering rule');
    expect(
      t.el.querySelector('[data-testid=module-count]')?.textContent,
    ).toContain('2 modules, gathered from Alpha');
    t.rows()[1]
      ?.querySelector<HTMLElement>('[data-action=row-exclude]')
      ?.click();
    await t.settle();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    const content = put.request.body.data.attributes.content;
    expect(content.rule).toEqual({ ...RULE, exclude: ['safety'] });
    expect(content.kind).toBe('derived');
    expect(content.entries).toEqual([]);
    put.flush(workingCopy({ ...content, entries: [] }, 1));
    await t.settle();
    // What it gathers is read again; the rows stay meanwhile, dimmed.
    expect(t.rows()).toHaveLength(2);
    expect(
      t.el
        .querySelector('[data-testid=manual-outline]')
        ?.getAttribute('aria-busy'),
    ).toBe('true');
    answerGathered(t, {
      data: {
        ...derivedDoc.data,
        attributes: {
          ...derivedDoc.data.attributes,
          rule: { ...RULE, exclude: ['safety'] },
          entries: [{ module: 'intro' }],
        },
        meta: {
          ...derivedDoc.data.meta,
          issues: [
            {
              severity: 'warning',
              code: 'safety-module-excluded',
              message: 'left out',
              at: 'safety',
            },
          ],
        },
      },
    });
    await t.settle();
    expect(t.rows()).toHaveLength(1);
    const issue = t.el.querySelector(
      '[data-testid=rule-issues] [data-code=safety-module-excluded]',
    );
    expect(issue?.textContent).toContain('Safety module left out');
    expect(issue?.textContent).toContain('(Safety)');
    expect(
      t.el.querySelector('[data-testid=rule-excluded]')?.textContent,
    ).toContain('Safety');
    drain(t);
  });

  it('leaves a gathered module out with Delete, from the keyboard (#669)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    const row = t.rows()[1] as HTMLElement;
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Delete',
        bubbles: true,
        cancelable: true,
      }),
    );
    await t.settle();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    const content = put.request.body.data.attributes.content;
    expect(content.rule.exclude).toEqual(['safety']);
    expect(content.entries).toEqual([]);
    put.flush(workingCopy({ ...content, entries: [] }, 1));
    await t.settle();
    answerGathered(t);
    await t.settle();
    drain(t);
  });

  /** The rule card's choice of what it gathers (#676): whole modules or safety notices. */
  const gathering = (t: Harness, value: 'modules' | 'notices') =>
    t.el.querySelector<HTMLElement>(
      `[data-testid=rule-gathering] [data-gathering=${value}] button[role=radio]`,
    );

  /** Takes the lock and gives the working copy's save that waits, answered as saved. */
  async function saved(t: Harness, version: number, lock = true) {
    if (lock) {
      t.answer(`/api/change-sets/${CS}/locks`, {
        data: { type: 'Lock', id: 'l1' },
      });
      await t.settle();
    }
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    const content = put.request.body.data.attributes.content;
    put.flush(workingCopy({ ...content, entries: [] }, version));
    await t.settle();
    return content;
  }

  it('saves a rule without notices unchanged: no notices member, also once notices were chosen and taken back (#676)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    expect(gathering(t, 'modules')?.getAttribute('aria-checked')).toBe('true');
    // Choosing what it is already saves nothing.
    gathering(t, 'modules')?.click();
    await t.settle();
    expect(
      t.http.match((r) => r.method !== 'GET' && !r.url.includes('/pdf/pages/')),
    ).toEqual([]);

    gathering(t, 'notices')?.click();
    await t.settle();
    const notices = await saved(t, 1);
    expect(notices.rule).toEqual({ ...RULE, notices: { groupBy: 'module' } });
    answerGathered(t);
    await t.settle();

    gathering(t, 'modules')?.click();
    await t.settle();
    const modules = await saved(t, 2, false);
    expect(modules.rule).toEqual(RULE);
    expect('notices' in modules.rule).toBe(false);
    answerGathered(t);
    await t.settle();
    drain(t);
  });

  it('gathers notices grouped by hazard level, of the levels ticked, and says so in the outline (#676)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    const options = t.el.querySelector('[data-testid=rule-notices]');
    expect(options?.closest('of-collapse')?.getAttribute('data-state')).toBe(
      'closed',
    );

    gathering(t, 'notices')?.click();
    await t.settle();
    await saved(t, 1);
    const noticeDoc = (notices: object) => ({
      data: {
        ...derivedDoc.data,
        attributes: {
          ...derivedDoc.data.attributes,
          rule: { ...RULE, notices },
        },
      },
    });
    answerGathered(t, noticeDoc({ groupBy: 'module' }));
    await t.settle();
    expect(options?.closest('of-collapse')?.getAttribute('data-state')).toBe(
      'open',
    );
    // The types field now names the types searched: none chosen, every type.
    expect(
      t.el.querySelector('[data-testid=rule-types-hint]')?.textContent,
    ).toContain('every type');

    t.el
      .querySelector<HTMLElement>(
        '[data-testid=rule-grouping] [data-grouping=level] button[role=radio]',
      )
      ?.click();
    await t.settle();
    const byLevel = await saved(t, 2, false);
    expect(byLevel.rule).toEqual({ ...RULE, notices: { groupBy: 'level' } });
    answerGathered(t, noticeDoc({ groupBy: 'level' }));
    await t.settle();
    expect(
      t.el.querySelector('[data-testid=module-count]')?.textContent,
    ).toContain(
      '2 modules holding notices, gathered from Alpha, grouped by hazard level',
    );
    const levels = () =>
      Array.from(
        t.el.querySelectorAll<HTMLElement>(
          '[data-testid=rule-levels] [data-level]',
        ),
      );
    expect(levels().map((l) => l.textContent?.trim())).toEqual([
      'Danger',
      'Warning',
      'Caution',
      'Notice',
    ]);

    // Unticking a level gathers the others, in their order.
    levels()[3]?.querySelector<HTMLInputElement>('input')?.click();
    await t.settle();
    const three = await saved(t, 3, false);
    expect(three.rule.notices).toEqual({
      groupBy: 'level',
      levels: ['danger', 'warning', 'caution'],
    });
    answerGathered(t, noticeDoc(three.rule.notices));
    await t.settle();
    drain(t);
  });

  it('puts the rule card back when a change of what it gathers is refused (#676)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', derivedDoc);
    await lists(t, {});
    await draftReads(t, { ...DERIVED_HEADER, entries: GATHERED });
    answerGathered(t);
    await t.settle();
    const toast = vi.spyOn(TestBed.inject(ToastService), 'error');
    gathering(t, 'notices')?.click();
    await t.settle();
    expect(gathering(t, 'notices')?.getAttribute('aria-checked')).toBe('true');
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    t.http.expectOne(`/api/change-sets/${CS}/manuals/guide/working-copy`).flush(
      {
        errors: [{ status: '422', code: 'invalid-manifest', title: 'No' }],
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await t.settle();
    expect(toast).toHaveBeenCalled();
    expect(gathering(t, 'modules')?.getAttribute('aria-checked')).toBe('true');
    expect(
      t.el
        .querySelector('[data-testid=rule-notices]')
        ?.closest('of-collapse')
        ?.getAttribute('data-state'),
    ).toBe('closed');
    drain(t);
  });

  it('limits a row to some variants from its actions, shows it as a chip and takes it away', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    const page = t.fixture.componentInstance as unknown as RowConditions;
    // Shift+F10 opens the row's actions, which offer it.
    const row = t.rows()[0] as HTMLElement;
    row.focus();
    row.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'F10',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    await t.settle();
    const item = Array.from(
      document.querySelectorAll<HTMLElement>('z-dropdown-menu-item'),
    ).find((i) => i.textContent?.includes('Only for some variants'));
    expect(item).toBeDefined();
    item?.click();
    // The variant picker opens and reads the variant attributes.
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(0);
    t.http
      .match((r) => r.url === '/api/variants')
      .forEach((r) => r.flush(paged([])));
    await t.settle();
    expect(document.querySelector('z-dialog-title')?.textContent).toContain(
      'Include this row for',
    );
    page.variantPicked({ op: 'in', attr: 'model', values: ['xl'] });
    await t.settle();
    expect(
      t.rows()[0]?.querySelector('[data-testid=row-condition]')?.textContent,
    ).toContain('Model: XL');
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content.entries[0]).toEqual({
      module: 'intro',
      when: { op: 'in', attr: 'model', values: ['xl'] },
    });
    put.flush(workingCopy({ ...HEADER, entries: ENTRIES }, 1));
    await t.settle();
    page.clearRowCondition('intro');
    await t.settle();
    expect(
      t.rows()[0]?.querySelector('[data-testid=row-condition]'),
    ).toBeNull();
    const second = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(second.request.body.data.attributes.content.entries[0]).toEqual({
      module: 'intro',
    });
    second.flush(workingCopy({ ...HEADER, entries: ENTRIES }, 2));
    await t.settle();
    drain(t);
  });

  it('opens the settings from their card; a variant build added shows in Outputs and the variant select', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    const card = t.el.querySelector('of-settings-card');
    expect(
      card?.querySelector('[data-testid=card-variants]')?.textContent,
    ).toContain('1');
    card
      ?.querySelector<HTMLButtonElement>('[data-testid=settings-open]')
      ?.click();
    await t.settle();
    expect(document.querySelector('of-manual-settings-panel')).not.toBeNull();
    document
      .querySelector<HTMLButtonElement>('[data-testid=variant-add]')
      ?.click();
    await t.settle();
    document
      .querySelector<HTMLButtonElement>('[data-testid=variant-save]')
      ?.click();
    await t.settle();
    expect(
      t.el.querySelector('[data-testid=outputs-variants]')?.textContent,
    ).toContain('L, XL');
    expect(t.el.querySelector('of-cover-preview z-select')).not.toBeNull();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content.variants).toEqual([
      { model: 'l' },
      { model: 'xl' },
    ]);
    put.flush(
      workingCopy(
        {
          ...HEADER,
          variants: [{ model: 'l' }, { model: 'xl' }],
          entries: ENTRIES,
        },
        1,
      ),
    );
    await t.settle();
    drain(t);
  });

  it('renames the manual in place: Enter saves the title, the ID stays', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    const title = t.el.querySelector<HTMLButtonElement>(
      'h1 [data-testid=manual-switcher]',
    );
    expect(title?.textContent).toContain('Guide');
    await startRename(t);
    const field = t.el.querySelector<HTMLInputElement>(
      '[data-testid=manual-title-input]',
    ) as HTMLInputElement;
    // Empty is refused on Enter, with the reason.
    field.value = '  ';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await t.settle();
    expect(t.el.querySelector('#manual-title-error')?.textContent).toContain(
      'Enter a title',
    );
    field.value = 'Field  guide';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain('Field guide');
    // The focus goes back to the title, the manual switcher.
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement?.getAttribute('data-testid')).toBe(
      'manual-switcher',
    );
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content).toMatchObject({
      id: 'guide',
      title: 'Field guide',
      entries: ENTRIES,
    });
    put.flush(
      workingCopy({ ...HEADER, title: 'Field guide', entries: ENTRIES }, 1),
    );
    await t.settle();
  });

  it('deprecates the manual from its menu, saved into the working copy, and undoes it (#266)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-menu');
    entry('manual-deprecate')?.click();
    await t.settle();
    t.http
      .expectOne(
        (r) => r.url === '/api/manuals' && r.params.get('page[size]') === '200',
      )
      .flush({
        data: [],
        meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 0 } },
        links: { self: '', first: '', last: '', prev: null, next: null },
      });
    await t.settle();
    const dialog = document.querySelector('z-dialog-panel') as HTMLElement;
    expect(dialog.textContent).toContain('Deprecate “Guide”');
    const reason = dialog.querySelector<HTMLInputElement>('#deprecate-reason');
    if (reason) {
      reason.value = 'Replaced by the field guide.';
      reason.dispatchEvent(new Event('input'));
    }
    await t.settle();
    dialog
      .querySelector<HTMLButtonElement>('[data-slot="deprecate-confirm"]')
      ?.click();
    await t.settle();
    expect(t.el.querySelector('[data-testid=manual-deprecated]')).toBeTruthy();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content.deprecated).toEqual({
      reason: 'Replaced by the field guide.',
    });
    put.flush(
      workingCopy(
        {
          ...HEADER,
          deprecated: { reason: 'Replaced by the field guide.' },
          entries: ENTRIES,
        },
        1,
      ),
    );
    await t.settle();
    const toasts = TestBed.inject(ToastService);
    const shown = toasts.toasts().find((x) => x.actionLabel);
    toasts.runAction(shown?.id ?? 0);
    await t.settle();
    expect(t.el.querySelector('[data-testid=manual-deprecated]')).toBeNull();
    const undo = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(undo.request.body.data.attributes.content).not.toHaveProperty(
      'deprecated',
    );
    undo.flush(workingCopy({ ...HEADER, entries: ENTRIES }, 2));
    await t.settle();
  });

  it('puts the title back when Escape cancels the rename', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await startRename(t);
    const field = t.el.querySelector<HTMLInputElement>(
      '[data-testid=manual-title-input]',
    ) as HTMLInputElement;
    field.value = 'Other';
    field.dispatchEvent(new Event('input'));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain('Guide');
    t.http.expectNone(`/api/change-sets/${CS}/locks`);
  });

  it('never offers New, Duplicate or Delete to a reader without content.edit', async () => {
    const t = await render('/manuals?manual=guide');
    TestBed.inject(MeService).set({
      id: 'reader',
      kind: 'user',
      name: 'reader',
      role: '',
      permissions: new Set(['content.read']),
    });
    await t.settle();
    t.http
      .match((r) => r.url === '/api/manuals/guide')
      .forEach((r) => r.flush(manualDoc));
    t.http
      .match((r) => r.url === '/api/manuals')
      .forEach((r) => r.flush(paged(MANUALS)));
    t.http
      .match((r) => r.url === '/api/config')
      .forEach((r) => r.flush({ data: { attributes: CONFIG } }));
    await t.settle();
    t.http
      .match((r) => r.url === '/api/manuals/guide')
      .forEach((r) => r.flush(manualDoc));
    await t.settle();
    // The switcher lists the manuals, without "New manual".
    await openMenu(t, 'manual-switcher');
    expect(document.body.textContent).toContain('Alpha');
    expect(entry('manual-new')).toBeNull();
    // The menu has Run checks only.
    await openMenu(t, 'manual-menu');
    expect(entry('manual-run-checks')).not.toBeNull();
    expect(entry('manual-rename')).toBeNull();
    expect(document.body.textContent).not.toContain('Duplicate');
    expect(document.body.textContent).not.toContain('Delete manual');
  });

  it('blocks New manual without a draft change set, with the reason', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    await openMenu(t, 'manual-switcher');
    const option = entry('manual-new')?.querySelector('[role=option]');
    expect(option?.getAttribute('aria-disabled')).toBe('true');
    expect(option?.textContent).toContain('draft revision');
  });

  it('creates an empty manual: lock, working copy, no save point, and opens it as New', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    // "New manual" is the switcher's last entry.
    await openMenu(t, 'manual-switcher');
    entry('manual-new')?.querySelector<HTMLElement>('[role=option]')?.click();
    await t.settle();
    const field = document.querySelector<HTMLInputElement>(
      '#new-manual-title',
    ) as HTMLInputElement;
    field.value = 'Quick start guide';
    field.dispatchEvent(new Event('input'));
    await t.settle();
    expect(document.querySelector('#new-manual-id')?.textContent).toContain(
      'quick-start-guide',
    );
    document
      .querySelector<HTMLFormElement>('#new-manual-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await t.settle();
    t.answer(`/api/change-sets/${CS}`, {
      data: { type: 'ChangeSet', id: CS, attributes: { baseCommit: 'b0' } },
    });
    await t.settle();
    t.http
      .expectOne(
        `/api/change-sets/${CS}/manuals/quick-start-guide/working-copy`,
      )
      .flush(...notFound);
    await t.settle();
    const lock = t.http.expectOne(`/api/change-sets/${CS}/locks`);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'manual',
      manualId: 'quick-start-guide',
    });
    lock.flush({ data: { type: 'Lock', id: 'l2' } });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/quick-start-guide/working-copy`,
    );
    expect(put.request.body).toEqual({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: {
            schemaVersion: 1,
            id: 'quick-start-guide',
            title: 'Quick start guide',
            variants: [{ model: 'l' }],
            attributes: {},
            entries: [],
          },
        },
      },
      meta: { version: 0, baseCommit: 'b0' },
    });
    const content = put.request.body.data.attributes.content;
    put.flush(workingCopy(content, 1, 'quick-start-guide'));
    await t.settle();
    // Nothing to commit yet: a manifest needs an entry.
    t.http.expectNone(`/api/change-sets/${CS}/commits`);
    expect(t.router.url).toContain('manual=quick-start-guide');
    // The builder reads it: not on the branch, so from the working copy.
    t.http
      .expectOne((r) => r.url === '/api/manuals/quick-start-guide')
      .flush(...notFound);
    await lists(t, { locks: ['quick-start-guide'] });
    t.http
      .match(`/api/change-sets/${CS}/manuals/quick-start-guide/working-copy`)
      .forEach((r) => r.flush(workingCopy(content, 1, 'quick-start-guide')));
    t.http
      .match((r) => r.url === '/api/locks' && r.params.has('filter[subject]'))
      .forEach((r) => r.flush(paged([])));
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain(
      'Quick start guide',
    );
    expect(t.el.textContent).toContain('No modules in this manual');
    // An empty manual has no PDF to build: the preview menu's PDF entry says why.
    await openMenu(t, 'manual-preview-menu');
    expect(entry('manual-build-pdf')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .some((x) => x.kind === 'success'),
    ).toBe(true);
  });

  it('duplicates: the dialog starts as "Copy of <title>" copying the manual', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    (t.fixture.componentInstance as unknown as Builder).duplicate();
    await t.settle();
    const field = document.querySelector<HTMLInputElement>('#new-manual-title');
    expect(field?.value).toBe('Copy of Guide');
    expect(document.querySelector('#new-manual-id')?.textContent).toContain(
      'copy-of-guide',
    );
    document
      .querySelector<HTMLFormElement>('#new-manual-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await t.settle();
    t.answer(`/api/change-sets/${CS}`, {
      data: { type: 'ChangeSet', id: CS, attributes: { baseCommit: 'b0' } },
    });
    // The source as the person has it in the change set.
    t.answer(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
      workingCopy({
        ...HEADER,
        variants: [{ model: 'l' }, { model: 'xl' }],
        attributes: { 'product-name': 'Thing' },
        entries: ENTRIES,
      }),
    );
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/manuals/copy-of-guide/working-copy`)
      .flush(...notFound);
    await t.settle();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l3' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/copy-of-guide/working-copy`,
    );
    expect(put.request.body.data.attributes.content).toEqual({
      schemaVersion: 1,
      id: 'copy-of-guide',
      title: 'Copy of Guide',
      variants: [{ model: 'l' }, { model: 'xl' }],
      attributes: { 'product-name': 'Thing' },
      entries: ENTRIES,
    });
    put.flush(
      workingCopy(put.request.body.data.attributes.content, 1, 'copy-of-guide'),
    );
    await t.settle();
    // It has entries: a save point commits it.
    const commit = t.http.expectOne(`/api/change-sets/${CS}/commits`);
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'manual', manualId: 'copy-of-guide' },
    ]);
    commit.flush({ data: { type: 'Commit', id: 'c9' } });
    await t.settle();
    expect(t.router.url).toContain('manual=copy-of-guide');
    drain(t);
    await t.settle();
    drain(t);
  });

  it('deletes the manual without asking, and its toast undoes it', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    void (t.fixture.componentInstance as unknown as Builder).deleteManual();
    await t.settle();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const commit = t.http.expectOne(`/api/change-sets/${CS}/commits`);
    expect(commit.request.body.data.attributes).toMatchObject({
      subjects: [],
      deletes: [{ type: 'manual', manualId: 'guide' }],
    });
    commit.flush({ data: { type: 'Commit', id: 'c1' } });
    await t.settle();
    // The next manual is shown; the chooser marks the deleted one.
    expect(t.router.url).not.toContain('manual=guide');
    await lists(t, { changes: [{ id: 'guide', change: 'removed' }] }, [
      MANUALS[0] as object,
    ]);
    t.http
      .match((r) => r.url === '/api/manuals/guide')
      .forEach((r) => r.flush(manualDoc));
    t.http
      .match((r) => r.url === '/api/manuals/alpha')
      .forEach((r) =>
        r.flush({
          data: {
            ...manualDoc.data,
            id: 'alpha',
            attributes: { ...manualDoc.data.attributes, title: 'Alpha' },
          },
        }),
      );
    await t.settle();
    t.http
      .match(`/api/change-sets/${CS}/manuals/alpha/working-copy`)
      .forEach((r) =>
        r.flush(
          workingCopy(
            { ...HEADER, id: 'alpha', title: 'Alpha', entries: ENTRIES },
            0,
            'alpha',
          ),
        ),
      );
    t.http
      .match((r) => r.url === '/api/locks' && r.params.has('filter[subject]'))
      .forEach((r) => r.flush(paged([])));
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain('Alpha');
    // The switcher marks it, with the word.
    await openMenu(t, 'manual-switcher');
    expect(
      document.querySelector('z-badge[data-state=deleted]')?.textContent,
    ).toContain('Deleted');
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    // Chosen, it says it is deleted; the heading keeps its title.
    await t.router.navigateByUrl(`/manuals?manual=guide&cs=${CS}`);
    await t.settle();
    expect(t.el.querySelector('h1')?.textContent).toContain('Guide');
    expect(t.el.textContent).toContain('Deleted in this revision');
    // A deleted manual has no preview and no menu.
    expect(t.el.querySelector('[data-testid=manual-menu]')).toBeNull();
    expect(t.el.querySelector('[data-testid=manual-preview]')).toBeNull();
    const toast = TestBed.inject(ToastService).toasts().at(-1);
    expect(toast?.actionLabel).toBeTruthy();
    toast?.onAction?.();
    await t.settle();
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l1' },
    });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(put.request.body).toEqual({
      data: {
        type: 'WorkingCopy',
        attributes: { content: { ...HEADER, entries: ENTRIES } },
      },
      meta: { version: 0, baseCommit: 'c1' },
    });
    put.flush(workingCopy({ ...HEADER, entries: ENTRIES }, 1));
    await t.settle();
    const restore = t.http.expectOne(`/api/change-sets/${CS}/commits`);
    expect(restore.request.body.data.attributes.subjects).toEqual([
      { type: 'manual', manualId: 'guide' },
    ]);
    restore.flush({ data: { type: 'Commit', id: 'c2' } });
    await t.settle();
    expect(t.router.url).toContain('manual=guide');
    drain(t);
    await t.settle();
    drain(t);
  });

  it('opens the dialog a palette request asked for, once it can', async () => {
    const t = await render('/manuals?manual=guide', true);
    TestBed.inject(NewManualRequest).request();
    await t.settle();
    // Not before the configuration is read.
    expect(document.querySelector('#new-manual-title')).toBeNull();
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    expect(document.querySelector('#new-manual-title')).not.toBeNull();
    expect(TestBed.inject(NewManualRequest).pending()).toBe(false);
  });

  it('keeps a new manual listed when the change set’s lists cannot be read', async () => {
    const t = await render('/manuals?manual=fresh', true);
    t.http.expectOne((r) => r.url === '/api/manuals/fresh').flush(...notFound);
    t.answer('/api/manuals', paged([...MANUALS]));
    t.answer('/api/config', { data: { attributes: CONFIG } });
    await t.settle();
    t.http
      .expectOne((r) => r.url === `/api/change-sets/${CS}/changes`)
      .flush({ errors: [] }, { status: 503, statusText: 'busy' });
    t.http
      .expectOne(
        (r) => r.url === '/api/locks' && r.params.has('filter[changeSet]'),
      )
      .flush(paged([]));
    await t.settle();
    t.http
      .match(`/api/change-sets/${CS}/manuals/fresh/working-copy`)
      .forEach((r) =>
        r.flush(
          workingCopy(
            { ...HEADER, id: 'fresh', title: 'Fresh', entries: [] },
            1,
            'fresh',
          ),
        ),
      );
    t.http
      .match((r) => r.url === '/api/locks' && r.params.has('filter[subject]'))
      .forEach((r) => r.flush(paged([])));
    await t.settle();
    // The address's manual stands: not dropped for the first one.
    expect(t.router.url).toContain('manual=fresh');
    expect(t.el.querySelector('h1')?.textContent).toContain('Fresh');
  });

  it('creates a new module from the add list, titled by the search, placed and focused; Undo takes it out (#386)', async () => {
    const t = await render('/manuals?manual=guide&node=intro', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await answerChoices(t, []);
    // Last in the list, after a divider: "New module…", the search text as its title.
    expect(entry('module-new')?.textContent).toContain('New module…');
    const search = document.querySelector<HTMLInputElement>(
      'z-command-input input',
    ) as HTMLInputElement;
    search.value = 'Battery care';
    search.dispatchEvent(new Event('input'));
    await t.settle();
    await answerChoices(t, []);
    const option =
      entry('module-new')?.querySelector<HTMLElement>('[role=option]');
    expect(option?.textContent).toContain('New module “Battery care”…');
    option?.click();
    await t.settle();
    // The dialog opens with that title, in the manual's language, naming the manual.
    const field = document.querySelector<HTMLInputElement>(
      '#new-module-title',
    ) as HTMLInputElement;
    expect(field.value).toBe('Battery care');
    expect(document.body.textContent).toContain('added to the manual “Guide”');
    document
      .querySelector<HTMLFormElement>('#new-module-form')
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await t.settle();
    // Created in the revision as anywhere else: lock, working copy, save point.
    t.answer(`/api/change-sets/${CS}`, {
      data: { type: 'ChangeSet', id: CS, attributes: { baseCommit: 'b0' } },
    });
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/modules/en/battery-care/working-copy`)
      .flush(...notFound);
    await t.settle();
    t.http
      .expectOne(
        (r) =>
          r.url === '/api/module-summaries' &&
          r.params.get('filter[q]') === 'battery-care',
      )
      .flush(paged([]));
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${CS}/locks`)
      .flush({ data: { type: 'Lock', id: 'l2' } });
    await t.settle();
    const put = t.http.expectOne(
      `/api/change-sets/${CS}/modules/en/battery-care/working-copy`,
    );
    expect(put.request.body.data.attributes.content.meta).toMatchObject({
      title: 'Battery care',
      lang: 'en',
      type: 'concept',
    });
    put.flush({});
    await t.settle();
    t.answer(`/api/change-sets/${CS}/commits`, {});
    await t.settle();
    // In the outline where the list was opened (after the selected row), selected and focused.
    const titles = () =>
      t.rows().map((r) => r.textContent?.replace(/\s+/g, ' ').trim());
    expect(titles()).toEqual([
      '1Introduction',
      // Listed with its title at once, as new in the revision.
      '2Battery care Draft',
      '3Operation',
      '3.1Charging',
    ]);
    expect(t.router.url).toContain('node=battery-care');
    expect(document.activeElement).toBe(t.rows()[1]);
    expect(t.el.textContent).not.toContain('Not found');
    const toasts = TestBed.inject(ToastService).toasts();
    const done = toasts.find(
      (x) =>
        typeof x.message !== 'string' &&
        x.message.key === 'editor.manuals.add.created',
    );
    expect(done?.actionLabel).toBeTruthy();
    expect(toasts.filter((x) => x.kind === 'success')).toHaveLength(1);
    // The outline is saved into the manual's working copy.
    t.answer(`/api/change-sets/${CS}/locks`, {
      data: { type: 'Lock', id: 'l3' },
    });
    await t.settle();
    const save = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(save.request.body.data.attributes.content.entries).toEqual([
      { module: 'intro' },
      { module: 'battery-care' },
      { title: 'Operation', entries: [{ module: 'charging' }] },
    ]);
    save.flush(workingCopy(save.request.body.data.attributes.content, 1));
    await t.settle();
    // Undo takes it out of the outline; the module itself stays.
    done?.onAction?.();
    await t.settle();
    expect(titles()).toEqual(['1Introduction', '2Operation', '2.1Charging']);
    const again = t.http.expectOne(
      `/api/change-sets/${CS}/manuals/guide/working-copy`,
    );
    expect(again.request.body.data.attributes.content.entries).toEqual(ENTRIES);
    again.flush(workingCopy(again.request.body.data.attributes.content, 2));
    await t.settle();
    t.http.expectNone((r) => r.method === 'DELETE');
    drain(t);
  });

  it('searches the add list on the server, adds a module found and marks one the branch lacks (#481)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', {
      ...manualDoc,
      data: {
        ...manualDoc.data,
        attributes: {
          ...manualDoc.data.attributes,
          entries: [...ENTRIES, { module: 'gone' }],
        },
      },
    });
    await lists(t, {});
    await draftReads(t, {
      ...HEADER,
      entries: [...ENTRIES, { module: 'gone' }],
    });
    // A module the branch has no summary of is marked, the others are not.
    const gone = t.rows().find((r) => r.textContent?.includes('gone'));
    expect(gone?.textContent).toContain('Not found');
    expect(t.rows()[0]?.textContent).not.toContain('Not found');
    // Nothing is searched until the add list opens.
    expect(t.http.match(isChoices)).toEqual([]);
    await openMenu(t, 'manual-add');
    const first = await answerChoices(t, SUMMARIES, 120);
    expect(first.map((r) => r.params.get('page[size]'))).toEqual(['50']);
    expect(first[0]?.params.has('filter[q]')).toBe(false);
    // The modules in the manual already are left out; more found than shown says so.
    const options = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '[data-testid=manual-add-list] [role=option]',
        ),
      ).map((o) => o.textContent?.trim());
    expect(options()).toEqual(['Safety', 'Show more modules', 'New module…']);
    expect(entry('manual-add-more')?.textContent).toContain(
      'More modules match',
    );
    // "Show more" reads the next page and adds it: a manual holding most of the first page's
    // modules still offers the rest.
    entry('manual-add-show-more')
      ?.querySelector<HTMLElement>('[role=option]')
      ?.click();
    await t.settle();
    const next = t.http.expectOne(isChoices);
    expect(next.request.params.get('page[number]')).toBe('2');
    next.flush({
      ...paged([summary('wiring', 'Wiring', ['en'])]),
      meta: { page: { currentPage: 2, lastPage: 3, perPage: 50, total: 120 } },
    });
    await t.settle();
    expect(options()).toEqual([
      'Safety',
      'Wiring',
      'Show more modules',
      'New module…',
    ]);
    // The highlight stays on "Show more" (Enter again reads on, never adds a module by surprise).
    await vi.advanceTimersByTimeAsync(0);
    await t.settle();
    expect(
      document
        .querySelector(
          '[data-testid=manual-add-list] [role=option][aria-selected=true]',
        )
        ?.textContent?.trim(),
    ).toBe('Show more modules');
    // Typing searches on the server, after a pause.
    const search = document.querySelector<HTMLInputElement>(
      'z-command-input input',
    ) as HTMLInputElement;
    search.value = 'saf';
    search.dispatchEvent(new Event('input'));
    await t.settle();
    const typed = await answerChoices(t, [SUMMARIES[2] as object]);
    expect(typed.map((r) => r.params.get('filter[q]'))).toEqual(['saf']);
    expect(entry('manual-add-more')).toBeNull();
    // Choosing it adds its row, titled at once, without another read.
    document
      .querySelector<HTMLElement>('[data-testid=manual-add-list] [role=option]')
      ?.click();
    await t.settle();
    expect(t.rows().some((r) => r.textContent?.includes('Safety'))).toBe(true);
    expect(t.outlineReads).toHaveLength(1);
    drain(t);
  });

  it('says when the add list cannot be searched, and tries again (#481)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await vi.advanceTimersByTimeAsync(250);
    await t.settle();
    t.http
      .expectOne(isChoices)
      .flush({ errors: [] }, { status: 503, statusText: 'busy' });
    await t.settle();
    expect(entry('manual-add-failed')?.textContent).toContain(
      'could not be searched',
    );
    Array.from(document.querySelectorAll<HTMLElement>('[role=option]'))
      .find((o) => o.textContent?.includes('Try again'))
      ?.click();
    await t.settle();
    await answerChoices(t);
    expect(entry('manual-add-failed')).toBeNull();
    drain(t);
  });

  it('keeps the highlight when the next page fails, says so in the list and reads that page again (#561)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await answerChoices(t, SUMMARIES, 120);
    // By keyboard: down to "Show more", Enter.
    await pressInAdd(t, 'ArrowDown');
    expect(await highlighted(t)).toBe('Show more modules');
    await pressInAdd(t, 'Enter');
    t.http
      .expectOne(isChoices)
      .flush({ errors: [] }, { status: 503, statusText: 'busy' });
    await t.settle();
    // The highlight stays where it was, never on a module (Enter again would add it).
    expect(await highlighted(t)).toBe('Try again');
    // In place of "Show more": what failed and a retry.
    expect(entry('manual-add-more-failed')?.textContent).toContain(
      'could not be read',
    );
    expect(entry('manual-add-failed')).toBeNull();
    expect(addOptions()).toEqual(['Safety', 'Try again', 'New module…']);
    // Trying again reads the page that failed, not the first one again.
    await chooseAdd(t, 'Try again');
    const again = t.http.expectOne(isChoices);
    expect(again.request.params.get('page[number]')).toBe('2');
    again.flush(choicesPage(2, [summary('wiring', 'Wiring', ['en'])], 120));
    await t.settle();
    expect(entry('manual-add-more-failed')).toBeNull();
    expect(addOptions()).toEqual([
      'Safety',
      'Wiring',
      'Show more modules',
      'New module…',
    ]);
    expect(await highlighted(t)).toBe('Show more modules');
    drain(t);
  });

  it('moves no highlight later when "Show more" was chosen while a search was loading (#561)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await answerChoices(t, SUMMARIES, 120);
    const search = document.querySelector<HTMLInputElement>(
      'z-command-input input',
    ) as HTMLInputElement;
    search.value = 'a';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    await t.settle();
    // The search is on its way: "Show more" reads nothing now, and nothing later.
    await chooseAdd(t, 'Show more modules');
    const reads = t.http.match(isChoices);
    expect(reads.map((r) => r.request.params.get('page[number]'))).toEqual([
      '1',
    ]);
    reads[0]?.flush(choicesPage(1, SUMMARIES, 120));
    await t.settle();
    expect(addOptions()).toEqual([
      'Safety',
      'Show more modules',
      'New module “a”…',
    ]);
    expect(await highlighted(t)).toBe('Safety');
    t.http.expectNone(isChoices);
    drain(t);
  });

  it('keeps following the page when "Show more" is chosen twice, and reads nothing for a search still typed (#561)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await answerChoices(t, SUMMARIES, 120);
    await pressInAdd(t, 'ArrowDown');
    await pressInAdd(t, 'Enter');
    // Enter again while the page is on its way: one read, still followed.
    await pressInAdd(t, 'Enter');
    const next = t.http.match(isChoices);
    expect(next).toHaveLength(1);
    next[0]?.flush(choicesPage(2, [summary('wiring', 'Wiring', ['en'])], 120));
    await t.settle();
    expect(await highlighted(t)).toBe('Show more modules');
    // Typed, the pause not over: "Show more" would read the old search's page; it reads none.
    const search = document.querySelector<HTMLInputElement>(
      'z-command-input input',
    ) as HTMLInputElement;
    search.value = 'a';
    search.dispatchEvent(new Event('input'));
    await t.settle();
    await chooseAdd(t, 'Show more modules');
    t.http.expectNone(isChoices);
    const typed = await answerChoices(t, SUMMARIES, 120);
    expect(typed.map((r) => r.params.get('page[number]'))).toEqual(['1']);
    expect(await highlighted(t)).toBe('Safety');
    drain(t);
  });

  it('hides "Show more" after the last page, even when modules came twice (#561)', async () => {
    const t = await render('/manuals?manual=guide', true);
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t, {});
    await draftReads(t);
    await openMenu(t, 'manual-add');
    await answerChoices(t, SUMMARIES, 52);
    await chooseAdd(t, 'Show more modules');
    // The last page repeats a module of the first (renamed between the two reads): the list
    // holds fewer than the total, and still there is nothing more to read.
    t.http
      .expectOne(isChoices)
      .flush(
        choicesPage(
          2,
          [
            summary('safety', 'Safety', ['en']),
            summary('wiring', 'Wiring', ['en']),
          ],
          52,
        ),
      );
    await t.settle();
    expect(entry('manual-add-show-more')).toBeNull();
    expect(entry('manual-add-more')).toBeNull();
    expect(addOptions()).toEqual(['Safety', 'Wiring', 'New module…']);
    // On the last page the highlight goes to the first module the page added.
    expect(await highlighted(t)).toBe('Wiring');
    drain(t);
  });

  it('blocks New module with the reason: no draft revision, or a role that may not create modules (#386)', async () => {
    const t = await render('/manuals?manual=guide');
    t.answer('/api/manuals/guide', manualDoc);
    await lists(t);
    const page = t.fixture.componentInstance as unknown as Builder;
    expect(page.newModuleState()).toEqual({
      kind: 'disabled',
      reason: 'editor.manuals.blocked.needsChangeSet',
    });
    TestBed.inject(MeService).set({
      id: 'reader',
      kind: 'user',
      name: 'reader',
      role: '',
      permissions: new Set(['content.read']),
    });
    expect(page.newModuleState()).toEqual({
      kind: 'disabled',
      reason: 'editor.manuals.add.newNotAllowed',
    });
    await t.settle();
    drain(t);
  });
});
