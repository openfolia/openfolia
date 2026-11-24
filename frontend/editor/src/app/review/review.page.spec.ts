import { HttpRequest, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { ZardAlertDialogService } from '@openfolia/ui/alert-dialog';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { MeService } from '../permissions/me';
import { DemoSession } from '../session/demo-session';
import { ReviewPage } from './review.page';

const ID = '0190a0b0-0000-7000-8000-000000000001';
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

const changeSet = (state = 'in-review', author = 'author') => ({
  type: 'ChangeSet',
  id: ID,
  attributes: {
    title: 'Clearer charging',
    description: null,
    state,
    author: { kind: 'user', id: author },
    baseRef: 'main',
    baseCommit: BASE,
    branch: `change-sets/${ID}`,
    reviewHead: state === 'draft' ? null : HEAD,
    mergeCommit: null,
    createdAt: '2026-11-01T10:00:00Z',
    updatedAt: '2026-11-01T10:00:00Z',
  },
});

/** The list's read: it counts every state too (`meta.counts`, #481). */
const isList = (r: HttpRequest<unknown>) => r.url === '/api/change-sets';

const links = { self: '', first: '', last: '', prev: null, next: null };
const NO_COUNTS = {
  draft: 0,
  'in-review': 0,
  approved: 0,
  merged: 0,
  abandoned: 0,
};
const paged = (data: unknown[], counts = NO_COUNTS) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 20, total: data.length },
    counts,
  },
  links,
});

const review = (approvals: unknown[] = [], lapsed: unknown[] = []) => ({
  required: ['review'],
  granted: [],
  pending: approvals.length > lapsed.length ? [] : ['review'],
  approvals,
  lapsed,
});

const change = {
  type: 'ChangeSetChange',
  id: 'module/en/charging',
  attributes: { subject: { type: 'module', lang: 'en', moduleId: 'charging' } },
  relationships: { changeSet: { data: { type: 'ChangeSet', id: ID } } },
  meta: {
    change: 'changed',
    fields: [],
    blocks: [{ blockId: 'p1', change: 'changed' }],
    unreadable: false,
  },
};

const moduleAt = (text: string) => ({
  data: {
    type: 'Module',
    id: 'en/charging',
    attributes: {
      moduleId: 'charging',
      lang: 'en',
      schemaVersion: 1,
      title: 'Charging',
      moduleType: 'concept',
      facets: {},
      blocks: [
        { type: 'paragraph', id: 'p1', content: [{ type: 'text', text }] },
      ],
    },
    meta: { issues: [], status: { release: null, main: null } },
  },
});

async function render(
  me: { id: string; permissions: string[] } = {
    id: 'reviewer',
    permissions: ['content.read', 'content.read.draft', 'content.review'],
  },
  url = '/review',
) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', component: ReviewPage }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: me.id,
    kind: 'user',
    name: me.id,
    role: '',
    permissions: new Set(me.permissions),
  });
  const http = TestBed.inject(HttpTestingController);
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(ReviewPage);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  return { fixture, http, el, settle, router };
}

/** Answers the reads of a change set chosen from the list, up to its diff. */
async function openChangeSet(
  t: Awaited<ReturnType<typeof render>>,
  state = 'in-review',
  author = 'author',
  standing = review(),
) {
  t.http.expectOne('/api/config').flush({
    data: { attributes: { moduleTypes: [] } },
  });
  const list = t.http.expectOne(isList);
  expect(list.request.params.get('filter[state]')).toBe('in-review');
  list.flush(paged([changeSet(state, author)]));
  await t.settle();
  // The first of the list is chosen.
  expect(t.router.url).toContain(`cs=${ID}`);
  t.http
    .expectOne(`/api/change-sets/${ID}`)
    .flush({ data: changeSet(state, author) });
  await t.settle();
  t.http.expectOne(`/api/change-sets/${ID}/review`).flush({
    data: changeSet(state, author),
    meta: { review: standing },
  });
  const changes = t.http.expectOne(
    (r) => r.url === `/api/change-sets/${ID}/changes`,
  );
  changes.flush({
    ...paged([change]),
    meta: { ...paged([change]).meta, base: BASE, head: HEAD },
  });
  await t.settle();
  const sides = t.http.match((r) => r.url === '/api/modules/en/charging');
  expect(sides.map((r) => r.request.params.get('ref'))).toEqual([BASE, HEAD]);
  sides[0]?.flush(moduleAt('Request it by e-mail.'));
  sides[1]?.flush(moduleAt('Request it in the portal.'));
  await t.settle();
}

const button = (el: HTMLElement, text: string) =>
  [...el.querySelectorAll<HTMLButtonElement>('of-review-panel button')].find(
    (b) => b.textContent?.trim() === text,
  );

describe('ReviewPage', () => {
  it('lists what waits for review and compares the chosen change set word by word', async () => {
    const t = await render();
    await openChangeSet(t);
    const card = t.el.querySelector('of-list-frame a');
    expect(card?.getAttribute('aria-current')).toBe('true');
    expect(card?.textContent).toContain('Clearer charging');
    expect(card?.textContent).toContain('In review');
    const diff = t.el.querySelector('of-module-diff')!;
    // Each item by its title, not its ID, with its state.
    expect(diff.querySelector('h3')?.textContent).toContain('Charging');
    expect(diff.textContent).toContain('Changed');
    expect(diff.querySelector('del')?.textContent).toContain('by e-mail');
    expect(diff.querySelector('ins')?.textContent).toContain('in the portal');
    // Status never by colour alone: the marks are named for screen readers.
    expect(diff.querySelector('ins')?.textContent).toContain('Inserted');
    expect(t.el.textContent).toContain('Waiting for a reviewer');
    // The overview: each changed item with its counts, and a link down to it.
    const overview = t.el.querySelector('[aria-label="Changed items"]');
    expect(overview?.textContent).toContain('Charging');
    expect(overview?.textContent).toContain('~1');
  });

  it('labels a contributor’s change set, from the permissions the API lists for its author (#137)', async () => {
    const t = await render();
    const user = (id: string, permissions: string[]) => ({
      type: 'User',
      id,
      attributes: {
        name: id === 'helper' ? 'A Helper' : id,
        deactivatedAt: null,
      },
      relationships: { roles: { data: [] } },
      meta: { permissions },
    });
    const probe = TestBed.inject(DemoSession).probe();
    t.http
      .expectOne((r) => r.url === '/api/demo/users')
      .flush(
        paged([
          user('helper', ['content.read', 'content.edit']),
          user('author', ['content.read', 'content.edit', 'content.review']),
        ]),
      );
    await probe;
    await openChangeSet(t, 'in-review', 'helper');
    const labels = [...t.el.querySelectorAll('[data-contributor]')];
    // In the list and in the change set's header, beside the author's name.
    expect(labels.map((l) => l.textContent?.trim())).toEqual([
      'Contributor',
      'Contributor',
    ]);
    expect(t.el.querySelector('of-list-frame a')?.textContent).toContain(
      'A Helper',
    );
  });

  it('gives no label to an author who reviews', async () => {
    const t = await render();
    const probe = TestBed.inject(DemoSession).probe();
    t.http
      .expectOne((r) => r.url === '/api/demo/users')
      .flush(
        paged([
          {
            type: 'User',
            id: 'author',
            attributes: { name: 'Author', deactivatedAt: null },
            relationships: { roles: { data: [] } },
            meta: { permissions: ['content.read', 'content.review'] },
          },
        ]),
      );
    await probe;
    await openChangeSet(t);
    expect(t.el.querySelector('[data-contributor]')).toBeNull();
  });

  it('moves through the changes with j and k, saying where it is', async () => {
    const t = await render();
    await openChangeSet(t);
    // Counted where they are drawn, once the page has looked.
    await new Promise((r) => requestAnimationFrame(r));
    await t.settle();
    expect(t.el.textContent).toContain('1 change');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    await t.settle();
    const current = t.el.querySelector('[data-current]');
    expect(current?.textContent).toContain('in the portal');
    expect(document.activeElement).toBe(current);
    expect(t.el.textContent).toContain('1 of 1');
    // Never while typing.
    const box = t.el.querySelector('textarea')!;
    box.focus();
    box.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', bubbles: true }),
    );
    await t.settle();
    expect(t.el.querySelector('[data-current]')).toBe(current);
    // Another view draws other changes: the count starts again.
    [...t.el.querySelectorAll<HTMLInputElement>('of-segmented input')]
      .find((i) => i.value === 'rendered')
      ?.click();
    await t.settle();
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
    await t.settle();
    expect(
      t.el.querySelector('[aria-live=polite].tabular-nums')?.textContent,
    ).not.toContain(' of ');
    expect(t.el.querySelector('[data-current]')).toBeNull();
  });

  it('starts a thread on the change moved to with c', async () => {
    const t = await render();
    await openChangeSet(t);
    await new Promise((r) => requestAnimationFrame(r));
    await t.settle();
    // Nothing to comment on before a change is moved to.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    await t.settle();
    expect(t.el.querySelector('[data-slot=composer]')).toBeNull();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
    await t.settle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'c' }));
    await t.settle();
    const composer = t.el.querySelector('[data-slot=composer]');
    expect(composer?.closest('[data-current]')).not.toBeNull();
    expect(document.activeElement).toBe(composer?.querySelector('textarea'));
  });

  it('approves at once, and takes it back with a Retry toast when refused', async () => {
    const t = await render();
    await openChangeSet(t);
    const toast = TestBed.inject(ToastService);
    button(t.el, 'Approve')?.click();
    await t.settle();
    // Eager: shown approved before the API answers.
    expect(t.el.textContent).toContain('Approved by reviewer');
    const post = t.http.expectOne(`/api/change-sets/${ID}/approve`);
    expect(post.request.method).toBe('POST');
    post.flush(
      {
        errors: [
          {
            status: '503',
            title: 'Unavailable',
            code: 'database-timeout',
          },
        ],
      },
      { status: 503, statusText: 'Unavailable' },
    );
    await t.settle();
    expect(t.el.textContent).not.toContain('Approved by reviewer');
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('error');
    expect(shown?.actionLabel).toBeTruthy();
    // What the API knows now is read again.
    t.http.expectOne(`/api/change-sets/${ID}`).flush({ data: changeSet() });
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
    // Another change set chosen since: Retry shows the one that failed, acting on nothing.
    const other = '0190a0b0-0000-7000-8000-000000000002';
    await t.router.navigateByUrl(`/review?cs=${other}`);
    await t.settle();
    shown?.onAction?.();
    await t.settle();
    t.http.expectNone((r) => r.method === 'POST');
    expect(t.router.url).toContain(`cs=${ID}`);
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('records a successful approval as the API answers it', async () => {
    const t = await render();
    await openChangeSet(t);
    button(t.el, 'Approve')?.click();
    await t.settle();
    t.http.expectOne(`/api/change-sets/${ID}/approve`).flush({
      data: changeSet('approved'),
      meta: {
        review: {
          ...review([
            {
              requirement: 'review',
              approver: { kind: 'user', id: 'reviewer' },
              head: HEAD,
              at: '2026-11-01T11:00:00Z',
            },
          ]),
          granted: ['review'],
        },
      },
    });
    await t.settle();
    expect(t.el.textContent).toContain('Approved by reviewer');
    expect(t.el.textContent).toContain('Ready to merge into main');
    expect(TestBed.inject(ToastService).toasts().at(-1)?.kind).toBe('success');
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('keeps the approval when a read begun on a switch meanwhile answers with the state before it (#633)', async () => {
    const t = await render();
    await openChangeSet(t);
    button(t.el, 'Approve')?.click();
    await t.settle();
    const post = t.http.expectOne(`/api/change-sets/${ID}/approve`);
    // Another person acts now, while the approval is on its way: the change set is read again
    // for them, and the API reads it before the approval went through.
    TestBed.inject(MeService).set({
      id: 'publisher',
      kind: 'user',
      name: 'publisher',
      role: '',
      permissions: new Set([
        'content.read',
        'content.read.draft',
        'content.review',
        'release.publish',
      ]),
    });
    await t.settle();
    const staleRead = t.http.expectOne(`/api/change-sets/${ID}`);
    const staleReview = t.http.expectOne(`/api/change-sets/${ID}/review`);
    const approval = {
      requirement: 'review',
      approver: { kind: 'user', id: 'reviewer' },
      head: HEAD,
      at: '2026-11-01T11:00:00Z',
    };
    post.flush({
      data: changeSet('approved'),
      meta: { review: { ...review([approval]), granted: ['review'] } },
    });
    await t.settle();
    staleRead.flush({ data: changeSet('in-review') });
    staleReview.flush({
      data: changeSet('in-review'),
      meta: { review: review() },
    });
    await t.settle();
    // The approval's answer is newer than that read: it stays, and what the person acting now
    // sees is read again, after it.
    const merge = () =>
      [
        ...t.el.querySelectorAll<HTMLButtonElement>('of-review-panel button'),
      ].find((b) => b.textContent?.trim().startsWith('Merge'));
    expect(merge()).toBeDefined();
    expect(merge()?.getAttribute('aria-disabled')).not.toBe('true');
    t.http
      .expectOne(`/api/change-sets/${ID}`)
      .flush({ data: changeSet('approved') });
    t.http.expectOne(`/api/change-sets/${ID}/review`).flush({
      data: changeSet('approved'),
      meta: { review: { ...review([approval]), granted: ['review'] } },
    });
    await t.settle();
    expect(merge()?.getAttribute('aria-disabled')).not.toBe('true');
    expect(t.el.textContent).toContain('Approved by reviewer');
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('shows another change set chosen while an approval is on its way, once it is read', async () => {
    const t = await render();
    await openChangeSet(t);
    button(t.el, 'Approve')?.click();
    await t.settle();
    const post = t.http.expectOne(`/api/change-sets/${ID}/approve`);
    const other = '0190a0b0-0000-7000-8000-000000000002';
    await t.router.navigateByUrl(`/review?cs=${other}`);
    await t.settle();
    const read = t.http.expectOne(`/api/change-sets/${other}`);
    const standing = t.http.expectOne(`/api/change-sets/${other}/review`);
    post.flush({
      data: changeSet('approved'),
      meta: { review: { ...review(), pending: [], granted: ['review'] } },
    });
    await t.settle();
    // Its read stays the one that counts: the approved one is not read again over it.
    t.http.expectNone(`/api/change-sets/${ID}`);
    const theOther = {
      ...changeSet(),
      id: other,
      attributes: { ...changeSet().attributes, title: 'Shorter intervals' },
    };
    read.flush({ data: theOther });
    standing.flush({ data: theOther, meta: { review: review() } });
    await t.settle();
    expect(t.el.querySelector('h2')?.textContent).toContain(
      'Shorter intervals',
    );
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('names an approval that no longer counts, and still waits for the review', async () => {
    const t = await render();
    const gone = {
      requirement: 'review',
      approver: { kind: 'user', id: 'former' },
      head: HEAD,
      at: '2026-11-01T11:00:00Z',
    };
    await openChangeSet(t, 'in-review', 'author', review([gone], [gone]));
    expect(t.el.textContent).toContain(
      'Approved by former, which no longer counts',
    );
    expect(button(t.el, 'Approve')?.getAttribute('aria-disabled')).not.toBe(
      'true',
    );
  });

  it('never lets the author review their own change set, and asks for a comment to request changes', async () => {
    const t = await render({
      id: 'author',
      permissions: [
        'content.read',
        'content.read.draft',
        'content.edit',
        'content.review',
      ],
    });
    await openChangeSet(t, 'in-review', 'author');
    const approve = button(t.el, 'Approve');
    expect(approve?.getAttribute('aria-disabled')).toBe('true');
    expect(approve?.getAttribute('aria-description')).toContain(
      'someone else reviews it',
    );
    approve?.click();
    await t.settle();
    t.http.expectNone(`/api/change-sets/${ID}/approve`);
    expect(button(t.el, 'Request changes')?.getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('has "Show in audit log" in the panel for an admin, with the change set preset', async () => {
    const t = await render({
      id: 'admin',
      permissions: ['content.read', 'content.read.draft', 'admin.roles'],
    });
    await openChangeSet(t);
    const navigate = vi.spyOn(t.router, 'navigate').mockResolvedValue(true);
    t.el
      .querySelector<HTMLButtonElement>('[data-slot="review-actions"]')
      ?.click();
    await t.settle();
    document.querySelector<HTMLElement>('[data-slot="review-audit"]')?.click();
    expect(navigate).toHaveBeenCalledWith(['/admin', 'audit'], {
      queryParams: { type: 'change-set', id: ID },
    });
  });

  it('hides what the role can never do', async () => {
    const t = await render({
      id: 'reader',
      permissions: ['content.read', 'content.read.draft'],
    });
    await openChangeSet(t);
    expect(t.el.querySelector('of-review-panel textarea')).toBeNull();
    expect(button(t.el, 'Approve')).toBeUndefined();
    // Only an admin reads the audit log.
    expect(t.el.querySelector('[data-slot="review-actions"]')).toBeNull();
  });

  it('keeps the diff view in the address and ignores what is not valid there', async () => {
    const t = await render(
      undefined,
      `/review?cs=${ID}&diff=side-by-side&page=-3&size=7&module=../x&lang=en`,
    );
    await openChangeSet(t);
    const diff = t.el.querySelector('of-module-diff')!;
    // Side by side: the two versions under their own headings.
    expect(diff.textContent).toContain('Before');
    expect(diff.textContent).toContain('After');
    const list = t.http.match(() => true);
    list.forEach((r) => r.flush(paged([])));
    // Inline, the default, is left out of the address; choosing it is a history entry.
    const inline = [
      ...t.el.querySelectorAll<HTMLInputElement>('of-segmented input'),
    ].find((i) => i.value === 'inline');
    inline?.click();
    await t.settle();
    expect(t.router.url).not.toContain('diff=');
    expect(t.router.url).toContain(`cs=${ID}`);
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('switches the view with its tabs and says what draws the same in every view (#452)', async () => {
    const t = await render({
      id: 'admin',
      permissions: ['content.read', 'content.read.draft', 'content.review'],
    });
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http.expectOne(isList).flush(paged([changeSet('draft')]));
    await t.settle();
    t.http
      .expectOne(`/api/change-sets/${ID}`)
      .flush({ data: changeSet('draft') });
    await t.settle();
    t.http.expectOne(`/api/change-sets/${ID}/review`).flush({
      data: changeSet('draft'),
      meta: { review: review() },
    });
    // The configuration comes first, as the API lists it: a reviewer sees it before any module.
    const config = {
      type: 'ChangeSetChange',
      id: 'config',
      attributes: { subject: { type: 'config' } },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: ID } } },
      meta: {
        change: 'changed',
        fields: ['codeLanguages'],
        blocks: [],
        unreadable: false,
      },
    };
    t.http
      .expectOne((r) => r.url === `/api/change-sets/${ID}/changes`)
      .flush({
        ...paged([config, change]),
        meta: { ...paged([config, change]).meta, base: BASE, head: HEAD },
      });
    await t.settle();
    const sides = t.http.match((r) => r.url === '/api/modules/en/charging');
    sides[0]?.flush(moduleAt('Request it by e-mail.'));
    sides[1]?.flush(moduleAt('Request it in the portal.'));
    await t.settle();
    t.http
      .match((r) => r.url === `/api/change-sets/${ID}/comments`)
      .forEach((r) => r.flush(paged([])));
    await t.settle();
    const tab = (value: string) =>
      [...t.el.querySelectorAll<HTMLInputElement>('of-segmented input')].find(
        (i) => i.value === value,
      )!;
    const note = () =>
      t.el.querySelector('of-project-file-diff [data-slot=same-every-view]');
    const module = () => t.el.querySelector('of-module-diff')!;
    // Inline: nothing to explain.
    expect(note()).toBeNull();
    expect(module().textContent).not.toContain('Before');

    tab('side').click();
    await t.settle();
    expect(t.router.url).toContain('diff=side-by-side');
    expect(module().textContent).toContain('Before');
    expect(module().textContent).toContain('After');
    // The configuration looks as it did: it says why, so the switch is not taken for broken.
    expect(note()?.textContent).toContain('the same in every view');

    tab('inline').click();
    await t.settle();
    expect(t.router.url).not.toContain('diff=');
    expect(module().textContent).not.toContain('Before');
    expect(note()).toBeNull();
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('shows no view switch and no legend when the revision changes nothing against main (#854)', async () => {
    const t = await render();
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http.expectOne(isList).flush(paged([changeSet()]));
    await t.settle();
    t.http.expectOne(`/api/change-sets/${ID}`).flush({ data: changeSet() });
    await t.settle();
    t.http.expectOne(`/api/change-sets/${ID}/review`).flush({
      data: changeSet(),
      meta: { review: review() },
    });
    t.http
      .expectOne((r) => r.url === `/api/change-sets/${ID}/changes`)
      .flush({
        ...paged([]),
        meta: { ...paged([]).meta, base: BASE, head: HEAD },
      });
    await t.settle();
    expect(t.el.querySelector('section [data-state="empty"]')).not.toBeNull();
    expect(t.el.querySelector('section of-segmented')).toBeNull();
    expect(
      t.el.querySelector('section [aria-label="What the marks mean"]'),
    ).toBeNull();
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
  });

  it('gives the empty list the whole width when there is nothing to choose', async () => {
    const t = await render();
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http.expectOne(isList).flush(paged([]));
    await t.settle();
    const frame = t.el.querySelector('of-list-frame')!;
    expect(frame.textContent).toContain('Nothing is waiting for review');
    expect(frame.classList).not.toContain('xl:w-[16.25rem]');
  });

  it('shows the empty list on a narrow screen when there is nothing to choose', async () => {
    const t = await render();
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http.expectOne(isList).flush(paged([]));
    await t.settle();
    // Below `xl` one pane shows at a time: with nothing to choose, it is the list.
    const frame = t.el.querySelector('of-list-frame')!;
    expect(frame.textContent).toContain('Nothing is waiting for review');
    expect(frame.classList).not.toContain('max-xl:hidden');
    // And no switcher to panes that would show nothing.
    expect(t.el.querySelector('of-segmented.xl\\:hidden')).toBeNull();
  });

  it('keeps the empty list shown while another filter loads', async () => {
    const t = await render();
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http.expectOne(isList).flush(paged([]));
    await t.settle();
    const approved = [
      ...t.el.querySelectorAll<HTMLInputElement>(
        'of-page-header of-segmented input',
      ),
    ].find((i) => i.value === 'approved')!;
    approved.click();
    await t.settle();
    // The new filter's read is still pending: the last answer stands, nothing flickers.
    const pending = t.http.expectOne(isList);
    expect(pending.request.params.get('filter[state]')).toBe('approved');
    expect(t.el.querySelector('of-list-frame')?.classList).not.toContain(
      'max-xl:hidden',
    );
    expect(t.el.querySelector('of-segmented.xl\\:hidden')).toBeNull();
    pending.flush(paged([]));
    await t.settle();
    expect(t.el.querySelector('of-list-frame')?.textContent).toContain(
      'No approved revisions',
    );
  });

  it('shows the pane switcher and the chosen pane once there is something to choose', async () => {
    const t = await render();
    await openChangeSet(t);
    expect(t.el.querySelector('of-segmented.xl\\:hidden')).not.toBeNull();
    // The default pane is the changes, so the list hides below `xl`.
    expect(t.el.querySelector('of-list-frame')?.classList).toContain(
      'max-xl:hidden',
    );
  });

  it('keeps the list a side column once there is something to choose', async () => {
    const t = await render();
    await openChangeSet(t);
    const frame = t.el.querySelector('of-list-frame')!;
    expect(frame.classList).toContain('xl:w-[16.25rem]');
  });

  it('counts what each filter holds, so an empty one does not hide the others', async () => {
    const t = await render();
    t.http.expectOne('/api/config').flush({
      data: { attributes: { moduleTypes: [] } },
    });
    t.http
      .expectOne(isList)
      .flush(paged([], { ...NO_COUNTS, approved: 2, draft: 5, merged: 9 }));
    await t.settle();
    // The list's answer counts them all: no read per state (#481).
    expect(t.http.match(isList)).toEqual([]);
    const counts = [
      ...t.el.querySelectorAll('of-page-header [data-slot=segmented-count]'),
    ].map((c) => c.textContent?.trim());
    expect(counts).toEqual(['0', '2', '5']);
  });

  it('shows the change set’s failure with a retry', async () => {
    const t = await render();
    t.http
      .expectOne('/api/config')
      .flush({ data: { attributes: { moduleTypes: [] } } });
    t.http.expectOne(isList).flush(paged([changeSet()]));
    await t.settle();
    t.http.expectOne(`/api/change-sets/${ID}`).flush(
      {
        errors: [
          {
            status: '503',
            title: 'Unavailable',
            code: 'database-unavailable',
          },
        ],
      },
      { status: 503, statusText: 'Unavailable' },
    );
    t.http.match(() => true).forEach((r) => r.flush(paged([])));
    await t.settle();
    expect(t.el.querySelector('of-error-state')).toBeTruthy();
  });
});

describe('ReviewPage: tidying a change set (#267)', () => {
  const author = {
    id: 'author',
    permissions: ['content.read', 'content.read.draft', 'content.edit'],
  };
  const takeOut = (el: HTMLElement) =>
    [...el.querySelectorAll<HTMLButtonElement>('of-module-diff button')].find(
      (b) => b.textContent?.trim() === 'Take out of this revision',
    );

  it('takes a module out after a confirm naming it and what is lost', async () => {
    const t = await render(author);
    await openChangeSet(t, 'draft');
    const dialogs = TestBed.inject(ZardAlertDialogService);
    let asked: Parameters<ZardAlertDialogService['confirm']>[0] | undefined;
    vi.spyOn(dialogs, 'confirm').mockImplementation((config) => {
      asked = config;
      return undefined as never;
    });
    const button = takeOut(t.el);
    expect(button).toBeTruthy();
    button?.click();
    expect(asked?.zTitle).toBe('Take “Charging” out of this revision?');
    expect(asked?.zDescription).toContain('goes back to how it is on main');
    expect(asked?.zOkDestructive).toBe(true);

    (asked?.zOnOk as () => void)();
    await t.settle();
    // Straight to the revert; its lock taken again only when the change set lost it.
    const subject = { type: 'module', lang: 'en', moduleId: 'charging' };
    t.http.expectOne(`/api/change-sets/${ID}/reverts`).flush(
      {
        errors: [
          {
            status: '409',
            title: 'Conflict',
            code: 'lock-required',
            detail: '',
            meta: { subject },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await t.settle();
    const lock = t.http.expectOne(`/api/change-sets/${ID}/locks`);
    expect(lock.request.body).toEqual({
      data: {
        type: 'Lock',
        attributes: {
          subject: { type: 'module', lang: 'en', moduleId: 'charging' },
        },
      },
    });
    lock.flush({ data: {} });
    await t.settle();
    const revert = t.http.expectOne(`/api/change-sets/${ID}/reverts`);
    expect(revert.request.body).toEqual({
      data: {
        type: 'Revert',
        attributes: {
          subjects: [{ type: 'module', lang: 'en', moduleId: 'charging' }],
        },
      },
    });
    revert.flush({
      meta: {
        commit: HEAD,
        head: HEAD,
        restored: [{ type: 'module', lang: 'en', moduleId: 'charging' }],
        deleted: [],
        discarded: [],
      },
    });
    await t.settle();
    expect(
      TestBed.inject(ToastService)
        .toasts()
        .map((x) => String(x.message)),
    ).toHaveLength(1);
    // The diff is read again: what is left.
    t.http
      .expectOne((r) => r.url === `/api/change-sets/${ID}/changes`)
      .flush({
        ...paged([]),
        meta: { ...paged([]).meta, base: BASE, head: HEAD },
      });
    await t.settle();
    expect(t.el.querySelector('of-module-diff')).toBeNull();
  });

  it('offers no take-out to a reviewer, nor once it is submitted', async () => {
    const t = await render();
    await openChangeSet(t, 'draft');
    expect(takeOut(t.el)).toBeUndefined();
    const u = await (async () => {
      TestBed.resetTestingModule();
      return render(author);
    })();
    await openChangeSet(u, 'in-review');
    expect(takeOut(u.el)).toBeUndefined();
  });

  it('renames it in the panel: the new title at once, Escape leaves it', async () => {
    const t = await render(author);
    await openChangeSet(t, 'draft');
    // The panel as it is now: read again after every step, never kept from before one.
    const panel = () => t.el.querySelector('of-review-panel') as HTMLElement;
    button(t.el, 'Rename')?.click();
    await t.settle();
    const input = panel().querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('Clearer charging');
    // The form's own Escape handler leaves it (an editor's drag left on the window once took
    // this Escape first: #333).
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await t.settle();
    expect(panel().querySelector('input')).toBeNull();

    button(t.el, 'Rename')?.click();
    await t.settle();
    const field = panel().querySelector('input') as HTMLInputElement;
    field.value = 'Charging, clearer';
    field.dispatchEvent(new Event('input'));
    await t.settle();
    (panel().querySelector('button[type=submit]') as HTMLButtonElement).click();
    await t.settle();
    expect(t.el.querySelector('section h2')?.textContent).toContain(
      'Charging, clearer',
    );
    const patch = t.http.expectOne(`/api/change-sets/${ID}`);
    expect(patch.request.method).toBe('PATCH');
    expect(patch.request.body).toMatchObject({
      data: { id: ID, attributes: { title: 'Charging, clearer' } },
    });
    const renamed = changeSet('draft');
    renamed.attributes.title = 'Charging, clearer';
    patch.flush({ data: renamed });
    await t.settle();
    expect(t.el.textContent).toContain('Charging, clearer');
  });
});
