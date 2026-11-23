import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import {
  DeleteModuleDialogComponent,
  type DeleteTarget,
} from './delete-module-dialog.component';
import type { DeleteRequest } from './module-deletion';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = <T>(data: T[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length },
  },
  links,
});

const target: DeleteTarget = {
  moduleId: 'charging',
  title: 'Charging',
  languages: ['en', 'de'],
  lang: 'de',
  source: 'en',
  configured: ['en', 'de', 'fr'],
  changeSetId: 'cs1',
  changeSetTitle: 'Trial',
};

/** `GET /modules/en/charging`, used where `usedIn` says (`count`: how many there are in all). */
function moduleDoc(
  usedIn: { kind: 'manual' | 'module'; id: string; title: string }[],
  count = usedIn.length,
) {
  return {
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
        blocks: [],
      },
      meta: {
        issues: [],
        status: { release: null, main: null },
        usage: {
          manuals: usedIn.filter((u) => u.kind === 'manual').length,
          modules: count - usedIn.filter((u) => u.kind === 'manual').length,
        },
        usedIn: usedIn.map((u) => ({ ...u, direct: true })),
      },
    },
  };
}

@Component({
  imports: [DeleteModuleDialogComponent],
  template: `<of-delete-module-dialog
    [target]="target()"
    (confirm)="confirmed.push($event)"
    (closed)="closed = closed + 1"
  />`,
})
class Host {
  readonly target = signal<DeleteTarget | null>(null);
  readonly confirmed: DeleteRequest[] = [];
  closed = 0;
}

async function render() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await fixture.whenStable();
    }
  };
  fixture.componentInstance.target.set(target);
  await settle();
  return { fixture, host: fixture.componentInstance, http, settle };
}

/** The dialog is rendered in an overlay, outside the host. */
const dialog = () => document.querySelector('z-dialog-panel') as HTMLElement;
const confirmButton = () =>
  dialog().querySelector(
    '[data-slot="delete-module-confirm"]',
  ) as HTMLButtonElement;

/** Answers the usage read, in the source language: one manual and one module use it. */
function answerUsage(http: HttpTestingController) {
  http
    .expectOne((r) => r.url === '/api/modules/en/charging')
    .flush(
      moduleDoc([
        { kind: 'manual', id: 'guide', title: 'Operator guide' },
        { kind: 'module', id: 'overview', title: 'Overview' },
      ]),
    );
}

function answerLocks(http: HttpTestingController, holder = 'cs1') {
  for (const req of http.match((r) => r.url === '/api/locks')) {
    req.flush(
      page([
        {
          type: 'Lock',
          id: 'l1',
          attributes: {},
          relationships: { changeSet: { data: { id: holder } } },
        },
      ]),
    );
  }
}

describe('DeleteModuleDialogComponent', () => {
  afterEach(() =>
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove()),
  );

  it('shows where the module is used before it deletes the language open in the editor', async () => {
    const { host, http, settle } = await render();
    // While the uses are read, Delete waits.
    expect(dialog().textContent).toContain('Checking where it is used');
    expect(confirmButton().disabled).toBe(true);
    answerUsage(http);
    answerLocks(http);
    await settle();
    const text = dialog().textContent ?? '';
    expect(text).toContain('Used in 2 places');
    expect(text).toContain('Operator guide');
    expect(text).toContain('Overview');
    expect(text).toContain('the checks then report these uses');
    // The language open in the editor is chosen first.
    expect(confirmButton().textContent).toContain('Delete German version');
    expect(confirmButton().disabled).toBe(false);
    confirmButton().click();
    expect(host.confirmed).toEqual([
      { moduleId: 'charging', title: 'Charging', langs: ['de'], all: false },
    ]);
  });

  it('deletes every language, a working copy of another one included, when chosen', async () => {
    const { host, http, settle } = await render();
    answerUsage(http);
    answerLocks(http);
    await settle();
    (dialog().querySelector('#delete-module-all') as HTMLElement).click();
    await settle();
    // "Every language" checks the locks of each language it deletes.
    const locks = http.match((r) => r.url === '/api/locks');
    expect(locks.map((r) => r.request.params.get('filter[subject]'))).toEqual([
      'module/en/charging',
      'module/de/charging',
      'module/fr/charging',
    ]);
    locks.forEach((r) => r.flush(page([])));
    await settle();
    expect(confirmButton().textContent).toContain('Delete module');
    confirmButton().click();
    expect(host.confirmed).toEqual([
      {
        moduleId: 'charging',
        title: 'Charging',
        langs: ['en', 'de', 'fr'],
        all: true,
      },
    ]);
  });

  it('is blocked, saying why, while another change set holds the lock', async () => {
    const { host, http, settle } = await render();
    answerUsage(http);
    answerLocks(http, 'cs-other');
    await settle();
    expect(dialog().textContent).toContain(
      'Someone else is editing it in another revision',
    );
    expect(confirmButton().disabled).toBe(true);
    confirmButton().click();
    expect(host.confirmed).toEqual([]);
  });

  it('says so when the uses cannot be read, and still lets the module be deleted', async () => {
    const { host, http, settle } = await render();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    answerLocks(http);
    await settle();
    expect(dialog().textContent).toContain(
      'Where it is used could not be read.',
    );
    confirmButton().click();
    expect(host.confirmed.length).toBe(1);
  });

  it('counts every use and says when not all of them are listed', async () => {
    const { http, settle } = await render();
    http
      .expectOne((r) => r.url === '/api/modules/en/charging')
      .flush(
        moduleDoc(
          [{ kind: 'manual', id: 'guide', title: 'Operator guide' }],
          60,
        ),
      );
    answerLocks(http);
    await settle();
    const text = dialog().textContent ?? '';
    expect(text).toContain('Used in 60 places');
    expect(text).toContain('Not every use is listed here');
  });

  it('reads the uses in a language the module has when it has no source-language file', async () => {
    TestBed.resetTestingModule();
    const { http, host, settle } = await render();
    answerUsage(http);
    answerLocks(http);
    host.target.set({ ...target, languages: ['de'], lang: 'de' });
    await settle();
    http
      .expectOne((r) => r.url === '/api/modules/de/charging')
      .flush(moduleDoc([]));
    answerLocks(http);
    await settle();
    expect(dialog().textContent).toContain('Used nowhere');
  });
});
