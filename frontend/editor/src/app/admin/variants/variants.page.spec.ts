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

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { ReadRef } from '../../api';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { provideChangeSetUrl } from '../../session/change-set-url';
import type { ProjectConfig } from '../settings/config-model';
import { CONFIG as BASE } from '../settings/testing/config-fixture';
import { VariantsPage } from './variants.page';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (data: unknown[], total = data.length) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total },
  },
  links,
});

const CONFIG: ProjectConfig = {
  ...BASE,
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
    { id: 'safety', label: 'Safety', restricted: true, snippet: false },
  ],
  variantAttributes: [
    {
      id: 'model',
      label: 'Model',
      kind: 'enum',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
    { id: 'firmware', label: 'Firmware', kind: 'version' },
  ],
};

const USAGES = page([
  {
    type: 'ConfigUsage',
    id: 'variantValue/model/small',
    attributes: { kind: 'variantValue', valueId: 'small', parentId: 'model' },
    meta: { modules: 1, manuals: 1 },
  },
]);
const SMALL_USES = page([
  {
    type: 'VariantUse',
    id: 'manual/operating',
    attributes: {
      kind: 'manual',
      manualId: 'operating',
      title: 'Operating manual',
    },
  },
  {
    type: 'VariantUse',
    id: 'module/charging',
    attributes: {
      kind: 'module',
      moduleId: 'charging',
      title: 'Charging',
      languages: ['de', 'en'],
    },
  },
]);
const SMALL_BUILDS = page([
  {
    type: 'VariantBuild',
    id: 'operating/model=small',
    attributes: { values: { model: 'small' } },
    relationships: { manual: { data: { type: 'Manual', id: 'operating' } } },
    meta: {
      slug: 'model=small',
      label: 'Small',
      manualTitle: 'Operating manual',
    },
  },
]);

async function render(options: { changeSet: boolean; url?: string }) {
  if (options.changeSet) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: CS, title: 'Variants', branch: BRANCH }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'variants',
          component: VariantsPage,
          data: { changeSetParam: 'session' },
        },
        { path: '**', children: [] },
      ]),
      provideChangeSetUrl(),
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  if (options.changeSet) TestBed.inject(ReadRef).ref.set(BRANCH);
  TestBed.inject(MeService).set({
    id: 'admin',
    kind: 'user',
    name: 'Admin',
    role: '',
    permissions: new Set(['content.read', 'content.edit', 'admin.roles']),
  });
  const { RouterTestingHarness } = await import('@angular/router/testing');
  const harness = await RouterTestingHarness.create();
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 0));
      await harness.fixture.whenStable();
    }
  };
  if (options.changeSet) {
    void TestBed.inject(ChangeSetSession).refresh();
    http
      .expectOne((r) => r.url === '/api/change-sets')
      .flush(
        page([
          {
            type: 'ChangeSet',
            id: CS,
            attributes: {
              title: 'Variants',
              state: 'draft',
              branch: BRANCH,
              author: { kind: 'user', id: 'admin' },
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
        ]),
      );
  }
  void harness.navigateByUrl(options.url ?? '/variants');
  await settle();
  return {
    http,
    settle,
    el: () => harness.routeNativeElement as HTMLElement,
  };
}

/** Answers every open request to `url` (a path below `/api`) with `body`. */
function flushAll(
  http: HttpTestingController,
  url: string,
  body: object | ((r: TestRequest) => object),
): number {
  const open = http.match((r) => r.url === `/api${url}`);
  for (const r of open) {
    r.flush(typeof body === 'function' ? body(r) : body);
  }
  return open.length;
}

/** The detail's lists: small is used, the rest not. */
function flushDetail(http: HttpTestingController): void {
  flushAll(http, '/variants/model/usages', (r) =>
    r.request.params.get('filter[value]') === 'small' ? SMALL_USES : page([]),
  );
  flushAll(http, '/variants/matches', (r) =>
    r.request.params.get('when') === 'model in (small)'
      ? SMALL_BUILDS
      : page([]),
  );
}

function workingCopy(http: HttpTestingController): void {
  http.expectOne(`/api/change-sets/${CS}/config/working-copy`).flush({
    data: {
      type: 'WorkingCopy',
      id: `${CS}/config`,
      attributes: {
        subject: { type: 'config' },
        content: CONFIG,
        version: 0,
        baseCommit: 'c0',
      },
      relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
      meta: { saved: false, issues: [] },
    },
  });
  http.expectOne((r) => r.url === '/api/locks').flush(page([]));
}

/** The address's query parameters. */
const query = () => {
  const router = TestBed.inject(Router);
  return router.parseUrl(router.url).queryParams;
};

const button = (root: ParentNode, slot: string) =>
  root.querySelector<HTMLButtonElement>(`[data-slot=${slot}]`);

describe('VariantsPage', () => {
  it('shows the chosen value from the address, read-only outside a change set, with where it is used', async () => {
    const { http, settle, el } = await render({
      changeSet: false,
      url: '/variants?attribute=model&value=small',
    });
    http
      .expectOne((r) => r.url === '/api/config')
      .flush({
        data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
      });
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();
    expect(el().textContent).toContain(
      'Choose or start a revision to change the project settings.',
    );
    expect(
      el().querySelector('[data-value=small]')?.getAttribute('aria-current'),
    ).toBe('true');
    expect(el().querySelector('[data-slot=variant-key]')?.textContent).toBe(
      'small',
    );
    expect(
      el().querySelector('[data-slot=in-use-note]')?.textContent,
    ).toContain('in 1 build');
    const use = el().querySelector('[data-use="module/charging"]');
    expect(use?.getAttribute('href')).toBe('/content/de/charging');
    expect(button(el(), 'archive')).toBeNull();
    expect(button(el(), 'sortable-grip')).toBeNull();
    http.verify();
  });

  it('archives a value at once and undoes it from the toast', async () => {
    const { http, settle, el } = await render({
      changeSet: true,
      url: '/variants?attribute=model&value=small',
    });
    workingCopy(http);
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();

    button(el(), 'archive')?.click();
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await settle();
    const save = http.expectOne(`/api/change-sets/${CS}/config/working-copy`);
    expect(
      save.request.body.data.attributes.content.variantAttributes[0],
    ).toEqual(
      expect.objectContaining({
        values: [
          { id: 'small', label: 'Small', archived: true },
          { id: 'large', label: 'Large' },
        ],
      }),
    );
    save.flush({
      data: {
        type: 'WorkingCopy',
        id: `${CS}/config`,
        attributes: { version: 1, baseCommit: 'c0' },
      },
    });
    await settle();
    expect(el().querySelector('[data-slot=archived-badge]')).not.toBeNull();

    const toasts = TestBed.inject(ToastService);
    const toast = toasts.toasts().at(-1);
    expect(toast?.message).toEqual({
      key: 'editor.admin.variants.done.archive',
      params: { label: 'Small' },
    });
    toast?.onAction?.();
    await settle();
    const undo = http.expectOne(`/api/change-sets/${CS}/config/working-copy`);
    expect(
      undo.request.body.data.attributes.content.variantAttributes[0].values[0],
    ).toEqual({ id: 'small', label: 'Small' });
  });

  it('opens the decision for a used value, listing its builds and content, and archives from it', async () => {
    const { http, settle, el } = await render({
      changeSet: true,
      url: '/variants?attribute=model&value=small',
    });
    workingCopy(http);
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();

    button(el(), 'remove')?.click();
    await settle();
    flushDetail(http);
    await settle();
    expect(
      document.querySelector('[data-slot=in-use-builds]')?.textContent,
    ).toContain('Operating manual · Small');
    const places = [
      ...document.querySelectorAll('[data-slot=in-use-places] a'),
    ].map((a) => a.getAttribute('href'));
    expect(places).toEqual([
      `/manuals?cs=${CS}&manual=operating`,
      `/content/de/charging?cs=${CS}`,
      `/content/en/charging?cs=${CS}`,
    ]);
    http.expectNone(`/api/change-sets/${CS}/config/working-copy`);

    button(document, 'in-use-archive')?.click();
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await settle();
    const save = http.expectOne(`/api/change-sets/${CS}/config/working-copy`);
    expect(
      save.request.body.data.attributes.content.variantAttributes[0].values[0],
    ).toEqual({ id: 'small', label: 'Small', archived: true });
  });

  it('removes an unused value at once and shows its attribute', async () => {
    const { http, settle, el } = await render({
      changeSet: true,
      url: '/variants?attribute=model&value=large',
    });
    workingCopy(http);
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();

    button(el(), 'remove')?.click();
    await settle();
    flushDetail(http);
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await settle();
    const save = http.expectOne(`/api/change-sets/${CS}/config/working-copy`);
    expect(
      save.request.body.data.attributes.content.variantAttributes[0].values,
    ).toEqual([{ id: 'small', label: 'Small' }]);
    expect(query()).toEqual({ attribute: 'model', cs: CS });
  });

  it('adds a value through the dialog and chooses it', async () => {
    const { http, settle, el } = await render({ changeSet: true });
    workingCopy(http);
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();

    button(el(), 'add-value')?.click();
    await settle();
    const label = document.querySelector<HTMLInputElement>(
      '[data-field=variant-new-label]',
    );
    if (!label) throw new Error('no label field');
    label.value = 'Medium size';
    label.dispatchEvent(new Event('input'));
    await settle();
    button(document, 'variant-new-add')?.click();
    await settle();
    http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
    await settle();
    const save = http.expectOne(`/api/change-sets/${CS}/config/working-copy`);
    expect(
      save.request.body.data.attributes.content.variantAttributes[0].values.at(
        -1,
      ),
    ).toEqual({ id: 'medium-size', label: 'Medium size' });
    expect(query()).toEqual({
      attribute: 'model',
      value: 'medium-size',
      cs: CS,
    });
  });

  it('says which sign-offs a review needs before submitting', async () => {
    const { http, settle, el } = await render({ changeSet: true });
    workingCopy(http);
    await settle();
    flushAll(http, '/config/usages', USAGES);
    flushDetail(http);
    await settle();
    button(el(), 'submit-review')?.click();
    await settle();
    const needs = document.querySelector('[data-slot=submit-needs]');
    expect(needs?.textContent).toContain('A review');
    expect(needs?.textContent).toContain('A sign-off for Safety');
    button(document, 'submit-confirm')?.click();
    await settle();
    const submit = http.expectOne(`/api/change-sets/${CS}/submit`);
    expect(submit.request.method).toBe('POST');
  });
});
