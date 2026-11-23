import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { ApiClient, ReadRef } from '../api';
import {
  apiErrorInterceptor,
  missingBranchInterceptor,
} from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetBranchMissingComponent } from './change-set-branch-missing.component';
import { ChangeSetSession, PUBLISHED } from './change-set-session';

/** #317: the chosen change set's branch is gone from the content repository. */
const LOST = '00000000-0000-7000-8000-000000000001';
const KEPT = '00000000-0000-7000-8000-000000000002';

const csItem = (id: string, branchMissing: boolean, author = 'a') => ({
  type: 'ChangeSet',
  id,
  attributes: {
    title: id === LOST ? 'Lost branch' : 'Kept branch',
    description: null,
    state: 'draft',
    author: { kind: 'user', id: author },
    baseRef: 'main',
    baseCommit: 'c',
    branch: `change-sets/${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  meta: { branchMissing },
});
const csPage = (...items: ReturnType<typeof csItem>[]) => ({
  data: items,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: items.length },
  },
  links: {},
});
const isList = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets';
const tick = () => new Promise((resolve) => setTimeout(resolve));

async function setUp(options: {
  author?: string;
  permissions?: string[];
  lostMissing?: boolean;
}) {
  localStorage.clear();
  sessionStorage.clear();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([missingBranchInterceptor, apiErrorInterceptor]),
      ),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(options.permissions ?? ['content.edit']),
  });
  const http = TestBed.inject(HttpTestingController);
  const session = TestBed.inject(ChangeSetSession);
  const refresh = session.refresh();
  http
    .expectOne(isList)
    .flush(
      csPage(
        csItem(LOST, options.lostMissing ?? true, options.author),
        csItem(KEPT, false),
      ),
    );
  await refresh;
  session.choose(LOST);
  const fixture = TestBed.createComponent(ChangeSetBranchMissingComponent);
  document.body.appendChild(fixture.nativeElement);
  await fixture.whenStable();
  const el = fixture.nativeElement as HTMLElement;
  const button = (id: string) =>
    el.querySelector<HTMLButtonElement>(`[data-testid=${id}]`);
  return { http, session, fixture, el, button };
}

afterEach(() => document.body.replaceChildren());

describe('ChangeSetBranchMissingComponent', () => {
  it('says the branch is missing, in one message, and leaves the change set', async () => {
    const { session, el, button, fixture } = await setUp({});
    expect(session.branchMissing()).toBe(true);
    expect(el.textContent).toContain(
      'This revision’s branch is missing from the content repository.',
    );
    expect(el.textContent).toContain('“Lost branch” can no longer be read');
    expect(el.querySelector('[role=alert]')).toBeTruthy();
    // Nothing to retry: asking again changes nothing.
    expect(el.textContent).not.toContain('Try again');
    button('change-set-leave')?.click();
    await fixture.whenStable();
    expect(session.value()).toBe(PUBLISHED);
    expect(session.branchMissing()).toBe(false);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
  });

  it('abandons it for its author at once, with Undo; the request goes once the toast ends', async () => {
    const { http, session, button, fixture } = await setUp({});
    const toasts = TestBed.inject(ToastService);
    button('change-set-abandon')?.click();
    await fixture.whenStable();
    // Left at once, out of the list, nothing sent yet.
    expect(session.value()).toBe(PUBLISHED);
    expect(session.options().map((o) => o.id)).toEqual([KEPT]);
    http.expectNone((r) => r.method === 'POST');
    // Undo: back, chosen again, nothing sent.
    const [undo] = toasts.toasts();
    expect(undo?.message).toMatchObject({ key: 'editor.changeSet.abandoned' });
    toasts.runAction(undo?.id ?? -1);
    expect(session.value()).toBe(LOST);
    expect(session.options().map((o) => o.id)).toEqual([LOST, KEPT]);
    http.expectNone((r) => r.method === 'POST');
    // Again, and the toast ends: it is abandoned.
    session.abandon(LOST);
    toasts.dismiss(toasts.toasts()[0]?.id ?? -1);
    const req = http.expectOne(`/api/change-sets/${LOST}/abandon`);
    expect(req.request.method).toBe('POST');
    req.flush({
      data: {
        ...csItem(LOST, true),
        attributes: { ...csItem(LOST, true).attributes, state: 'abandoned' },
      },
    });
    await tick();
    expect(session.options().map((o) => o.id)).toEqual([KEPT]);
    expect(session.value()).toBe(PUBLISHED);
  });

  it('offers abandoning to an admin for another author’s, and to nobody else', async () => {
    const admin = await setUp({
      author: 'someone-else',
      permissions: ['content.edit', 'content.read.draft', 'admin.roles'],
    });
    expect(admin.button('change-set-abandon')).toBeTruthy();
    TestBed.resetTestingModule();
    document.body.replaceChildren();
    const editor = await setUp({
      author: 'someone-else',
      permissions: ['content.edit', 'content.read.draft'],
    });
    expect(editor.button('change-set-abandon')).toBeNull();
    expect(editor.button('change-set-leave')).toBeTruthy();
  });

  it('learns from a read that the chosen branch is gone, even when the list said it was there', async () => {
    const { http, session } = await setUp({ lostMissing: false });
    expect(session.branchMissing()).toBe(false);
    const api = TestBed.inject(ApiClient);
    const read = firstValueFrom(api.get('/modules', {})).catch(() => null);
    const req = http.expectOne((r) => r.url === '/api/modules');
    expect(req.request.params.get('ref')).toBe(`change-sets/${LOST}`);
    req.flush(
      {
        errors: [
          {
            status: '404',
            title: 'Not Found',
            detail: 'gone',
            code: 'change-set-branch-missing',
            meta: { branch: `change-sets/${LOST}` },
          },
        ],
      },
      { status: 404, statusText: 'Not Found' },
    );
    await read;
    expect(session.branchMissing()).toBe(true);
    // Another change set's branch is read as before.
    session.choose(KEPT);
    expect(session.branchMissing()).toBe(false);
  });
});
