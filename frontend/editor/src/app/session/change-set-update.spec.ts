import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { ReadRef } from '../api';
import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ChangeSetConflictsComponent } from './change-set-conflicts.component';
import { ChangeSetUpdate, conflictsOf } from './change-set-update';
import { ChangeSetUpdateComponent } from './change-set-update.component';

const tick = () => new Promise((resolve) => setTimeout(resolve));
const charging = { type: 'module', lang: 'en', moduleId: 'charging' };

const changeSet = (behind: number) => ({
  data: {
    type: 'ChangeSet',
    id: 'cs1',
    attributes: {
      title: 'Charging',
      description: null,
      state: 'draft',
      author: { kind: 'user', id: 'a' },
      baseRef: 'main',
      baseCommit: 'c',
      branch: 'change-sets/cs1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    meta: { behind },
  },
});
const refreshed = (updated: boolean) => ({
  ...changeSet(0),
  meta: {
    refresh: { updated, head: 'h', fastForward: false, savePoint: null },
  },
});

@Component({
  imports: [ChangeSetUpdateComponent, ChangeSetConflictsComponent],
  template: `<of-change-set-update
      changeSetId="cs1"
      title="Charging"
      state="draft"
      [authorId]="author"
    />
    <of-change-set-conflicts />`,
})
class Host {
  author = 'a';
}

function setup(author = 'a') {
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
    permissions: new Set(['content.edit', 'content.read.draft']),
  });
  const http = TestBed.inject(HttpTestingController);
  const fixture = TestBed.createComponent(Host);
  fixture.componentInstance.author = author;
  document.body.appendChild(fixture.nativeElement);
  return { http, fixture };
}

const button = () =>
  document.querySelector<HTMLButtonElement>('[data-testid=change-set-update]');
const isRefresh = (r: { url: string; method: string }) =>
  r.method === 'POST' && r.url === '/api/change-sets/cs1/refresh';
const isRead = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets/cs1';
const isReported = (r: { url: string; method: string }) =>
  r.method === 'GET' && r.url === '/api/change-sets/cs1/refresh-conflicts';
const CHARGING = 'modules/en/charging.adoc';
const OPERATING = 'manuals/operating.yaml';
const operating = { type: 'manual', manualId: 'operating' };

/** The reported conflicts as the API lists them, `saved` ones saved since. */
const reported = (saved: readonly string[]) => {
  const all = [
    { subject: charging, path: CHARGING, id: 'module/en/charging' },
    { subject: operating, path: OPERATING, id: 'manual/operating' },
  ];
  return {
    data: all.map((c) => ({
      type: 'RefreshConflict',
      id: c.id,
      attributes: {
        subject: c.subject,
        path: c.path,
        base: 'b',
        reportedAt: new Date().toISOString(),
        savedAt: saved.includes(c.path) ? new Date().toISOString() : null,
      },
      relationships: {
        changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
      },
    })),
    meta: { page: { currentPage: 1, lastPage: 1, size: 100, total: 2 } },
    links: { self: '', first: '', last: '' },
  };
};

const conflict409 = {
  errors: [
    {
      status: '409',
      title: 'Conflict',
      detail: 'conflicts',
      code: 'refresh-conflict',
      meta: {
        conflicts: [
          { path: CHARGING, subject: charging, kinds: ['contents'] },
          { path: OPERATING, subject: operating, kinds: ['working-copy'] },
        ],
        total: 2,
      },
    },
  ],
};

const again = () =>
  document.querySelector<HTMLButtonElement>(
    '[data-testid=change-set-update-again]',
  );
const rowOf = (path: 'charging' | 'operating') =>
  [
    ...document.querySelectorAll<HTMLLIElement>(
      '[data-testid=change-set-conflicts] li',
    ),
  ].find((li) => li.textContent?.includes(path));
const settle = async (fixture: { whenStable(): Promise<unknown> }) => {
  await tick();
  await fixture.whenStable();
};

describe('ChangeSetUpdateComponent', () => {
  afterEach(() => document.body.replaceChildren());

  it('updates a draft that is behind its base at once, and goes once up to date', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet(2));
    await tick();
    await fixture.whenStable();
    expect(button()?.textContent?.trim()).toBe('Update from main (2 changes)');

    const success = vi.spyOn(TestBed.inject(ToastService), 'success');
    button()?.click();
    await fixture.whenStable();
    const req = http.expectOne(isRefresh);
    // Nothing to keep: no conflict was resolved.
    expect(req.request.body).toEqual({});
    req.flush(refreshed(true));
    await tick();
    await fixture.whenStable();
    expect(success).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'editor.changeSet.update.done',
        params: { title: 'Charging', ref: 'main' },
      }),
    );
    expect(button()).toBeNull();
    expect(
      document.querySelector('[data-testid=change-set-conflicts]'),
    ).toBeNull();
  });

  it('tells the screens reading at its branch that it has a new head, only when it moved (#466)', async () => {
    const { http, fixture } = setup();
    const readRef = TestBed.inject(ReadRef);
    readRef.ref.set('change-sets/cs1');
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet(1));
    await settle(fixture);
    expect(readRef.moves()).toBe(0);

    button()?.click();
    await fixture.whenStable();
    http.expectOne(isRefresh).flush(refreshed(true));
    await settle(fixture);
    expect(readRef.moves()).toBe(1);

    // Up to date already: nothing moved, nothing to read again.
    const updates = TestBed.inject(ChangeSetUpdate);
    const target = { id: 'cs1', title: 'Charging', baseRef: 'main' };
    const upToDate = updates.update(target);
    await tick();
    http.expectOne(isRefresh).flush(refreshed(false));
    expect(await upToDate).toBe(true);
    expect(readRef.moves()).toBe(1);

    // Reads follow another branch: its screens have nothing to read again.
    readRef.ref.set('change-sets/other');
    const other = updates.update(target);
    await tick();
    http.expectOne(isRefresh).flush(refreshed(true));
    expect(await other).toBe(true);
    expect(readRef.moves()).toBe(1);
  });

  it('lists the conflicts, opens the editor on one, and updates again keeping what was saved or chosen', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet(1));
    await settle(fixture);
    button()?.click();
    await fixture.whenStable();
    http
      .expectOne(isRefresh)
      .flush(conflict409, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    // Which were saved since is the API's to say: none yet.
    http.expectOne(isReported).flush(reported([]));
    await settle(fixture);
    const list = document.querySelector('[data-testid=change-set-conflicts]');
    expect(list?.textContent).toContain('charging (en)');
    expect(list?.textContent).toContain('Module');
    expect(list?.textContent).toContain('operating');
    expect(list?.textContent).toContain('unsaved changes');
    expect(button()?.textContent?.trim()).toBe('Resolve conflicts (2)');
    expect(again()?.disabled).toBe(true);

    // Opening one goes to the editor; the button brings the list back, read again.
    const navigate = vi
      .spyOn(TestBed.inject(Router), 'navigate')
      .mockResolvedValue(true);
    list
      ?.querySelector<HTMLButtonElement>('[data-slot=conflict-open]')
      ?.click();
    await fixture.whenStable();
    expect(navigate).toHaveBeenCalledWith(['/content', 'en', 'charging'], {});
    await settle(fixture);
    button()?.click();
    await settle(fixture);
    http.expectOne(isReported).flush(reported([CHARGING]));
    await settle(fixture);
    expect(rowOf('charging')?.dataset['state']).toBe('saved');
    expect(rowOf('charging')?.textContent).toContain('Saved');
    expect(again()?.disabled).toBe(true);

    // The other is kept as it is, by choice; undone, and chosen again.
    const keepMine = () =>
      rowOf('operating')?.querySelector<HTMLButtonElement>(
        '[data-slot=conflict-keep-mine]',
      );
    keepMine()?.click();
    await settle(fixture);
    expect(rowOf('operating')?.textContent).toContain('Keeping your version');
    expect(again()?.disabled).toBe(false);
    rowOf('operating')
      ?.querySelector<HTMLButtonElement>('[data-slot=conflict-undo]')
      ?.click();
    await settle(fixture);
    expect(again()?.disabled).toBe(true);
    keepMine()?.click();
    await settle(fixture);

    again()?.click();
    await fixture.whenStable();
    const sent = http.expectOne(isRefresh);
    expect(sent.request.body).toEqual({
      meta: { keep: [charging], keepMine: [operating] },
    });
    sent.flush(refreshed(true));
    await settle(fixture);
    expect(button()).toBeNull();
  });

  it('marks a file the API finds unsaved as still to resolve', async () => {
    const { http, fixture } = setup();
    await fixture.whenStable();
    http.expectOne(isRead).flush(changeSet(1));
    await settle(fixture);
    button()?.click();
    await fixture.whenStable();
    http
      .expectOne(isRefresh)
      .flush(conflict409, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    http.expectOne(isReported).flush(reported([CHARGING, OPERATING]));
    await settle(fixture);
    expect(again()?.disabled).toBe(false);

    const error = vi.spyOn(TestBed.inject(ToastService), 'error');
    again()?.click();
    await fixture.whenStable();
    const sent = http.expectOne(isRefresh);
    expect(sent.request.body).toEqual({
      meta: { keep: [charging, operating] },
    });
    // The base changed `charging` again meanwhile: the API refuses it.
    sent.flush(
      {
        errors: [
          {
            status: '409',
            title: 'Conflict',
            detail: 'unresolved',
            code: 'refresh-unresolved',
            meta: {
              unresolved: [{ path: CHARGING, subject: charging }],
              total: 1,
            },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle(fixture);
    expect(error).toHaveBeenCalled();
    expect(rowOf('charging')?.dataset['state']).toBe('open');
    expect(rowOf('operating')?.dataset['state']).toBe('saved');
    expect(again()?.disabled).toBe(true);
  });

  it('is not offered on someone else’s change set', async () => {
    const { http, fixture } = setup('b');
    await fixture.whenStable();
    http.expectNone(isRead);
    expect(button()).toBeNull();
  });
});

describe('ChangeSetUpdate and a change of person (#716)', () => {
  const target = { id: 'cs1', title: 'Charging', baseRef: 'main' };
  const person = (id: string) =>
    TestBed.inject(MeService).set({
      id,
      kind: 'user',
      name: id,
      role: '',
      permissions: new Set(['content.edit', 'content.read.draft']),
    });
  function service() {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([apiErrorInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    person('a');
    return {
      update: TestBed.inject(ChangeSetUpdate),
      http: TestBed.inject(HttpTestingController),
    };
  }

  it('forgets the previous person\u2019s conflicts and closes their list', async () => {
    const { update, http } = service();
    const done = update.update(target);
    await tick();
    http
      .expectOne(isRefresh)
      .flush(conflict409, { status: 409, statusText: 'Conflict' });
    expect(await done).toBe(false);
    http.expectOne(isReported).flush(reported([]));
    await tick();
    expect(update.conflicts()?.items).toHaveLength(2);
    expect(update.dialogOpen()).toBe(true);

    person('b');
    TestBed.tick();
    expect(update.conflicts()).toBeNull();
    expect(update.dialogOpen()).toBe(false);
    expect(update.conflictsOf('cs1')).toBeNull();
    http.verify();
  });

  it('opens nothing for an update answered after another person acts', async () => {
    const { update, http } = service();
    const done = update.update(target);
    await tick();
    const refresh = http.expectOne(isRefresh);
    person('b');
    refresh.flush(conflict409, { status: 409, statusText: 'Conflict' });
    expect(await done).toBe(false);
    await tick();
    expect(update.conflicts()).toBeNull();
    expect(update.dialogOpen()).toBe(false);
    // Nothing is read for them about the previous person's update either.
    http.expectNone(isReported);
    expect(TestBed.inject(ToastService).toasts()).toEqual([]);
  });
});

describe('conflictsOf', () => {
  it('keeps the subject of every kind a change set edits, a page design included (#390)', () => {
    const design = { type: 'design', designId: 'product-line' };
    const term = { type: 'term', termId: 'charger' };
    const error = {
      errors: [
        {
          meta: {
            conflicts: [
              {
                path: 'design/product-line.yaml',
                subject: design,
                kinds: ['contents'],
              },
              { path: 'terms/charger.yaml', subject: term, kinds: [] },
              { path: 'other.txt', subject: { type: 'nope' }, kinds: [] },
            ],
          },
        },
      ],
    } as unknown as Parameters<typeof conflictsOf>[0];
    expect(conflictsOf(error)).toEqual([
      {
        path: 'design/product-line.yaml',
        subject: design,
        kinds: ['contents'],
      },
      { path: 'terms/charger.yaml', subject: term, kinds: [] },
      { path: 'other.txt', kinds: [] },
    ]);
  });
});
