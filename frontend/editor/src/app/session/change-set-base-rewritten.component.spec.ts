import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetBaseRewrittenComponent } from './change-set-base-rewritten.component';
import { ChangeSetConflictsComponent } from './change-set-conflicts.component';
import { ChangeSetMove } from './change-set-move';
import { ChangeSetUpdate } from './change-set-update';
import { ChangeSetUpdateComponent } from './change-set-update.component';

const tick = () => new Promise((resolve) => setTimeout(resolve));
const charging = { type: 'module', lang: 'en', moduleId: 'charging' };

const changeSet = (id: string, base: 'current' | 'rewritten') => ({
  data: {
    type: 'ChangeSet',
    id,
    attributes: {
      title: 'Charging',
      description: null,
      state: 'draft',
      author: { kind: 'user', id: 'a' },
      baseRef: 'main',
      baseCommit: 'c',
      branch: `change-sets/${id}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    meta: {
      branchMissing: false,
      behind: base === 'rewritten' ? null : 0,
      base: { state: base },
    },
  },
});
const about = {
  data: {
    type: 'About',
    id: 'about',
    attributes: {
      license: 'AGPL-3.0-only',
      licenseUrl: 'https://www.gnu.org/licenses/agpl-3.0.html',
      sourceUrl: null,
      docsUrl: 'https://docs.example.org/',
    },
  },
};
const rebased = (conflicts: object[]) => ({
  ...changeSet('cs2', 'current'),
  meta: {
    rebase: {
      from: 'cs1',
      commit: conflicts.length === 0 ? 'n' : null,
      applied: conflicts.length === 0 ? 1 : 0,
      conflicts,
      total: conflicts.length,
    },
  },
});
const list = (ids: readonly string[]) => ({
  data: ids.map((id) => changeSet(id, 'current').data),
  meta: { page: { currentPage: 1, lastPage: 1, size: 100, total: ids.length } },
  links: { self: '', first: '', last: '' },
});

@Component({
  imports: [
    ChangeSetBaseRewrittenComponent,
    ChangeSetUpdateComponent,
    ChangeSetConflictsComponent,
  ],
  template: `<of-change-set-base-rewritten
      changeSetId="cs1"
      title="Charging"
      state="draft"
      [authorId]="author"
    />
    <of-change-set-update
      changeSetId="cs1"
      title="Charging"
      state="draft"
      authorId="a"
    />
    <of-change-set-conflicts />`,
})
class Host {
  author = 'a';
}

function setup(
  permissions = ['content.edit', 'content.read.draft'],
  author = 'a',
) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideRouter([]),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'a',
    kind: 'user',
    name: 'A',
    role: '',
    permissions: new Set(permissions),
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.author = author;
  document.body.appendChild(fixture.nativeElement);
  return { http, fixture };
}

const notice = () =>
  document.querySelector<HTMLElement>(
    '[data-testid=change-set-base-rewritten]',
  );
const moveButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid=change-set-move]');
const updateButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid=change-set-update]');
const isRead = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets/cs1';
const isRebase = (r: { url: string; method: string }) =>
  r.method === 'POST' && r.url === '/api/change-sets/cs1/rebase';
const isList = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets';
const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
  await tick();
  await fixture.whenStable();
};

describe('ChangeSetBaseRewrittenComponent', () => {
  afterEach(() => document.body.replaceChildren());

  it('says the base was rewritten on open, links the guide, and blocks the update with the reason', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    // One read serves both: the notice and the update button ask the same service.
    http.expectOne(isRead).flush(changeSet('cs1', 'rewritten'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);

    expect(notice()?.textContent).toContain(
      'The main branch was replaced since this revision started',
    );
    expect(moveButton()?.textContent).toContain(
      'Move my changes onto the current main',
    );
    const link = document.querySelector<HTMLAnchorElement>(
      '[data-testid=change-set-rewritten-learn-more]',
    );
    expect(link?.href).toBe(
      'https://docs.example.org/guide/change-sets/base-rewritten',
    );
    expect(link?.rel).toBe('noopener noreferrer');
    expect(link?.target).toBe('_blank');
    expect(updateButton()?.getAttribute('aria-disabled')).toBe('true');
    http.verify();
  });

  it('says nothing for a change set whose base is current', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'current'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);
    expect(notice()).toBeNull();
  });

  it('moves the changes, says review starts again, and swaps the session to the new change set', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'rewritten'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);

    const success = vi.spyOn(TestBed.inject(ToastService), 'success');
    moveButton()?.click();
    await settle(fixture);
    expect(moveButton()?.getAttribute('aria-busy')).toBe('true');
    http.expectOne(isRebase).flush(rebased([]));
    await settle(fixture);
    expect(success).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'editor.changeSet.move.done',
        params: expect.objectContaining({ ref: 'main' }),
      }),
    );
    expect(TestBed.inject(ChangeSetMove).moved()).toEqual({
      from: 'cs1',
      to: 'cs2',
    });
    http.match(isList).forEach((r) => r.flush(list(['cs2'])));
    await settle(fixture);
    expect(
      document.querySelector('[data-testid=change-set-move-conflicts]'),
    ).toBeNull();
  });

  it('lists what it could not carry over, with the blocks to apply again, until Done', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'rewritten'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);

    moveButton()?.click();
    await settle(fixture);
    http.expectOne(isRebase).flush(
      rebased([
        {
          path: 'modules/en/charging.adoc',
          subject: charging,
          kinds: ['contents'],
          blockIds: ['p1', 'p2'],
        },
      ]),
    );
    http.match(isList).forEach((r) => r.flush(list(['cs2'])));
    await settle(fixture);
    const left = document.querySelector(
      '[data-testid=change-set-move-conflicts]',
    );
    expect(left?.textContent).toContain('charging (en)');
    expect(left?.textContent).toContain('changed on main too');
    expect(left?.textContent).toContain('2 blocks to apply');

    document
      .querySelector<HTMLButtonElement>('[data-testid=change-set-move-done]')
      ?.click();
    await settle(fixture);
    expect(TestBed.inject(ChangeSetMove).conflicts()).toBeNull();
  });

  it('offers the move again, in the same words, when a refusal says the base was rewritten', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'current'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);
    expect(notice()).toBeNull();

    const error = vi.spyOn(TestBed.inject(ToastService), 'error');
    TestBed.inject(ChangeSetUpdate).know('cs1', 0, 'main', true);
    TestBed.inject(ChangeSetUpdate).offerMove({
      id: 'cs1',
      title: 'Charging',
      baseRef: 'main',
    });
    await settle(fixture);
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'editor.changeSet.rewritten.refused',
        params: { ref: 'main' },
      }),
      expect.objectContaining({ actionLabel: expect.anything() }),
    );
    expect(notice()).not.toBeNull();
  });

  it('leaves the move out for a reader who may not edit', async () => {
    const { http, fixture } = setup(['content.read.draft']);
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'rewritten'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);
    expect(notice()).not.toBeNull();
    // Without the permission the guard leaves the button out (`hidden`).
    expect(moveButton()?.hidden).toBe(true);
  });

  it('tells someone else it is its author’s to move, offering nothing', async () => {
    const { http, fixture } = setup(
      ['content.edit', 'content.read.draft'],
      'b',
    );
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet('cs1', 'rewritten'));
    http.expectOne('/api/about').flush(about);
    await settle(fixture);
    expect(notice()?.textContent).toContain('its author moves them');
    expect(moveButton()).toBeNull();
  });
});
