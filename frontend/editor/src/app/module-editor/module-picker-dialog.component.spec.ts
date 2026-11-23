import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import type { ModulePick } from '../doc-editor/blocks/doc-blocks-context';
import { MeService } from '../permissions/me';
import { advance } from '../testing/fake-time';
import {
  ModulePickerDialogComponent,
  pickerStatus,
  type ModulePickRequest,
} from './module-picker-dialog.component';
import type { GraphModule } from './module-graph';

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [
    { id: 'concept', label: 'Concept', restricted: false, snippet: false },
  ],
  audiences: [],
  facets: [
    {
      id: 'line',
      label: 'Product line',
      values: [{ id: 'small', label: 'Small' }],
    },
  ],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
} as unknown as ModulePickRequest['config'];

const pageMeta = (total: number) => ({
  page: { currentPage: 1, lastPage: 1, perPage: 20, total },
});
const links = { self: '', first: '', last: '', prev: null, next: null };

/** A module of `GET /modules`: `refs` are its module references. */
function module(
  id: string,
  title: string,
  refs: string[] = [],
  status: Record<string, unknown> = {
    release: null,
    main: { commit: 'c', same: true },
  },
) {
  return {
    type: 'Module',
    id: `en/${id}`,
    attributes: {
      moduleId: id,
      lang: 'en',
      schemaVersion: 1,
      title,
      moduleType: 'concept',
      facets: { line: ['small'] },
      blocks: [
        {
          type: 'paragraph',
          id: 'p',
          content: [{ type: 'text', text: `About ${title}.` }],
        },
        ...refs.map((r, i) => ({ type: 'moduleRef', id: `r${i}`, module: r })),
      ],
    },
    meta: { issues: [], status },
  };
}

// The edited module is `edited`; `wrapper` includes `middle`, which includes `edited`.
const MODULES = [
  module('edited', 'Edited'),
  module('middle', 'Middle', ['edited']),
  module('wrapper', 'Wrapper', ['middle']),
  module('free', 'Free standing', [], {
    release: null,
    main: null,
    changeSets: [{ id: 'cs', state: 'in-review' }],
  }),
  module('user', 'User of free', ['free']),
];

const summary = (id: string, title: string) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    moduleId: id,
    title,
    titleLang: 'en',
    moduleType: 'concept',
    facets: {},
    keywords: [],
    languages: ['en'],
    variants: [],
  },
  meta: { changed: false },
});

@Component({
  imports: [ModulePickerDialogComponent],
  template: `<of-module-picker-dialog
    [request]="request()"
    (done)="answers.push($event); request.set(null)"
  />`,
})
class Host {
  readonly request = signal<ModulePickRequest | null>(null);
  readonly answers: (ModulePick | null)[] = [];
}

async function render(extra: Partial<ModulePickRequest> = {}) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  // Fake time: the search is debounced from a signal that change detection, itself on a timer,
  // hands on. A fixed real wait ended before the debounce had even started on a busy machine;
  // the fake clock runs every timer due in the step, in order (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  const settle = async () => {
    for (let i = 0; i < 4; i++) await advance();
  };
  fixture.componentInstance.request.set({
    moduleId: 'edited',
    lang: 'en',
    facets: { line: ['small'] },
    config,
    ...extra,
  });
  await settle();
  const dialog = () =>
    document.querySelector<HTMLElement>('z-dialog-panel') as HTMLElement;
  const rows = () =>
    Array.from(
      document.querySelectorAll<HTMLButtonElement>('button[data-picker-row]'),
    );
  const button = (text: string) =>
    Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  return { fixture, http, settle, dialog, rows, button };
}

function answerGraph(http: HttpTestingController) {
  const req = http.expectOne((r) => r.url === '/api/modules');
  expect(req.request.params.get('filter[lang]')).toBe('en');
  expect(req.request.params.get('page[size]')).toBe('200');
  req.flush({ data: MODULES, meta: pageMeta(MODULES.length), links });
}

function answerList(req: TestRequest, ids: string[]) {
  req.flush({
    data: ids.map((id) =>
      summary(
        id,
        MODULES.find((m) => m.attributes.moduleId === id)!.attributes.title,
      ),
    ),
    meta: pageMeta(ids.length),
    links,
  });
}

describe('ModulePickerDialogComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove());
  });

  it('lists modules, marks the ones that include this module and refuses to include them', async () => {
    const { http, settle, dialog, rows, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['wrapper', 'edited', 'free'],
    );
    await settle();

    expect(dialog().textContent).toContain('Insert module reference');
    const [wrapper, edited, free] = rows();
    // Status in words, the facet values as the path, the cycle as a word with its icon.
    expect(wrapper!.textContent).toContain('Includes this module');
    expect(wrapper!.textContent).toContain('Concept / Small');
    expect(edited!.textContent).toContain('This module');
    expect(free!.textContent).not.toContain('Includes this module');
    expect(free!.textContent).toContain('In review');

    // The first row is chosen: the cycle is named, and Insert says why it can't.
    expect(wrapper!.getAttribute('aria-pressed')).toBe('true');
    await settle();
    expect(dialog().textContent).toContain(
      'Wrapper already includes this module (Wrapper → Middle → Edited)',
    );
    const insert = button('Insert');
    expect(insert.getAttribute('aria-disabled')).toBe('true');
    expect(dialog().textContent).toContain(
      'Including this module would make a cycle.',
    );
    insert.click();
    expect(fixture.componentInstance.answers).toEqual([]);

    // The module itself can't be included either.
    edited!.click();
    await settle();
    expect(dialog().textContent).toContain('A module cannot include itself.');
    expect(button('Insert').getAttribute('aria-disabled')).toBe('true');

    // One block of a module that includes this one is a cycle all the same (#223).
    wrapper!.click();
    await settle();
    dialog().querySelector<HTMLButtonElement>('#module-picker-block')!.click();
    await settle();
    dialog()
      .querySelector<HTMLButtonElement>('#module-picker-block-p')!
      .click();
    await settle();
    expect(dialog().textContent).toContain(
      'Wrapper already includes this module (Wrapper → Middle → Edited)',
    );
    expect(button('Insert').getAttribute('aria-disabled')).toBe('true');
    button('Insert').click();
    expect(fixture.componentInstance.answers).toEqual([]);
  });

  it('inserts one block of a module, chosen in its preview (#223)', async () => {
    const { http, settle, dialog, rows, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free', 'user'],
    );
    await settle();
    rows()[1]!.click();
    await settle();
    dialog().querySelector<HTMLButtonElement>('#module-picker-block')!.click();
    await settle();
    // The preview is a chooser of its blocks: its paragraph and its module reference.
    const chooser = dialog().querySelector('[data-block-chooser]')!;
    expect(chooser.textContent).toContain('About User of free.');
    expect(chooser.querySelector('#module-picker-block-r0')).not.toBeNull();
    // Nothing chosen yet: Insert says why it can't.
    expect(button('Insert').getAttribute('aria-disabled')).toBe('true');
    expect(dialog().textContent).toContain(
      'Choose a block of the module first.',
    );
    dialog()
      .querySelector<HTMLButtonElement>('#module-picker-block-p')!
      .click();
    await settle();
    expect(button('Insert').getAttribute('aria-disabled')).toBeNull();
    // Another module: its block is to be chosen again.
    rows()[0]!.click();
    await settle();
    expect(button('Insert').getAttribute('aria-disabled')).toBe('true');
    dialog()
      .querySelector<HTMLButtonElement>('#module-picker-block-p')!
      .click();
    await settle();
    button('Insert').click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([
      { module: 'free', mode: 'block', block: 'p' },
    ]);
  });

  it('previews the chosen module, names who uses it and inserts it whole', async () => {
    const { http, settle, dialog, rows, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    rows()[0]!.click();
    await settle();
    expect(dialog().querySelector('h3')?.textContent).toContain(
      'Free standing',
    );
    expect(dialog().textContent).toContain('About Free standing.');
    expect(dialog().textContent).toContain('Preview · English');
    expect(dialog().textContent).toContain('Also used in other modules');
    expect(dialog().textContent).toContain('User of free');
    const insert = button('Insert');
    expect(insert.getAttribute('aria-disabled')).toBeNull();
    insert.click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([
      { module: 'free', mode: 'whole' },
    ]);
  });

  it('links to a module that includes this one: a link is no inclusion', async () => {
    const { http, settle, dialog, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['wrapper'],
    );
    await settle();
    dialog().querySelector<HTMLButtonElement>('#module-picker-link')!.click();
    await settle();
    expect(dialog().textContent).not.toContain('would make a cycle');
    button('Insert').click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([
      { module: 'wrapper', mode: 'link' },
    ]);
  });

  it('for a snippet, lists only snippets and inserts one as a reference or as a copy', async () => {
    const snippetConfig = {
      ...config,
      moduleTypes: [
        ...config.moduleTypes,
        { id: 'phrase', label: 'Phrase', restricted: false, snippet: true },
      ],
    } as ModulePickRequest['config'];
    const { http, settle, dialog, button, fixture } = await render({
      snippet: true,
      config: snippetConfig,
    });
    answerGraph(http);
    const list = http.expectOne((r) => r.url === '/api/module-summaries');
    expect(list.request.params.get('filter[snippet]')).toBe('true');
    expect(list.request.params.get('filter[lang]')).toBe('en');
    answerList(list, ['free']);
    await settle();
    expect(dialog().textContent).toContain('Insert snippet');
    expect(dialog().textContent).toContain('As reference');
    expect(dialog().textContent).toContain('As copy');
    // No link and no single block for a snippet.
    expect(dialog().querySelector('#module-picker-link')).toBeNull();
    expect(dialog().querySelector('#module-picker-block')).toBeNull();
    dialog().querySelector<HTMLButtonElement>('#module-picker-copy')!.click();
    await settle();
    button('Insert').click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([
      { module: 'free', mode: 'copy' },
    ]);
  });

  it('closes as it was: the snippet picker never turns into the module picker while it leaves (#796)', async () => {
    const snippetConfig = {
      ...config,
      moduleTypes: [
        ...config.moduleTypes,
        { id: 'phrase', label: 'Phrase', restricted: false, snippet: true },
      ],
    } as ModulePickRequest['config'];
    const { http, settle, dialog, button, rows, fixture } = await render({
      snippet: true,
      config: snippetConfig,
    });
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    const panel = dialog();
    const height = panel.querySelector('.grid')?.className;
    button('Insert').click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([
      { module: 'free', mode: 'whole' },
    ]);
    // Leaving: the same dialog, its title, its list and its layout, until it is gone.
    expect(panel.isConnected).toBe(true);
    expect(panel.getAttribute('data-state')).toBe('closed');
    expect(panel.textContent).toContain('Insert snippet');
    expect(panel.textContent).not.toContain('Insert module reference');
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Free standing'),
    ]);
    expect(panel.querySelector('.grid')?.className).toBe(height);
    // Nothing is read while it leaves, and a second click answers nothing more.
    button('Insert').click();
    await advance(200);
    expect(panel.isConnected).toBe(false);
    expect(fixture.componentInstance.answers).toHaveLength(1);
  });

  it('opened again, shows none of the last time\u2019s rows while it reads the list', async () => {
    const { http, settle, rows, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    button('Cancel').click();
    await advance(200);
    fixture.componentInstance.request.set({
      moduleId: 'edited',
      lang: 'en',
      facets: { line: ['small'] },
      config,
      snippet: true,
    });
    await settle();
    expect(rows()).toEqual([]);
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['user'],
    );
    await settle();
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('User of free'),
    ]);
  });

  it('for a snippet, searches the snippets by title on the server', async () => {
    const { http, settle, dialog } = await render({ snippet: true });
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    const search =
      dialog().querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = 'gloves';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    const found = http.expectOne((r) => r.url === '/api/module-summaries');
    expect(found.request.params.get('filter[q]')).toBe('gloves');
    expect(found.request.params.get('filter[snippet]')).toBe('true');
    http.expectNone((r) => r.url === '/api/search');
    answerList(found, ['free']);
    await settle();
  });

  it('searches over the search route with the filters, and cancels', async () => {
    const { http, settle, dialog, button, fixture } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      [],
    );
    await settle();
    expect(dialog().textContent).toContain('No modules found');

    button('Same Product line').click();
    await settle();
    const narrowed = http.expectOne((r) => r.url === '/api/module-summaries');
    expect(narrowed.request.params.getAll('filter[facet]')).toEqual([
      'line:small',
    ]);
    answerList(narrowed, ['free']);
    await settle();

    const input = dialog().querySelector<HTMLInputElement>(
      'input[type="search"]',
    )!;
    input.value = 'free';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(250);
    await settle();
    const search = http.expectOne((r) => r.url === '/api/search');
    expect(search.request.params.get('filter[q]')).toBe('free');
    expect(search.request.params.get('filter[resourceType]')).toBe('module');
    expect(search.request.params.get('filter[lang]')).toBe('en');
    expect(search.request.params.getAll('filter[facet]')).toEqual([
      'line:small',
    ]);
    search.flush({
      data: [
        {
          type: 'SearchResult',
          id: 'module:en/free',
          attributes: {
            resourceType: 'Module',
            resourceId: 'en/free',
            lang: 'en',
            title: 'Free standing',
          },
          relationships: {
            resource: { data: { type: 'Module', id: 'en/free' } },
          },
          meta: { matchedOn: 'title', excerpt: 'Free standing', matches: [] },
        },
      ],
      meta: pageMeta(1),
      links,
    });
    await settle();
    expect(dialog().textContent).toContain('Free standing');

    button('Cancel').click();
    await settle();
    expect(fixture.componentInstance.answers).toEqual([null]);
  });

  it('says when the references could not be checked, and checks again', async () => {
    const { http, settle, dialog, button } = await render();
    http
      .expectOne((r) => r.url === '/api/modules')
      .flush({}, { status: 503, statusText: 'Unavailable' });
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    // The preview reads the module on its own.
    http
      .expectOne((r) => r.url === '/api/modules/en/free')
      .flush({ data: MODULES[3] });
    await settle();
    expect(dialog().textContent).toContain(
      'Whether it includes this module could not be checked.',
    );
    expect(button('Insert').getAttribute('aria-disabled')).toBe('true');
    button('Check again').click();
    await settle();
    answerGraph(http);
    await settle();
    expect(button('Insert').getAttribute('aria-disabled')).toBeNull();
  });

  it('shows none of the previous person\u2019s modules once another acts, and reads theirs (#716)', async () => {
    const { http, settle, rows } = await render();
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['wrapper', 'free'],
    );
    await settle();
    expect(rows()).toHaveLength(2);

    // Another person (a sign-in in another tab, say): nothing of the previous one's list stays,
    // not even dimmed, and their own list and references are read.
    TestBed.inject(MeService).set({
      id: 'reviewer',
      kind: 'user',
      name: 'Reviewer',
      role: '',
      permissions: new Set(['content.read']),
    });
    await settle();
    expect(rows()).toEqual([]);
    answerGraph(http);
    answerList(
      http.expectOne((r) => r.url === '/api/module-summaries'),
      ['free'],
    );
    await settle();
    expect(rows().map((r) => r.textContent)).toEqual([
      expect.stringContaining('Free standing'),
    ]);
  });
});

describe('pickerStatus', () => {
  const of = (status: Record<string, unknown>) =>
    pickerStatus({ status } as unknown as GraphModule);
  it('reads in review, draft and released from where the module stands', () => {
    expect(
      of({ main: { same: true }, changeSets: [{ state: 'in-review' }] }),
    ).toBe('in-review');
    expect(of({ main: { same: false } })).toBe('draft');
    expect(of({ main: null })).toBe('draft');
    expect(of({ main: { same: true } })).toBe('released');
  });
});
