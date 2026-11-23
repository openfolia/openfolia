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
  DeprecateDialogComponent,
  type Deprecation,
  type DeprecateTarget,
} from './deprecate-dialog.component';

const links = { self: '', first: '', last: '', prev: null, next: null };
const page = <T>(data: T[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: data.length },
  },
  links,
});

const summary = (id: string, title: string) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    title,
    moduleType: 'concept',
    facets: {},
    languages: ['en'],
  },
  meta: { changed: false },
});

const manual = (id: string, title: string, deprecated?: Deprecation) => ({
  type: 'Manual',
  id,
  attributes: {
    title,
    variants: [{}],
    entries: [],
    textAttributes: {},
    ...(deprecated && { deprecated }),
  },
  meta: { issues: [], variants: [] },
});

@Component({
  imports: [DeprecateDialogComponent],
  template: `<of-deprecate-dialog
    [target]="target()"
    (confirm)="confirmed.push($event)"
    (closed)="closed = closed + 1"
  />`,
})
class Host {
  readonly target = signal<DeprecateTarget | null>(null);
  readonly confirmed: Deprecation[] = [];
  closed = 0;
}

async function render(target: DeprecateTarget) {
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

const dialog = () => document.querySelector('z-dialog-panel') as HTMLElement;
const reason = () =>
  dialog().querySelector('#deprecate-reason') as HTMLInputElement;
const confirmButton = () =>
  dialog().querySelector(
    '[data-slot="deprecate-confirm"]',
  ) as HTMLButtonElement;

function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

describe('DeprecateDialogComponent', () => {
  afterEach(() =>
    document.querySelectorAll('z-dialog-panel').forEach((e) => e.remove()),
  );

  it('asks for a reason before it deprecates', async () => {
    const { host, http, settle } = await render({
      kind: 'module',
      id: 'charging',
      title: 'Charging',
    });
    http
      .expectOne(
        (r) =>
          r.url === '/api/module-summaries' &&
          r.params.get('filter[deprecated]') === 'false',
      )
      .flush(page([summary('charging', 'Charging')]));
    await settle();
    expect(dialog().textContent).toContain('Deprecate “Charging”');
    confirmButton().click();
    await settle();
    expect(host.confirmed).toEqual([]);
    expect(dialog().textContent).toContain('Give a reason.');
    expect(reason().getAttribute('aria-invalid')).toBe('true');

    type(reason(), '  Superseded\n by   the safety note. ');
    await settle();
    confirmButton().click();
    expect(host.confirmed).toEqual([
      { reason: 'Superseded by the safety note.' },
    ]);
  });

  it('offers the modules that are not deprecated, itself left out, as the replacement', async () => {
    const { host, http, settle } = await render({
      kind: 'module',
      id: 'charging',
      title: 'Charging',
    });
    http
      .expectOne((r) => r.url === '/api/module-summaries')
      .flush(
        page([
          summary('charging', 'Charging'),
          summary('safety-note', 'Safety note'),
        ]),
      );
    await settle();
    (
      dialog().querySelector(
        '[data-slot="deprecate-replacement"] button',
      ) as HTMLElement
    ).click();
    await settle();
    const options = Array.from(
      document.querySelectorAll<HTMLElement>('z-select-item'),
    );
    expect(options.map((o) => o.textContent?.trim())).toEqual([
      'No replacement',
      'Safety note',
    ]);
    options[1]?.click();
    await settle();
    type(reason(), 'Merged.');
    await settle();
    confirmButton().click();
    expect(host.confirmed).toEqual([
      { reason: 'Merged.', replacedBy: 'safety-note' },
    ]);
  });

  it('offers manuals that are not deprecated for a manual, and closes on Cancel', async () => {
    const { host, http, settle } = await render({
      kind: 'manual',
      id: 'service',
      title: 'Service',
    });
    http
      .expectOne((r) => r.url === '/api/manuals')
      .flush(
        page([
          manual('service', 'Service'),
          manual('operating', 'Operating'),
          manual('old', 'Old', { reason: 'Gone.' }),
        ]),
      );
    await settle();
    (
      dialog().querySelector(
        '[data-slot="deprecate-replacement"] button',
      ) as HTMLElement
    ).click();
    await settle();
    expect(
      Array.from(document.querySelectorAll<HTMLElement>('z-select-item')).map(
        (o) => o.textContent?.trim(),
      ),
    ).toEqual(['No replacement', 'Operating']);
    const cancel = Array.from(
      dialog().querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => b.textContent?.trim() === 'Cancel');
    cancel?.click();
    expect(host.closed).toBe(1);
  });
});
