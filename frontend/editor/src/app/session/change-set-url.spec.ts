import { Location } from '@angular/common';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';

import { ToastService } from '@openfolia/ui/toast';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetSession } from './change-set-session';
import { ChangeSetUrl, provideChangeSetUrl } from './change-set-url';

const A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const C = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';

const csItem = (id: string) => ({
  type: 'ChangeSet',
  id,
  attributes: {
    title: `T ${id.slice(-1)}`,
    description: null,
    state: 'draft',
    author: { kind: 'user', id: 'a' },
    baseRef: 'main',
    baseCommit: 'c',
    branch: `change-sets/${id}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
});
const csPage = (...ids: string[]) => ({
  data: ids.map(csItem),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: ids.length },
  },
  links: {},
});

@Component({ selector: 'of-blank', template: '' })
class BlankComponent {}

async function setup(stored?: string) {
  if (stored) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({
        id: stored,
        title: 'Stored',
        branch: `change-sets/${stored}`,
      }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: '',
          data: { changeSetParam: 'session' },
          children: [
            { path: 'a', component: BlankComponent },
            { path: 'b', component: BlankComponent },
            {
              path: 'own',
              data: { changeSetParam: 'own' },
              component: BlankComponent,
            },
          ],
        },
        { path: 'outside', component: BlankComponent },
      ]),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideChangeSetUrl(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  const http = TestBed.inject(HttpTestingController);
  const session = TestBed.inject(ChangeSetSession);
  const router = TestBed.inject(Router);
  const location = TestBed.inject(Location);
  const toast = vi.spyOn(TestBed.inject(ToastService), 'show');
  const harness = await RouterTestingHarness.create();
  // Listens to Back and Forward, as the app's first navigation does.
  router.initialNavigation();
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  /** Answers the change-set list for whoever acts now. */
  const list = async (...ids: string[]) => {
    http
      .expectOne((r) => r.method === 'GET' && r.url === '/api/change-sets')
      .flush(csPage(...ids));
    await settle();
  };
  const go = async (url: string) => {
    await harness.navigateByUrl(url);
    await settle();
  };
  return { http, session, router, location, toast, settle, list, go };
}

describe('ChangeSetUrl', () => {
  it('writes the last used change set into an address without one, replacing the entry', async () => {
    const t = await setup(A);
    void t.session.refresh();
    await t.list(A);
    await t.go('/a');
    expect(t.router.url).toBe(`/a?cs=${A}`);
    // Replaced, not added: Back does not land on the address without it.
    expect(t.location.path()).toBe(`/a?cs=${A}`);
  });

  it('leaves none (the released content) out, and drops a value that is not an ID', async () => {
    const t = await setup();
    void t.session.refresh();
    await t.list(A);
    await t.go('/a?cs=..%2F..&x=1');
    expect(t.router.url).toBe('/a?x=1');
    expect(t.session.selected()).toBeNull();
  });

  it('a link chooses its change set: the address wins over the stored one', async () => {
    const t = await setup(A);
    await t.go(`/a?cs=${B}`);
    // Not chosen before this person's list says they may see it.
    expect(t.session.selected()?.id).toBe(A);
    void t.session.refresh();
    await t.list(A, B);
    expect(t.session.selected()?.id).toBe(B);
    expect(t.router.url).toBe(`/a?cs=${B}`);
    expect(TestBed.inject(ReadRef).ref()).toBe(`change-sets/${B}`);
    // This tab keeps it across a reload; the last used one in other tabs is it too.
    expect(sessionStorage.getItem('openfolia.change-set')).toContain(B);
  });

  it('falls back to the released content, with a notice, for a change set the person may not see', async () => {
    const t = await setup(A);
    void t.session.refresh();
    await t.list(A);
    await t.go(`/a?cs=${C}`);
    expect(t.session.selected()).toBeNull();
    expect(t.router.url).toBe('/a');
    expect(t.toast).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'editor.changeSet.notFound' }),
      { kind: 'info' },
    );
    // A link that did not open is not the last used change set.
    expect(localStorage.getItem('openfolia.change-set')).toContain(A);
  });

  it('a choice adds a history entry; Back and Forward follow it, also back to none', async () => {
    const t = await setup();
    void t.session.refresh();
    await t.list(A, B);
    await t.go('/a');
    expect(t.router.url).toBe('/a');
    t.session.choose(A);
    await t.settle();
    expect(t.router.url).toBe(`/a?cs=${A}`);
    t.session.choose(B);
    await t.settle();
    expect(t.router.url).toBe(`/a?cs=${B}`);
    t.location.back();
    await t.settle();
    expect(t.session.selected()?.id).toBe(A);
    expect(t.router.url).toBe(`/a?cs=${A}`);
    // Back to the entry without `cs`: none chosen there, not overwritten by the session's.
    t.location.back();
    await t.settle();
    expect(t.router.url).toBe('/a');
    expect(t.session.selected()).toBeNull();
    t.location.forward();
    await t.settle();
    expect(t.session.selected()?.id).toBe(A);
  });

  it('keeps the change set on a link without it (another screen)', async () => {
    const t = await setup();
    void t.session.refresh();
    await t.list(A);
    t.session.choose(A);
    await t.go('/a');
    await t.go('/b');
    expect(t.router.url).toBe(`/b?cs=${A}`);
  });

  it('after a demo-user switch, chooses the address’s change set only from the new person’s list', async () => {
    const t = await setup();
    void t.session.refresh();
    // The first person may see B.
    await t.list(A, B);
    await t.go('/a');
    t.session.beginSwitch();
    await t.go(`/a?cs=${B}`);
    // Nothing is decided while the switch is unanswered.
    expect(t.session.selected()).toBeNull();
    expect(t.router.url).toBe(`/a?cs=${B}`);
    void t.session.endSwitch(false);
    await t.settle();
    // Still not from the previous person's list (status is loading, the list is theirs).
    expect(t.session.selected()).toBeNull();
    await t.list(A);
    expect(t.session.selected()).toBeNull();
    expect(t.router.url).toBe('/a');
    expect(t.toast).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'editor.changeSet.notFound' }),
      { kind: 'info' },
    );
  });

  it('leaves `cs` alone where it is the screen’s own, and outside the shell', async () => {
    const t = await setup(A);
    void t.session.refresh();
    await t.list(A, B);
    await t.go(`/own?cs=${B}`);
    expect(t.router.url).toBe(`/own?cs=${B}`);
    expect(t.session.selected()?.id).toBe(A);
    await t.go('/outside');
    expect(t.router.url).toBe('/outside');
  });

  it('starts each tab with its own choice, none included', async () => {
    sessionStorage.setItem('openfolia.change-set', 'none');
    const t = await setup(A);
    expect(t.session.selected()).toBeNull();
    void t.session.refresh();
    await t.list(A);
    await t.go('/a');
    expect(t.router.url).toBe('/a');
  });

  it('after a choice made on a screen with its own `cs`, Back follows the address', async () => {
    const t = await setup();
    void t.session.refresh();
    await t.list(A, B, C);
    t.session.choose(A);
    await t.go('/a');
    expect(t.router.url).toBe(`/a?cs=${A}`);
    await t.go(`/own?cs=${B}`);
    t.session.choose(C);
    await t.settle();
    expect(t.router.url).toBe(`/own?cs=${B}`);
    t.location.back();
    await t.settle();
    expect(t.router.url).toBe(`/a?cs=${A}`);
    expect(t.session.selected()?.id).toBe(A);
    // Forward is still there.
    t.location.forward();
    await t.settle();
    expect(t.router.url).toBe(`/own?cs=${B}`);
  });

  it('judges a refused link again for the next person', async () => {
    const t = await setup(A);
    void t.session.refresh();
    await t.list(A);
    await t.go(`/a?cs=${C}`);
    expect(t.session.selected()).toBeNull();
    expect(t.router.url).toBe('/a');
    t.session.beginSwitch();
    void t.session.endSwitch(false);
    await t.settle();
    await t.list(A, C);
    await t.go(`/b?cs=${C}`);
    expect(t.session.selected()?.id).toBe(C);
    expect(t.router.url).toBe(`/b?cs=${C}`);
  });

  it('carries no session `cs` on links to a screen whose `cs` is its own', async () => {
    const t = await setup();
    void t.session.refresh();
    await t.list(A);
    t.session.choose(A);
    const url = TestBed.inject(ChangeSetUrl);
    expect(url.paramsFor('/own')).toEqual({});
    expect(url.paramsFor('/a')).toEqual({ cs: A });
    expect(url.paramsFor(['/', 'a', 'x'])).toEqual({ cs: A });
  });
});
