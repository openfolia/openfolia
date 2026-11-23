import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ToastService } from '@openfolia/ui/toast';

import { API_DEMO_USER, ReadRef } from '../api';
import {
  apiErrorInterceptor,
  demoUserInterceptor,
} from '../api/api-interceptors';
import { MeService, UNCONFIRMED } from '../permissions/me';
import { ChangeSetSession, PUBLISHED } from './change-set-session';
import { DemoSession } from './demo-session';

const usersDoc = (...ids: string[]) => ({
  data: ids.map((id) => ({
    type: 'User',
    id,
    attributes: { name: `Name ${id}` },
    relationships: { roles: { data: [{ type: 'Role', id: 'author' }] } },
    meta: {
      permissions: ['content.read', 'content.read.draft', 'content.edit'],
    },
  })),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: ids.length },
  },
  links: {},
});
const meDoc = (id: string, permissions: string[]) => ({
  data: {
    type: 'Actor',
    id,
    attributes: {
      kind: 'user',
      name: `Name ${id}`,
      roles: [{ id: 'r', name: 'Role R', permissions, scope: {} }],
    },
    meta: {
      permissions: permissions.map((permission) => ({
        permission,
        scopes: [{}],
      })),
    },
  },
});
const csItem = (id: string, state = 'draft', title = `T ${id}`) => ({
  type: 'ChangeSet',
  id,
  attributes: {
    title,
    description: null,
    state,
    author: { kind: 'user', id: 'a' },
    baseRef: 'main',
    baseCommit: 'c',
    branch: `change-sets/${id}`,
    createdAt: new Date(Date.now() + 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
  },
});
const csPage = (...items: ReturnType<typeof csItem>[]) => ({
  data: items,
  meta: {
    page: {
      currentPage: 1,
      lastPage: 1,
      perPage: 200,
      total: items.length,
    },
  },
  links: {},
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(
        withInterceptors([demoUserInterceptor, apiErrorInterceptor]),
      ),
      provideHttpClientTesting(),
      {
        provide: API_DEMO_USER,
        useFactory: () => TestBed.inject(DemoSession).actingAs,
      },
    ],
  });
  return TestBed.inject(HttpTestingController);
}
const tick = () => new Promise((resolve) => setTimeout(resolve));
const isUsers = (r: { url: string }) => r.url === '/api/demo/users';
const isList = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets';

describe('DemoSession', () => {
  it('is off, sends no header and shows no switcher when the API has no demo route', async () => {
    localStorage.setItem('openfolia.demo-user', 'u1');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(
          withInterceptors([demoUserInterceptor, apiErrorInterceptor]),
        ),
        provideHttpClientTesting(),
        {
          provide: API_DEMO_USER,
          useFactory: () => TestBed.inject(DemoSession).actingAs,
        },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(
      {
        errors: [{ status: '404', title: 'x', detail: 'x', code: 'not-found' }],
      },
      { status: 404, statusText: 'Not Found' },
    );
    await probe;
    expect(session.status()).toBe('off');
    expect(session.enabled()).toBe(false);
    expect(session.actingAs()).toBeNull();
    TestBed.inject(MeService)
      .refresh()
      .catch(() => undefined);
    const req = http.expectOne('/api/me');
    expect(req.request.headers.has('X-Ccms-User')).toBe(false);
  });

  it('shows a failure with a retry when it cannot be asked', async () => {
    const http = setup();
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(null, { status: 503, statusText: 'x' });
    await probe;
    expect(session.status()).toBe('failed');
    expect(session.enabled()).toBe(true);
  });

  it('switches at once, then confirms with /me, and the choice is remembered', async () => {
    const http = setup();
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(usersDoc('u1', 'u2'));
    await probe;
    const done = session.switchTo('u2');
    // At once: identity, name and header, before any answer.
    expect(session.userId()).toBe('u2');
    expect(TestBed.inject(MeService).me().name).toBe('Name u2');
    expect(localStorage.getItem('openfolia.demo-user')).toBe('u2');
    const me = http.expectOne('/api/me');
    expect(me.request.headers.get('X-Ccms-User')).toBe('u2');
    me.flush(meDoc('u2', ['content.read']));
    await tick();
    http.expectOne(isList).flush(csPage());
    await done;
    const now = TestBed.inject(MeService).me();
    expect(now.permissions.has('content.read')).toBe(true);
    expect(now.role).toBe('Role R');
  });

  it('rolls back a refused switch and offers a retry in a toast', async () => {
    const http = setup();
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(usersDoc('u1', 'u2'));
    await probe;
    TestBed.inject(MeService).set({
      id: 'u1',
      kind: 'user',
      name: 'Name u1',
      role: 'x',
      permissions: new Set(['content.edit']),
    });
    const done = session.switchTo('u2');
    http.expectOne('/api/me').flush(null, { status: 503, statusText: 'x' });
    await done;
    expect(session.userId()).toBe('u1');
    expect(TestBed.inject(MeService).me().id).toBe('u1');
    const toast = TestBed.inject(ToastService).toasts()[0];
    expect(toast?.kind).toBe('error');
    expect(toast?.actionLabel).toBeDefined();
  });

  it('goes back to the last confirmed person when a quick second switch is refused', async () => {
    const http = setup();
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(usersDoc('u1', 'u2', 'u3'));
    await probe;
    TestBed.inject(MeService).set({
      id: 'u1',
      kind: 'user',
      name: 'Name u1',
      role: 'x',
      permissions: new Set(['content.edit']),
    });
    TestBed.inject(ChangeSetSession).choose(null);
    const first = session.switchTo('u2');
    const second = session.switchTo('u3');
    const [a, b] = http.match('/api/me');
    a?.flush(meDoc('u2', ['content.read']));
    b?.flush(null, { status: 503, statusText: 'x' });
    await Promise.all([first, second]);
    // u3 refused, u2 never confirmed (superseded): back to u1, with u1's permissions.
    expect(session.userId()).toBe('u1');
    expect(TestBed.inject(MeService).me().id).toBe('u1');
    expect(TestBed.inject(MeService).status()).toBe('ready');
  });

  it('forgets a remembered user that is no longer seeded', async () => {
    const http = setup();
    localStorage.setItem('openfolia.demo-user', 'gone');
    const session = TestBed.inject(DemoSession);
    const probe = session.probe();
    http.expectOne(isUsers).flush(usersDoc('u1'));
    await probe;
    expect(session.userId()).toBeNull();
    expect(localStorage.getItem('openfolia.demo-user')).toBeNull();
  });
});

describe('ChangeSetSession', () => {
  it('points reads at the chosen branch and remembers it across a reload', async () => {
    const http = setup();
    TestBed.inject(MeService).set({
      id: 'u1',
      kind: 'user',
      name: 'U',
      role: '',
      permissions: new Set(),
    });
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http
      .expectOne(isList)
      .flush(csPage(csItem('c1'), csItem('c2', 'abandoned')));
    await refresh;
    expect(session.options().map((o) => o.id)).toEqual(['c1']);
    session.choose('c1');
    expect(TestBed.inject(ReadRef).ref()).toBe('change-sets/c1');
    expect(
      JSON.parse(localStorage.getItem('openfolia.change-set') ?? '{}'),
    ).toMatchObject({ id: 'c1' });
    session.choose(PUBLISHED);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    expect(localStorage.getItem('openfolia.change-set')).toBeNull();
  });

  it('drops a remembered choice the person cannot see, with a notice', async () => {
    const http = setup();
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({
        id: '00000000-0000-7000-8000-000000000001',
        title: 'X',
        branch: 'change-sets/00000000-0000-7000-8000-000000000001',
        // Chosen by the person acting (nobody known yet, as at start-up).
        owner: '',
      }),
    );
    const session = TestBed.inject(ChangeSetSession);
    // Not read until the list has confirmed the person may see it.
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await refresh;
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    expect(TestBed.inject(ToastService).toasts()).toHaveLength(1);
  });

  it('starts one eagerly: listed and chosen at once, its branch read once made', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const started = session.start('  New one ');
    expect(session.options()[0]).toMatchObject({
      title: 'New one',
      pending: true,
    });
    expect(session.value()).toBe(session.options()[0]?.id);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    // Its placeholder's ID is no ID to ask the API about (#467).
    expect(session.startedId()).toBeNull();
    const req = http.expectOne('/api/change-sets');
    expect(req.request.method).toBe('POST');
    expect(req.request.headers.get('Content-Type')).toBe(
      'application/vnd.api+json',
    );
    expect(req.request.body).toEqual({
      data: { type: 'ChangeSet', attributes: { title: 'New one' } },
    });
    req.flush({ data: csItem('n1') }, { status: 201, statusText: 'Created' });
    expect(await started).toBe('n1');
    expect(session.value()).toBe('n1');
    expect(session.startedId()).toBe('n1');
    expect(TestBed.inject(ReadRef).ref()).toBe('change-sets/n1');
  });

  it('takes a refused start back; its retry looks for a lost answer before asking again', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    TestBed.inject(MeService).set({
      id: 'a',
      kind: 'user',
      name: 'A',
      role: '',
      permissions: new Set(['content.edit']),
    });
    const started = session.start('Lost');
    http.expectOne('/api/change-sets').flush(null, {
      status: 503,
      statusText: 'x',
    });
    expect(await started).toBeNull();
    expect(session.options()).toEqual([]);
    expect(session.value()).toBe(PUBLISHED);
    const toasts = TestBed.inject(ToastService);
    toasts.runAction(toasts.toasts()[0]?.id ?? -1);
    http.expectOne(isList).flush(csPage(csItem('n9', 'draft', 'Lost')));
    await tick();
    http.expectNone((r) => r.method === 'POST');
    expect(session.value()).toBe('n9');
  });
});

describe('during an unanswered switch', () => {
  async function loaded() {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const read = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1'), csItem('c2')));
    await read;
    session.choose('c1');
    return { http, session };
  }

  it('makes choose, start and refresh no-ops, and keeps no branch read', async () => {
    const { http, session } = await loaded();
    session.beginSwitch();
    expect(session.switching()).toBe(true);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    session.choose('c2');
    expect(session.value()).toBe('c1');
    expect(await session.start('Nope')).toBeNull();
    expect(await session.refresh()).toBe(false);
    http.expectNone('/api/change-sets');
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
  });

  it('answered by a confirmed switch: the new person list is read', async () => {
    const { http, session } = await loaded();
    session.beginSwitch();
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(csPage(csItem('c1')));
    expect(await done).toBe(true);
    expect(TestBed.inject(ReadRef).ref()).toBe('change-sets/c1');
  });

  it('answered by a refusal: only a choice a list had confirmed is read again', async () => {
    const { http, session } = await loaded();
    session.beginSwitch();
    const done = session.endSwitch(true);
    expect(TestBed.inject(ReadRef).ref()).toBe('change-sets/c1');
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await done;

    // A remembered choice no list has confirmed stays unread until one does.
    TestBed.resetTestingModule();
    const http2 = setup();
    const id = '00000000-0000-7000-8000-000000000002';
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id, title: 'R', branch: `change-sets/${id}` }),
    );
    const other = TestBed.inject(ChangeSetSession);
    other.beginSwitch();
    const again = other.endSwitch(true);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    http2.expectOne(isList).flush(csPage(csItem('c1')));
    await again;
  });

  it('treats a switch overtaken by a later one as unanswered', async () => {
    const http = setup();
    const demo = TestBed.inject(DemoSession);
    const probe = demo.probe();
    http.expectOne(isUsers).flush(usersDoc('u1', 'u2'));
    await probe;
    const sets = TestBed.inject(ChangeSetSession);
    const first = demo.switchTo('u1');
    const second = demo.switchTo('u2');
    const [a, b] = http.match('/api/me');
    a?.flush(meDoc('u1', ['content.read']));
    await first;
    // Still unanswered: the later switch has not been confirmed.
    expect(sets.switching()).toBe(true);
    b?.flush(meDoc('u2', ['content.read']));
    await tick();
    http.expectOne(isList).flush(csPage());
    await second;
    expect(sets.switching()).toBe(false);
    expect(TestBed.inject(MeService).me().id).toBe('u2');
  });
});

describe('a change of person (#706)', () => {
  const person = (id: string) =>
    TestBed.inject(MeService).set({
      id,
      kind: 'user',
      name: `Name ${id}`,
      role: '',
      permissions: new Set(['content.read', 'content.read.draft']),
    });
  const titles = (session: ChangeSetSession) =>
    session.options().map((o) => o.title);

  it('offers none of the previous person\u2019s change sets to the next one, and reads theirs', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http
      .expectOne(isList)
      .flush(csPage(csItem('c1', 'draft', 'Only u1 sees this')));
    await first;
    expect(titles(session)).toEqual(['Only u1 sees this']);

    // Signed in as another person in the same tab (a password sign-in after a session ended):
    // nothing of u1's at once, and u2's own list is read without being asked.
    person('u2');
    expect(session.options()).toEqual([]);
    TestBed.tick();
    http.expectOne(isList).flush(csPage(csItem('c2', 'draft', 'Seen by u2')));
    await tick();
    expect(titles(session)).toEqual(['Seen by u2']);
  });

  it('keeps nothing of a list read for the previous person that answers afterwards, nor after a failed read', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    const before = http.expectOne(isList);
    person('u2');
    TestBed.tick();
    // One read at a time: u2's starts when u1's answers.
    before.flush(csPage(csItem('c1', 'draft', 'Only u1 sees this')));
    await tick();
    expect(session.options()).toEqual([]);
    http.expectOne(isList).flush(null, { status: 503, statusText: 'x' });
    expect(await first).toBe(false);
    expect(session.options()).toEqual([]);
    expect(session.status()).toBe('error');
  });

  it('never names another person\u2019s remembered choice, in the list or in a notice', async () => {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({
        id: '00000000-0000-7000-8000-000000000001',
        title: 'Only u1 sees this',
        branch: 'change-sets/00000000-0000-7000-8000-000000000001',
        owner: 'u1',
      }),
    );
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u2');
    expect(session.options()).toEqual([]);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c2', 'draft', 'Seen by u2')));
    await refresh;
    expect(titles(session)).toEqual(['Seen by u2']);
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
  });

  it('takes a list read before /me answered as the person it names, whichever answers first', async () => {
    for (const listFirst of [true, false]) {
      TestBed.resetTestingModule();
      const http = setup();
      const session = TestBed.inject(ChangeSetSession);
      const refresh = session.refresh();
      const list = http.expectOne(isList);
      if (listFirst) {
        list.flush(csPage(csItem('c1')));
        await refresh;
        person('u1');
      } else {
        person('u1');
        TestBed.tick();
        list.flush(csPage(csItem('c1')));
        await refresh;
      }
      TestBed.tick();
      // No second read, and the list is offered.
      http.expectNone(isList);
      expect(titles(session)).toEqual(['T c1']);
      session.choose('c1');
      expect(TestBed.inject(ReadRef).ref()).toBe('change-sets/c1');
    }
  });

  it('drops another person\u2019s remembered choice when they sign in, even when their list cannot be read', async () => {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({
        id: '00000000-0000-7000-8000-000000000001',
        title: 'Only u1 sees this',
        branch: 'change-sets/00000000-0000-7000-8000-000000000001',
        owner: 'u1',
      }),
    );
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    expect(session.selected()?.title).toBe('Only u1 sees this');
    person('u2');
    TestBed.tick();
    expect(session.selected()).toBeNull();
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
    // Their own list cannot be read: nothing of u1's comes back.
    const refresh = session.refresh();
    http.expectOne(isList).flush(null, { status: 503, statusText: 'x' });
    await refresh;
    expect(session.selected()).toBeNull();
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
    expect(localStorage.getItem('openfolia.change-set')).toBeNull();
  });

  it('keeps a remembered choice for whoever sees it in their own list, across a reload', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1')));
    await first;
    session.choose('c1');
    // A switch to u2, who may see it too: the choice stands, now theirs.
    session.beginSwitch();
    person('u2');
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(csPage(csItem('c1')));
    expect(await done).toBe(true);
    expect(session.value()).toBe('c1');
    expect(
      JSON.parse(sessionStorage.getItem('openfolia.change-set') ?? '{}'),
    ).toMatchObject({ id: 'c1', owner: 'u2' });
  });

  it('offers nobody a list read before /me answered once a switch to another begins', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem('c1', 'draft', 'Read as X')));
    await refresh;
    session.beginSwitch();
    TestBed.inject(MeService).show({ id: 'u2', name: 'Name u2', role: '' });
    TestBed.tick();
    expect(session.options()).toEqual([]);
    person('u2');
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(csPage(csItem('c2', 'draft', 'Seen by u2')));
    await done;
    expect(titles(session)).toEqual(['Seen by u2']);
  });
});

describe('a change of person, the remaining cases (#716)', () => {
  const X = '00000000-0000-7000-8000-000000000001';
  const person = (id: string) =>
    TestBed.inject(MeService).set({
      id,
      kind: 'user',
      name: `Name ${id}`,
      role: '',
      permissions: new Set([
        'content.read',
        'content.read.draft',
        'content.edit',
      ]),
    });
  const titles = (session: ChangeSetSession) =>
    session.options().map((o) => o.title);
  const shared = () => localStorage.getItem('openfolia.change-set');

  it('never hands other tabs a choice made before anyone was known, until a person is confirmed', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem(X, 'draft', 'Read as X')));
    await refresh;
    // A link resolved in the start-up race, before `/me` answered.
    session.chooseFromLink(X);
    expect(session.value()).toBe(X);
    expect(shared()).toBeNull();
    person('u1');
    TestBed.tick();
    expect(JSON.parse(shared() ?? '{}')).toMatchObject({ id: X, owner: 'u1' });
  });

  it('gives a choice made before anyone was known to nobody while a switch is unanswered', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    const refresh = session.refresh();
    http.expectOne(isList).flush(csPage(csItem(X, 'draft', 'Read as X')));
    await refresh;
    session.chooseFromLink(X);
    session.beginSwitch();
    TestBed.inject(MeService).show({ id: 'u2', name: 'Name u2', role: '' });
    TestBed.tick();
    expect(session.selected()?.owner).not.toBe('u2');
    expect(titles(session)).toEqual([]);
    // u2's own list decides: they may not see it.
    person('u2');
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(csPage(csItem('c2', 'draft', 'Seen by u2')));
    await done;
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
  });

  it('decides nothing about the choice while another tab’s sign-in is unconfirmed here', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http.expectOne(isList).flush(csPage(csItem(X, 'draft', 'Chosen by u1')));
    await first;
    session.choose(X);
    const stored = shared();
    // Another tab signed someone in: who acts here is not known until `/me` answers.
    TestBed.inject(MeService).show({
      id: `${UNCONFIRMED}1`,
      name: 'Name u1',
      role: '',
    });
    TestBed.tick();
    // Neither dropped for everyone nor read again with a cookie that may be someone else's.
    expect(shared()).toBe(stored);
    http.expectNone(isList);
    // It was u1 again: their choice stands.
    person('u1');
    TestBed.tick();
    expect(session.value()).toBe(X);
    expect(shared()).toBe(stored);
  });

  it('hands other tabs no choice made while another tab’s sign-in is unconfirmed here', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http.expectOne(isList).flush(csPage(csItem(X, 'draft', 'Chosen by u1')));
    await first;
    session.choose(X);
    const stored = shared();
    TestBed.inject(MeService).show({
      id: `${UNCONFIRMED}1`,
      name: 'Name u1',
      role: '',
    });
    TestBed.tick();
    // Neither dropped for the other tabs nor handed to them under a placeholder.
    session.choose(null);
    expect(shared()).toBe(stored);
  });

  it('keeps nothing of the previous person’s choice after a confirmed switch whose list cannot be read', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http
      .expectOne(isList)
      .flush(csPage(csItem(X, 'draft', 'Only u1 sees this')));
    await first;
    session.choose(X);
    session.beginSwitch();
    TestBed.inject(MeService).show({ id: 'u2', name: 'Name u2', role: '' });
    TestBed.tick();
    person('u2');
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(null, { status: 503, statusText: 'x' });
    expect(await done).toBe(false);
    expect(session.selected()).toBeNull();
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ReadRef).ref()).toBeUndefined();
  });

  it('waits for the acting person’s list for a link naming another person’s remembered choice', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const first = session.refresh();
    http
      .expectOne(isList)
      .flush(csPage(csItem(X, 'draft', 'Only u1 sees this')));
    await first;
    session.choose(X);
    session.beginSwitch();
    TestBed.inject(MeService).show({ id: 'u2', name: 'Name u2', role: '' });
    TestBed.tick();
    // A link to the same change set, opened while the switch is unanswered.
    session.chooseFromLink(X);
    expect(session.resolving()).toBe(true);
    person('u2');
    const done = session.endSwitch(false);
    http.expectOne(isList).flush(csPage(csItem('c2', 'draft', 'Seen by u2')));
    await done;
    expect(session.value()).toBe(PUBLISHED);
    expect(session.refusedLink()).toBe(X);
  });

  it('takes nothing of a start that answers after another person signed in, nor names it', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const started = session.start('Only u1 started this');
    const post = http.expectOne((r) => r.method === 'POST');
    // A password sign-in as u2 in the same tab, before the start answers.
    person('u2');
    TestBed.tick();
    post.flush(
      { data: csItem('n1', 'draft', 'Only u1 started this') },
      { status: 201, statusText: 'Created' },
    );
    expect(await started).toBeNull();
    http.match(isList).forEach((r) => r.flush(csPage()));
    await tick();
    expect(titles(session)).toEqual([]);
    expect(session.value()).toBe(PUBLISHED);
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
  });

  it('retries nothing of a failed start for the next person who signs in', async () => {
    const http = setup();
    const session = TestBed.inject(ChangeSetSession);
    person('u1');
    const started = session.start('Only u1 started this');
    http
      .expectOne((r) => r.method === 'POST')
      .flush(null, { status: 503, statusText: 'x' });
    expect(await started).toBeNull();
    const toasts = TestBed.inject(ToastService);
    const failed = toasts.toasts()[0]?.id ?? -1;
    person('u2');
    TestBed.tick();
    http.match(isList).forEach((r) => r.flush(csPage()));
    await tick();
    toasts.runAction(failed);
    await tick();
    http.expectNone(isList);
    http.expectNone((r) => r.method === 'POST');
    expect(titles(session)).toEqual([]);
  });
});
