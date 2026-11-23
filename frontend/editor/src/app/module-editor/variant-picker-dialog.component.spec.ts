import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { parseCondition } from '@openfolia/content-model/core';

import { provideZard } from '@openfolia/ui/core';

import { apiErrorInterceptor } from '../api/api-interceptors';
import type { VariantPick } from '../doc-editor/blocks/doc-blocks-context';
import { MeService } from '../permissions/me';
import {
  VariantPickerDialogComponent,
  type VariantPickRequest,
} from './variant-picker-dialog.component';

const links = { self: '', first: '', last: '', prev: null, next: null };
const pageMeta = (total: number, perPage = 10) => ({
  page: {
    currentPage: 1,
    lastPage: Math.max(1, Math.ceil(total / perPage)),
    perPage,
    total,
  },
});

const ATTRIBUTES = [
  {
    type: 'VariantAttribute',
    id: 'model',
    attributes: {
      kind: 'enum',
      label: 'Model',
      values: [
        { id: 'small', label: 'Small' },
        { id: 'large', label: 'Large' },
      ],
    },
  },
  {
    type: 'VariantAttribute',
    id: 'market',
    attributes: {
      kind: 'enum',
      label: 'Market',
      values: [
        { id: 'eu', label: 'Europe' },
        { id: 'us', label: 'United States' },
      ],
    },
  },
  {
    type: 'VariantAttribute',
    id: 'software',
    attributes: { kind: 'version', label: 'Software' },
  },
];

const build = (manual: string, slug: string, label: string) => ({
  type: 'VariantBuild',
  id: `${manual}/${slug}`,
  attributes: { values: {} },
  relationships: { manual: { data: { type: 'Manual', id: manual } } },
  meta: { slug, label, manualTitle: `Manual ${manual}` },
});

@Component({
  imports: [VariantPickerDialogComponent],
  template: `<of-variant-picker-dialog
    [request]="request()"
    (done)="answers.push($event); request.set(null)"
  />`,
})
class Host {
  readonly request = signal<VariantPickRequest | null>(null);
  readonly answers: (VariantPick | null)[] = [];
}

async function render(current: string | null = null) {
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
  // Fake time: each test waits out the builds' debounce several times. On real timers those
  // waits added up to about 2 s a test, and a loaded machine ran them late enough to near
  // Vitest's 5 s timeout (#499). The setup file restores real timers after each test.
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(Host);
  const http = TestBed.inject(HttpTestingController);
  // Not `whenStable`: the variants' resource keeps the app busy until its request is answered.
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
    }
  };
  /** Past the debounce before the builds are asked for. */
  const pause = async () => {
    await vi.advanceTimersByTimeAsync(350);
    await settle();
  };
  fixture.componentInstance.request.set({
    current: current === null ? null : parseCondition(current),
    moduleTitle: 'Battery',
  });
  await settle();
  const dialog = () =>
    document.querySelector<HTMLElement>('z-dialog-panel') as HTMLElement;
  const button = (text: string) =>
    Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find(
      (b) => b.textContent?.trim() === text,
    ) as HTMLButtonElement;
  const text = () =>
    dialog().querySelector<HTMLTextAreaElement>('#variant-picker-text')!;
  const type = async (value: string) => {
    text().value = value;
    text().dispatchEvent(new Event('input'));
    await settle();
  };
  const checkbox = (label: string) =>
    Array.from(dialog().querySelectorAll<HTMLElement>('z-checkbox')).find(
      (c) => c.textContent?.trim() === label,
    )!;
  const check = async (label: string) => {
    checkbox(label).querySelector('input')!.click();
    await settle();
  };
  const checked = (label: string) =>
    checkbox(label).querySelector('input')!.checked;
  const appearsIn = () =>
    dialog().querySelector('[data-appears-in]')?.textContent?.trim();
  return {
    fixture,
    http,
    settle,
    pause,
    dialog,
    button,
    text,
    type,
    check,
    checked,
    appearsIn,
  };
}

function answerAttributes(http: HttpTestingController) {
  const req = http.expectOne((r) => r.url === '/api/variants');
  expect(req.request.params.get('page[size]')).toBe('200');
  req.flush({ data: ATTRIBUTES, meta: pageMeta(3, 200), links });
}

function matches(http: HttpTestingController): TestRequest {
  return http.expectOne((r) => r.url === '/api/variants/matches');
}

describe('VariantPickerDialogComponent', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove());
  });

  it('builds a condition from the groups, keeps the text in sync and shows its builds', async () => {
    const { http, pause, dialog, button, text, check, appearsIn, fixture } =
      await render();
    answerAttributes(http);
    await pause();
    expect(dialog().textContent).toContain('Show this block for');
    expect(dialog().textContent).toContain('Variant block · Battery');
    // Every attribute from the API is a group; nothing is chosen yet.
    expect(
      Array.from(dialog().querySelectorAll('fieldset legend')).map((l) =>
        l.textContent?.trim(),
      ),
    ).toEqual(['Model', 'Market', 'Software']);
    expect(button('Apply').getAttribute('aria-disabled')).toBe('true');
    expect(dialog().textContent).toContain(
      'Choose at least one value, or type a condition.',
    );
    expect(appearsIn()).toContain('Choose values to see the builds');

    await check('Large');
    await check('Small');
    await check('United States');
    expect(text().value).toBe('model in (small, large) && market in (us)');
    expect(dialog().querySelector('[data-rule]')?.textContent).toMatch(
      /Show if\s+Model\s+is\s+Small\s+or\s+Large\s+and\s+Market\s+is\s+United States/,
    );

    // Asked for once the clicks pause, with the text.
    await pause();
    const req = matches(http);
    expect(req.request.params.get('when')).toBe(
      'model in (small, large) && market in (us)',
    );
    expect(req.request.params.get('page[size]')).toBe('10');
    req.flush({
      data: [build('a', 'model=small', 'Small · United States')],
      meta: pageMeta(1),
      links,
    });
    await pause();
    expect(appearsIn()).toBe('Appears in 1 build');
    const row = dialog().querySelector('[data-build]')!;
    expect(row.textContent).toContain('Manual a');
    expect(row.textContent).toContain('Small · United States');

    // Any group may match.
    (
      Array.from(
        dialog().querySelectorAll<HTMLInputElement>('input[type=radio]'),
      ).find((r) => r.value === 'any') as HTMLInputElement
    ).click();
    await pause();
    expect(text().value).toBe('model in (small, large) || market in (us)');
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    expect(appearsIn()).toBe('Appears in no build');

    button('Apply').click();
    expect(fixture.componentInstance.answers).toEqual([
      parseCondition('model in (small, large) || market in (us)'),
    ]);
  });

  it('keeps the builds in one place of one height, chosen or not, loading or loaded (#793)', async () => {
    const { http, pause, dialog, check } = await render();
    answerAttributes(http);
    await pause();
    const area = () =>
      dialog().querySelector<HTMLElement>('[data-builds-area]');
    // Nothing chosen yet: the place the builds will take is there already, a quiet placeholder.
    const first = area();
    expect(first).not.toBeNull();
    expect(first!.classList).toContain('h-56');
    expect(first!.querySelector('[data-builds-placeholder]')).not.toBeNull();

    // Chosen and asked for: the same place, now with the list frame (loading, then loaded).
    await check('Small');
    await pause();
    expect(area()).toBe(first);
    expect(first!.querySelector('of-list-frame')).not.toBeNull();
    expect(first!.querySelector('[data-builds-placeholder]')).toBeNull();
    matches(http).flush({
      data: [build('a', 'model=small', 'Small')],
      meta: pageMeta(1),
      links,
    });
    await pause();
    expect(area()).toBe(first);
    expect(first!.querySelector('[data-build]')).not.toBeNull();
  });

  it('reads a typed condition into the groups, and keeps one they cannot show as text', async () => {
    const { http, pause, dialog, button, type, checked, fixture } =
      await render('model in (large)');
    answerAttributes(http);
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    expect(checked('Large')).toBe(true);
    expect(checked('Small')).toBe(false);

    await type('model in (small) && !(market in (eu))');
    expect(checked('Large')).toBe(false);
    expect(checked('Small')).toBe(true);
    expect(dialog().querySelector('[data-rule]')?.textContent).toMatch(
      /Market\s+is not\s+Europe/,
    );

    // Typed with "or": the way groups combine follows the text.
    await type('model in (small) || market in (eu)');
    expect(
      dialog().querySelector<HTMLInputElement>('input[type=radio][value=any]')!
        .checked,
    ).toBe(true);
    expect(dialog().querySelector('[data-rule]')?.textContent).toMatch(
      /Small\s+or\s+Market/,
    );

    await type('(model in (small) || market in (eu)) && software >= 2');
    expect(dialog().textContent).toContain(
      'The groups can’t show this condition',
    );
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    button('Apply').click();
    expect(fixture.componentInstance.answers).toEqual([
      parseCondition('(model in (small) || market in (eu)) && software >= 2'),
    ]);
  });

  it('hides an archived value unless the condition names it (#91)', async () => {
    const { http, pause, dialog, type, checked } =
      await render('market in (eu)');
    const archived = ATTRIBUTES.map((a) =>
      a.id === 'market' && a.attributes.kind === 'enum'
        ? {
            ...a,
            attributes: {
              ...a.attributes,
              values: [
                { id: 'eu', label: 'Europe', archived: true },
                { id: 'us', label: 'United States', archived: true },
              ],
            },
          }
        : a,
    );
    http
      .expectOne((r) => r.url === '/api/variants')
      .flush({ data: archived, meta: pageMeta(3, 200), links });
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    const values = () =>
      Array.from(
        dialog().querySelectorAll('[data-attribute=market] z-checkbox'),
      ).map((c) => c.textContent?.trim());
    // Still named: offered, so it can be taken out.
    expect(values()).toEqual(['Europe']);
    expect(checked('Europe')).toBe(true);
    await type('model in (small)');
    expect(values()).toEqual([]);
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
  });

  it('shows the API’s refusals at the text and blocks Apply', async () => {
    const { http, pause, dialog, button, type } = await render();
    answerAttributes(http);
    await pause();

    await type('model in (');
    await pause();
    matches(http).flush(
      {
        errors: [
          {
            status: '400',
            title: 'Invalid parameter',
            detail: 'expected ")"',
            code: 'invalid-parameter',
            source: { parameter: 'when' },
          },
        ],
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await pause();
    expect(
      dialog().querySelector('#variant-picker-problems')?.textContent,
    ).toContain('This condition can’t be read.');
    expect(button('Apply').getAttribute('aria-disabled')).toBe('true');

    await type('model in (huge) || colour in (red)');
    await pause();
    matches(http).flush(
      {
        errors: [
          {
            status: '422',
            title: 'Unprocessable',
            detail: 'variant attribute "colour" is not configured',
            code: 'unknown-variant',
            meta: { issue: 'unknown-variant-attribute' },
          },
          {
            status: '422',
            title: 'Unprocessable',
            detail: '"huge" is not a value of variant attribute "model"',
            code: 'unknown-variant',
            meta: { issue: 'unknown-variant-value' },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable Entity' },
    );
    await pause();
    const problems = dialog().querySelector(
      '#variant-picker-problems',
    )!.textContent!;
    expect(problems).toContain('There is no variant attribute “colour”.');
    expect(problems).toContain('“huge” is not a value of Model.');
    expect(button('Apply').getAttribute('aria-disabled')).toBe('true');
    expect(dialog().textContent).toContain(
      'The condition names something the configuration does not hold.',
    );
  });

  it('compares versions and refuses one that is not a version', async () => {
    const { http, pause, dialog, button, text, settle } = await render();
    answerAttributes(http);
    await pause();
    const software = dialog().querySelector(
      'fieldset[data-attribute="software"]',
    )!;
    expect(software.textContent).toContain('Any version');
    Array.from(software.querySelectorAll<HTMLButtonElement>('button'))
      .find((b) => b.textContent?.includes('Add comparison'))!
      .click();
    await settle();
    const version = software.querySelector<HTMLInputElement>('input[z-input]')!;
    version.value = '2.3';
    version.dispatchEvent(new Event('input'));
    await settle();
    expect(text().value).toBe('software >= 2.3');
    expect(dialog().querySelector('[data-rule]')?.textContent).toMatch(
      /Software\s+is\s+at least 2.3/,
    );
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });

    version.value = '2.x';
    version.dispatchEvent(new Event('input'));
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    expect(
      dialog().querySelector('#variant-picker-problems')?.textContent,
    ).toContain('“2.x” is not a version of Software');
    expect(button('Apply').getAttribute('aria-disabled')).toBe('true');
  });

  it('removes the condition, or cancels', async () => {
    const { http, pause, button, fixture } = await render('model in (large)');
    answerAttributes(http);
    await pause();
    matches(http).flush({ data: [], meta: pageMeta(0), links });
    await pause();
    button('Remove condition').click();
    expect(fixture.componentInstance.answers).toEqual(['remove']);
  });

  it('says when the variants cannot be read, with a retry', async () => {
    const { http, pause, dialog, button } = await render();
    http
      .expectOne((r) => r.url === '/api/variants')
      .flush(
        {
          errors: [
            { status: '503', title: 'Busy', detail: '', code: 'shutting-down' },
          ],
        },
        { status: 503, statusText: 'Service Unavailable' },
      );
    await pause();
    expect(dialog().textContent).toContain('The variants could not be loaded');
    button('Try again')?.click();
    await pause();
    answerAttributes(http);
    await pause();
    expect(dialog().querySelectorAll('fieldset').length).toBe(3);
    button('Cancel').click();
  });
});
