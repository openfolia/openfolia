import { Location } from '@angular/common';
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

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { ReadRef } from '../../api';
import { DEFAULT_CODE_LANGUAGES } from '../../doc-editor/blocks/code-languages';
import { MeService } from '../../permissions/me';
import { ChangeSetSession } from '../../session/change-set-session';
import { provideChangeSetUrl } from '../../session/change-set-url';
import type { ProjectConfig } from './config-model';
import { SettingsContext } from './settings-context';
import { ProjectSettingsPage } from './project-settings.page';
import { SETTINGS_ROUTES } from './settings.routes';
import { CONFIG as BASE } from './testing/config-fixture';

const CS = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const BRANCH = `change-sets/${CS}`;
const WC = `/api/change-sets/${CS}/config/working-copy`;
const CONFIG: ProjectConfig = {
  ...BASE,
  languages: { source: 'en', targets: ['de', 'fr'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
    { id: 'task', label: 'Task', restricted: false, snippet: false },
  ],
  facets: [
    {
      id: 'region',
      label: 'Region',
      values: [
        { id: 'north', label: 'North' },
        { id: 'south', label: 'South' },
      ],
    },
    { id: 'market', label: 'Market', values: [{ id: 'eu', label: 'EU' }] },
  ],
};
const links = { self: '', first: '', last: '', prev: null, next: null };
const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 100, total: data.length },
  },
  links,
});
const usage = (
  kind: string,
  valueId: string,
  modules: number,
  manuals: number,
) => ({
  type: 'ConfigUsage',
  id: `${kind}/${valueId}`,
  attributes: { kind, valueId },
  meta: { modules, manuals },
});
const USAGES = page([
  usage('audience', 'public', 2, 1),
  usage('audience', 'service', 0, 0),
  usage('moduleType', 'concept', 3, 0),
]);
const configDoc = {
  data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
};
const copyDoc = (content: ProjectConfig, version: number) => ({
  data: {
    type: 'WorkingCopy',
    id: `${CS}/config`,
    attributes: {
      subject: { type: 'config' },
      content,
      version,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: CS } } },
    meta: { saved: false, issues: [] },
  },
});

async function render(options: {
  changeSet: boolean;
  url: string;
  config?: ProjectConfig;
}) {
  const config = options.config ?? CONFIG;
  if (options.changeSet) {
    localStorage.setItem(
      'openfolia.change-set',
      JSON.stringify({ id: CS, title: 'Settings', branch: BRANCH }),
    );
  }
  TestBed.configureTestingModule({
    providers: [
      provideRouter([
        {
          path: 'settings',
          component: ProjectSettingsPage,
          data: { changeSetParam: 'session' },
          children: SETTINGS_ROUTES,
        },
        { path: 'content', children: [] },
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
  // Listens to Back and Forward (`popstate`), as the app's first navigation does.
  TestBed.inject(Router).initialNavigation();
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 5; i++) {
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
              title: 'Settings',
              state: 'draft',
              branch: BRANCH,
              author: { kind: 'user', id: 'admin' },
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
        ]),
      );
  }
  void harness.navigateByUrl(options.url);
  await settle();
  if (options.changeSet) {
    http.expectOne(WC).flush(copyDoc(config, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
  } else {
    http
      .expectOne((r) => r.url === '/api/config')
      .flush({ data: { ...configDoc.data, attributes: config } });
  }
  http.expectOne((r) => r.url === '/api/config/usages').flush(USAGES);
  await settle();
  const el = () => harness.routeNativeElement as HTMLElement;
  let saves = 0;
  /** The next save: the lock first (once), then the working copy. */
  const save = async (): Promise<ProjectConfig> => {
    await settle();
    if (saves === 0) {
      http.expectOne(`/api/change-sets/${CS}/locks`).flush({});
      await settle();
    }
    const req: TestRequest = http.expectOne(WC);
    expect(req.request.method).toBe('PUT');
    const content = req.request.body.data.attributes.content as ProjectConfig;
    req.flush(copyDoc(content, ++saves));
    await settle();
    return content;
  };
  const click = async (selector: string, root: ParentNode = el()) => {
    const target = root.querySelector<HTMLElement>(selector);
    if (!target) throw new Error(`nothing at ${selector}`);
    target.click();
    await settle();
  };
  /** Opens a row's ⋯ menu and chooses an action in it. */
  const menu = async (row: string, action: string) => {
    await click(`${row} [z-dropdown]`);
    await click(`[data-action=${action}]`, document);
  };
  const type = async (selector: string, value: string) => {
    const input = document.querySelector<HTMLInputElement>(selector);
    if (!input) throw new Error(`nothing at ${selector}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  };
  const submit = async (form: string) => {
    document
      .querySelector(`#${form}`)
      ?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const lastToast = () => TestBed.inject(ToastService).toasts().at(-1);
  return {
    http,
    settle,
    el,
    save,
    click,
    menu,
    type,
    submit,
    lastToast,
    router: TestBed.inject(Router),
    harness,
  };
}

describe('ProjectSettingsPage', () => {
  it('opens the first topic, groups the menu and reads first outside a change set', async () => {
    const t = await render({ changeSet: false, url: '/settings' });
    expect(t.router.url).toBe('/settings/languages');
    const menu = [...t.el().querySelectorAll('nav [data-topic]')].map((a) =>
      a.getAttribute('data-topic'),
    );
    expect(menu).toEqual([
      'languages',
      'module-types',
      'audiences',
      'facets',
      'variant-attributes',
      'text-attributes',
      'output-labels',
      'headings',
      'manufacturer',
      'safety-symbols',
      'code-languages',
      'review',
    ]);
    expect(t.el().textContent).toContain('Content model');
    expect(t.el().textContent).toContain(
      'Choose or start a revision to change the project settings.',
    );
    expect(t.el().querySelector('input')).toBeNull();
    expect(t.el().querySelector('[z-dropdown]')).toBeNull();
    expect(t.el().querySelector('[data-slot=topic-add]')).toBeNull();
    t.http.verify();
  });

  it('shows the installation’s review rule as applying at once, not in a revision (#588)', async () => {
    const t = await render({ changeSet: true, url: '/settings/review' });
    t.http.expectOne('/api/settings').flush({
      data: {
        type: 'InstallationSettings',
        id: 'installation',
        attributes: { selfApproval: 'review', updatedAt: null },
      },
    });
    await t.settle();
    expect(t.el().querySelector('h2')?.textContent).toContain('Review');
    const status = t.el().querySelector('[data-slot=settings-status]');
    expect(status?.textContent).toContain(
      'Applies to the whole installation at once.',
    );
    expect(status?.textContent).not.toContain('Saved to revision');
    expect(
      t.el().querySelector('[data-option=review] [aria-checked=true]'),
    ).not.toBeNull();
    t.http.verify();
  });

  it('gives each topic its own address; Back returns to the last one', async () => {
    const t = await render({ changeSet: false, url: '/settings/audiences' });
    expect(t.el().querySelector('h2')?.textContent).toContain('Audiences');
    expect(
      t.el().querySelector('[data-option=public] [data-slot=usage]')
        ?.textContent,
    ).toContain('2 modules, 1 manual');
    await t.click('nav [data-topic=module-types]');
    expect(t.router.url).toBe('/settings/module-types');
    expect(t.el().querySelector('h2')?.textContent).toContain('Module types');
    const location = TestBed.inject(Location);
    location.back();
    await t.settle();
    expect(t.router.url).toBe('/settings/audiences');
    location.forward();
    await t.settle();
    expect(t.router.url).toBe('/settings/module-types');
  });

  it('mounts the variant editor under Variant attributes, its selection in the address', async () => {
    const t = await render({
      changeSet: false,
      url: '/settings/variant-attributes',
    });
    // The editor reads the counts it shows itself.
    t.http
      .match((r) => r.url === '/api/config/usages')
      .forEach((r) => r.flush(USAGES));
    await t.settle();
    expect(t.el().querySelector('of-variant-editor')).not.toBeNull();
    expect(t.el().querySelector('of-variant-tree')).not.toBeNull();
    expect(t.el().querySelector('[data-slot=topic-add]')).toBeNull();
  });

  it('keeps the change set in the address across topics', async () => {
    const t = await render({ changeSet: true, url: '/settings/languages' });
    expect(t.router.url).toBe(`/settings/languages?cs=${CS}`);
    await t.click('nav [data-topic=facets]');
    expect(t.router.url).toBe(`/settings/facets?cs=${CS}`);
    expect(t.el().textContent).toContain('Saved to revision “Settings”');
  });

  it('asks before deleting a value content uses, and deletes an unused one with Undo', async () => {
    const t = await render({ changeSet: true, url: '/settings/audiences' });
    await t.menu('[data-option=public]', 'option-delete');
    expect(document.body.textContent).toContain(
      'Used by 2 modules and 1 manual you can see.',
    );
    t.http.expectNone(WC);
    document.querySelectorAll('z-dialog').forEach((d) => d.remove());

    await t.menu('[data-option=service]', 'option-delete');
    expect((await t.save()).audiences.map((a) => a.id)).toEqual(['public']);
    const toast = t.lastToast();
    expect(toast?.message).toEqual(
      expect.objectContaining({ key: 'editor.admin.settings.done.remove' }),
    );
    toast?.onAction?.();
    expect((await t.save()).audiences.map((a) => a.id)).toEqual([
      'public',
      'service',
    ]);
  });

  it('adds through the topic’s Add dialog, the ID made from the label and checked', async () => {
    const t = await render({ changeSet: true, url: '/settings/module-types' });
    expect(t.el().querySelector('form')).toBeNull();
    await t.click('[data-slot=topic-add]');
    await t.type('[data-field=option-new-label]', 'Safety Notes');
    expect(
      document.querySelector<HTMLInputElement>('[data-field=option-new-id]')
        ?.value,
    ).toBe('safety-notes');
    await t.type('[data-field=option-new-id]', 'task');
    expect(document.body.textContent).toContain('This ID is already used.');
    await t.submit('option-new-form');
    t.http.expectNone(WC);
    await t.type('[data-field=option-new-id]', 'safety-notes');
    await t.submit('option-new-form');
    expect((await t.save()).moduleTypes.at(-1)).toEqual({
      id: 'safety-notes',
      label: 'Safety Notes',
      restricted: false,
      snippet: false,
    });
  });

  it('renames in place, sets a flag from the menu and reorders by keyboard', async () => {
    const t = await render({ changeSet: true, url: '/settings/module-types' });
    await t.click('[data-option=task] button[data-slot=inline-label]');
    const field = t
      .el()
      .querySelector<HTMLInputElement>('[data-field=inline-label]');
    if (!field) throw new Error('no field');
    field.value = 'Procedure';
    field.dispatchEvent(new Event('blur'));
    expect((await t.save()).moduleTypes[1]?.label).toBe('Procedure');

    await t.menu('[data-option=concept]', 'option-restricted');
    expect((await t.save()).moduleTypes[0]?.restricted).toBe(true);
    expect(
      t.el().querySelector('[data-option=concept] [data-flag=restricted]'),
    ).not.toBeNull();

    t.el()
      .querySelector<HTMLButtonElement>('[data-slot=sortable-grip]')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'ArrowDown',
          altKey: true,
          bubbles: true,
        }),
      );
    expect((await t.save()).moduleTypes.map((m) => m.id)).toEqual([
      'task',
      'concept',
    ]);
  });

  it('lists the built-in code languages below the own ones, renames one and resets it', async () => {
    const t = await render({
      changeSet: true,
      url: '/settings/code-languages',
    });
    expect(t.el().textContent).toContain(
      'The built-in languages are always offered. Add your own or rename one.',
    );
    const rows = () =>
      [...t.el().querySelectorAll('[data-option]')].map((r) =>
        r.getAttribute('data-option'),
      );
    expect(rows()).toHaveLength(DEFAULT_CODE_LANGUAGES.length);
    expect(rows()[0]).toBe('bash');
    expect(
      t.el().querySelectorAll('[data-option] [data-flag=badge]'),
    ).toHaveLength(DEFAULT_CODE_LANGUAGES.length);
    expect(t.el().querySelector('[data-slot=sortable-grip]')).toBeNull();

    // A built-in ID added: the same as renaming that one, not a second row.
    await t.click('[data-slot=topic-add]');
    await t.type('[data-field=option-new-label]', 'JSON (strict)');
    await t.type('[data-field=option-new-id]', 'JSON');
    await t.submit('option-new-form');
    expect((await t.save()).codeLanguages).toEqual([
      { id: 'json', label: 'JSON (strict)' },
    ]);
    expect(rows()).toHaveLength(DEFAULT_CODE_LANGUAGES.length);
    expect(
      t.el().querySelector('[data-option=json] [data-slot=inline-label]')
        ?.textContent,
    ).toContain('JSON (strict)');

    // An own one: above the built-in ones, with a grip.
    await t.click('[data-slot=topic-add]');
    await t.type('[data-field=option-new-label]', 'Fortran');
    await t.submit('option-new-form');
    expect((await t.save()).codeLanguages).toEqual([
      { id: 'json', label: 'JSON (strict)' },
      { id: 'fortran', label: 'Fortran' },
    ]);
    expect(rows()[0]).toBe('fortran');
    expect(t.el().querySelectorAll('[data-slot=sortable-grip]')).toHaveLength(
      1,
    );

    // Renamed in place, then reset from the menu, with Undo.
    await t.click('[data-option=yaml] button[data-slot=inline-label]');
    const field = t
      .el()
      .querySelector<HTMLInputElement>('[data-field=inline-label]');
    if (!field) throw new Error('no field');
    field.value = 'YAML 1.2';
    field.dispatchEvent(new Event('blur'));
    expect((await t.save()).codeLanguages.at(-1)).toEqual({
      id: 'yaml',
      label: 'YAML 1.2',
    });
    await t.click('[data-option=yaml] [z-dropdown]');
    expect(document.querySelector('[data-action=option-delete]')).toBeNull();
    await t.click('[data-action=option-reset]', document);
    expect((await t.save()).codeLanguages).toEqual([
      { id: 'json', label: 'JSON (strict)' },
      { id: 'fortran', label: 'Fortran' },
    ]);
    t.lastToast()?.onAction?.();
    expect((await t.save()).codeLanguages.at(-1)?.id).toBe('yaml');
  });

  it('shows facets as master and detail, the chosen one in the address', async () => {
    const t = await render({
      changeSet: true,
      url: '/settings/facets?facet=market',
    });
    const detail = () =>
      t.el().querySelector('[data-slot=facet-detail]') as HTMLElement;
    expect(detail().getAttribute('data-facet')).toBe('market');
    await t.click('[data-slot=facet-list] [data-facet=region]');
    expect(t.router.url).toContain('facet=region');
    expect(detail().querySelector('[data-option=south]')).not.toBeNull();

    await t.click('[data-slot=topic-add]');
    await t.type('[data-field=option-new-label]', 'West');
    await t.submit('option-new-form');
    expect((await t.save()).facets[0]?.values.map((v) => v.id)).toEqual([
      'north',
      'south',
      'west',
    ]);

    await t.click('[data-slot=new-facet]');
    await t.type('[data-field=option-new-label]', 'Line');
    await t.type('[data-field=option-new-first]', 'Basic');
    await t.submit('option-new-form');
    expect((await t.save()).facets.at(-1)).toEqual({
      id: 'line',
      label: 'Line',
      values: [{ id: 'basic', label: 'Basic' }],
    });
    expect(t.router.url).toContain('facet=line');
  });

  it('makes a translation language the source and adds one by its tag', async () => {
    const t = await render({ changeSet: true, url: '/settings/languages' });
    await t.menu('[data-language=fr]', 'language-make-source');
    expect((await t.save()).languages).toEqual({
      source: 'fr',
      targets: ['de', 'en'],
    });
    await t.click('[data-slot=topic-add]');
    await t.type('[data-field=language-new]', 'it');
    await t.submit('language-new-form');
    expect((await t.save()).languages.targets).toEqual(['de', 'en', 'it']);
  });

  it('shows each language’s text direction, from its script or as configured (#458)', async () => {
    const t = await render({
      changeSet: false,
      url: '/settings/languages',
      config: {
        ...CONFIG,
        languages: {
          source: 'en',
          targets: ['de', 'ar', 'he'],
          direction: { he: 'ltr' },
        },
      },
    });
    const direction = (tag: string) =>
      t
        .el()
        .querySelector<HTMLElement>(
          `[data-language=${tag}] [data-slot=direction]`,
        )!;
    expect(direction('en').textContent?.trim()).toBe('Left to right');
    expect(direction('ar').textContent?.trim()).toBe('Right to left');
    expect(direction('ar').dataset['direction']).toBe('rtl');
    expect(direction('ar').title).toBe(
      'Text direction, from the language’s script',
    );
    // Hebrew is set left to right in the configuration.
    expect(direction('he').textContent?.trim()).toBe('Left to right');
    expect(direction('he').title).toBe(
      'Text direction, set in the configuration (languages.direction)',
    );
  });

  it('groups the output labels, shows the built-in text and resets a field to it', async () => {
    const t = await render({
      changeSet: true,
      url: '/settings/output-labels?labels=de',
    });
    const groups = [...t.el().querySelectorAll('legend')].map((l) =>
      l.textContent?.trim(),
    );
    expect(groups).toEqual([
      'Signal words',
      'Notes',
      'Captions',
      'Update guides',
      'Other',
    ]);
    const tip = () =>
      t.el().querySelector<HTMLInputElement>('#output-label-tip');
    expect(tip()?.placeholder).toBe('Tipp');
    expect(t.el().querySelector('[data-slot=output-label-reset]')).toBeNull();
    const input = tip();
    if (!input) throw new Error('no field');
    input.value = 'Rat';
    input.dispatchEvent(new Event('change'));
    expect((await t.save()).outputLabels['de']?.tip).toBe('Rat');
    await t.click('[data-label=tip] [data-slot=output-label-reset]');
    expect((await t.save()).outputLabels['de']).toBeUndefined();
  });

  it('edits the manufacturer details, refuses what the configuration would, and turns the check on (#395)', async () => {
    const t = await render({ changeSet: true, url: '/settings/manufacturer' });
    const field = (key: string) =>
      t.el().querySelector<HTMLInputElement>(`[data-field=${key}]`);
    const change = async (key: string, value: string) => {
      const input = field(key);
      if (!input) throw new Error(`no field ${key}`);
      input.value = value;
      input.dispatchEvent(new Event('change'));
      await t.settle();
    };
    expect(field('name')?.value).toBe('');
    // A contact without a name: said, not saved.
    await change('contact', 'info@example.com');
    expect(
      t.el().querySelector('[data-slot=manufacturer-problem]')?.textContent,
    ).toContain('A name is needed');
    t.http.expectNone(WC);
    await change('name', 'Example Works Ltd');
    expect((await t.save()).manufacturer).toEqual({
      name: 'Example Works Ltd',
      address: [],
      contact: 'info@example.com',
    });
    expect(t.el().querySelector('[data-slot=manufacturer-problem]')).toBeNull();
    await change('address', '1 Sample Street\n12345 Sample Town');
    expect((await t.save()).manufacturer?.address).toEqual([
      '1 Sample Street',
      '12345 Sample Town',
    ]);
    // A website that is no address stays unsaved.
    await change('website', 'example.com');
    expect(field('website')?.getAttribute('aria-invalid')).toBe('true');
    t.http.expectNone(WC);
    await change('website', 'https://example.com');
    expect((await t.save()).manufacturer?.website).toBe('https://example.com');
    await t.click('[data-slot=manufacturer-check] button[role=switch]');
    expect((await t.save()).release?.checkManufacturer).toBe(true);
  });

  it('keeps no usage counts read before a switch that answer while it is unanswered (#716)', async () => {
    const t = await render({ changeSet: false, url: '/settings/audiences' });
    const ctx = t.harness.routeDebugElement!.injector.get(SettingsContext);
    expect(ctx.counts().size).toBe(3);
    // Read again (a new head of the branch), then a switch begins before the counts answer.
    TestBed.inject(ReadRef).moves.update((n) => n + 1);
    await t.settle();
    const before = t.http.expectOne((r) => r.url === '/api/config/usages');
    TestBed.inject(ChangeSetSession).beginSwitch();
    await t.settle();
    before.flush(page([usage('audience', 'public', 9, 9)]));
    await t.settle();
    expect(ctx.countOf({ kind: 'audience', valueId: 'public' })).not.toEqual({
      modules: 9,
      manuals: 9,
    });
  });
});
