import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { provideZard } from '@openfolia/ui/core';

import {
  DesignPreviewComponent,
  FIRST_INNER_PAGE,
  type DesignPreviewRequest,
} from './design-preview.component';
import { advance } from '../../testing/fake-time';

const REQUEST: DesignPreviewRequest = {
  manualId: 'guide',
  variant: 'model=large',
  lang: 'de',
  designId: 'ours',
  ref: 'change-sets/cs1',
  live: true,
};
const BASE = '/api/manuals/guide/variants/model%3Dlarge/de/pdf';
const PAGE = (n: number) => `${BASE}/pages/${n}.png`;
const WARNINGS =
  '/api/manuals/guide/variants/model%3Dlarge/de/pdf/layout-warnings';

const warning = (at: string, page = 4, pages = 1) => ({
  type: 'LayoutWarning',
  id: `running-head-truncated:${at}`,
  attributes: { code: 'running-head-truncated', at, page, pages },
});
const warningPage = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 50, total: data.length },
  },
  links: {},
});

let created: string[] = [];
let revoked: string[] = [];

async function render(request: DesignPreviewRequest | null = REQUEST) {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideZard()],
  });
  const http = TestBed.inject(HttpTestingController);
  // On fake time: the render's debounce and the change detection it starts run in order,
  // however loaded the machine is (#585, the rule in the README).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(DesignPreviewComponent);
  fixture.componentRef.setInput('request', request);
  fixture.componentRef.setInput('delayMs', 0);
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 4; i++) await advance();
    fixture.detectChanges();
  };
  await settle();
  const page = (n: number): TestRequest =>
    http.expectOne((r) => r.url === PAGE(n));
  const png = () => new Blob([new Uint8Array([0x89, 0x50])]);
  /** Answers the title page, the inner page and the warnings. */
  const answer = async (warnings: unknown[] = []) => {
    page(1).flush(png());
    await settle();
    page(FIRST_INNER_PAGE).flush(png());
    await settle();
    http.expectOne((r) => r.url === WARNINGS).flush(warningPage(warnings));
    await settle();
  };
  const slot = (name: string) =>
    el.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  const images = () =>
    Array.from(el.querySelectorAll<HTMLImageElement>('img')).map((i) =>
      i.getAttribute('src'),
    );
  return { fixture, http, el, settle, page, png, answer, slot, images };
}

describe('DesignPreviewComponent', () => {
  beforeEach(() => {
    created = [];
    revoked = [];
    let n = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => {
      const url = `blob:test/${++n}`;
      created.push(url);
      return url;
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revoked.push(url);
    });
  });
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('renders the title page and an inner page with the design under edit, then its warnings', async () => {
    const t = await render();
    const first = t.page(1);
    expect(first.request.params.get('design')).toBe('ours');
    expect(first.request.params.get('ref')).toBe('change-sets/cs1');
    expect(first.request.params.get('workingCopy')).toBe('true');
    expect(first.request.responseType).toBe('blob');
    first.flush(t.png());
    await t.settle();
    t.page(FIRST_INNER_PAGE).flush(t.png());
    await t.settle();
    const warnings = t.http.expectOne((r) => r.url === WARNINGS);
    expect(warnings.request.params.get('design')).toBe('ours');
    expect(warnings.request.params.get('workingCopy')).toBe('true');
    warnings.flush(warningPage([warning('header.default.centre', 4, 3)]));
    await t.settle();

    expect(t.images()).toEqual(created);
    const item = t.el.querySelector('[data-warning]');
    expect(item?.getAttribute('data-at')).toBe('header.default.centre');
    expect(item?.textContent).toContain('running header');
    expect(item?.textContent).toContain('on 3 pages, first on page 4');
  });

  it('shapes the page boxes by the page size: A4, US Letter and A5 (#668)', async () => {
    const t = await render(null);
    const boxes = () =>
      Array.from(
        t.el.querySelectorAll<HTMLElement>(
          '[data-slot="design-preview-pages"] figure > div',
        ),
      ).map((b) => b.style.aspectRatio.replace(/\s+/g, ''));
    expect(boxes()).toEqual(['210/297', '210/297']);
    t.fixture.componentRef.setInput('pageSize', 'us-letter');
    await t.settle();
    expect(boxes()).toEqual(['215.9/279.4', '215.9/279.4']);
    t.fixture.componentRef.setInput('pageSize', 'a5');
    await t.settle();
    expect(boxes()).toEqual(['148/210', '148/210']);
  });

  it('keeps the pages when the first save turns the working copy on, and renders again', async () => {
    const t = await render({ ...REQUEST, live: false });
    await t.answer();
    const before = t.images();
    t.fixture.componentRef.setInput('request', { ...REQUEST, live: true });
    await t.settle();
    // Debounced like a save: the old pages stay, the pager is not reset.
    expect(t.images()).toEqual(before);
    const first = t.page(1);
    expect(first.request.params.get('workingCopy')).toBe('true');
    expect(t.images()).toEqual(before);
    first.flush(t.png());
    await t.settle();
    t.page(FIRST_INNER_PAGE).flush(t.png());
    await t.settle();
    t.http.expectOne((r) => r.url === WARNINGS).flush(warningPage([]));
    await t.settle();
    expect(t.images()).toEqual(created.slice(2));
  });

  it('renders again after a save, keeping the old pages until the new ones are there', async () => {
    const t = await render();
    await t.answer();
    const before = t.images();
    expect(before).toHaveLength(2);

    t.fixture.componentRef.setInput('revision', 1);
    await t.settle();
    t.page(1).flush(t.png());
    await t.settle();
    // The new title page is in, the inner page not yet: the old pages stay.
    expect(t.images()).toEqual(before);
    expect(revoked).toEqual([]);
    t.page(FIRST_INNER_PAGE).flush(t.png());
    await t.settle();
    t.http.expectOne((r) => r.url === WARNINGS).flush(warningPage([]));
    await t.settle();
    expect(t.images()).toEqual(created.slice(2));
    expect(revoked).toEqual(before);
    expect(t.slot('no-warnings')).not.toBeNull();
  });

  it('shows the last page when the manual has fewer pages than asked for', async () => {
    const t = await render();
    t.page(1).flush(t.png());
    await t.settle();
    t.page(FIRST_INNER_PAGE).flush(
      new Blob([
        JSON.stringify({
          errors: [{ status: '404', code: 'not-found', meta: { pages: 2 } }],
        }),
      ]),
      { status: 404, statusText: 'Not Found' },
    );
    await t.settle();
    t.page(2).flush(t.png());
    await t.settle();
    t.http.expectOne((r) => r.url === WARNINGS).flush(warningPage([]));
    await t.settle();
    expect(t.images()).toHaveLength(2);
  });

  it('reads released content without the working copy, and says when it cannot render', async () => {
    const t = await render({ ...REQUEST, ref: null, live: false });
    const first = t.page(1);
    expect(first.request.params.has('ref')).toBe(false);
    expect(first.request.params.has('workingCopy')).toBe(false);
    first.flush(new Blob(['{}']), { status: 500, statusText: 'Server Error' });
    await t.settle();
    expect(t.slot('preview-error')).not.toBeNull();
    (
      t.slot('preview-error')?.querySelector('button') as HTMLButtonElement
    ).click();
    await t.settle();
    await t.answer();
    expect(t.slot('preview-error')).toBeNull();
    expect(t.images()).toHaveLength(2);
  });

  it('shows where the design’s own template does not compile, and no pages (#396)', async () => {
    const t = await render();
    const body = {
      errors: [
        {
          status: '422',
          code: 'template-error',
          title: 'Unprocessable',
          detail: 'The template does not compile.',
          meta: {
            design: 'house',
            template: 'own',
            problems: [
              {
                file: 'templates/own/manual.typ',
                line: 12,
                column: 3,
                message: 'unknown variable: notice',
                trace: [],
              },
              { file: 7, line: 'x', message: null },
            ],
          },
        },
      ],
    };
    t.page(1).flush(new Blob([JSON.stringify(body)]), {
      status: 422,
      statusText: 'Unprocessable Entity',
    });
    await t.settle();
    const problems = t.slot('template-problems');
    expect(problems).not.toBeNull();
    const items = problems?.querySelectorAll('[data-slot="template-problem"]');
    expect(items).toHaveLength(2);
    expect(items?.[0]?.textContent).toContain('unknown variable: notice');
    expect(items?.[0]?.textContent).toContain('templates/own/manual.typ');
    expect(t.images()).toHaveLength(0);
    // Nor does it say that everything fits.
    expect(t.slot('no-warnings')).toBeNull();
  });

  it('retries only the warnings when their read failed, without rendering the pages again (#557)', async () => {
    const t = await render();
    t.page(1).flush(t.png());
    await t.settle();
    t.page(FIRST_INNER_PAGE).flush(t.png());
    await t.settle();
    t.http
      .expectOne((r) => r.url === WARNINGS)
      .flush({}, { status: 500, statusText: 'Server Error' });
    await t.settle();
    const pages = t.images();
    expect(pages).toHaveLength(2);
    // The pages are fine: only the warnings say they failed, with their own retry.
    expect(t.slot('preview-error')).toBeNull();
    expect(t.slot('no-warnings')).toBeNull();
    const retry = t.slot('warnings-error')?.querySelector('button');
    expect(retry).toBeTruthy();
    (retry as HTMLButtonElement).click();
    await t.settle();
    t.http.expectNone((r) => r.url.includes('/pdf/pages/'));
    t.http
      .expectOne((r) => r.url === WARNINGS)
      .flush(warningPage([warning('header.default.left')]));
    await t.settle();
    expect(t.slot('warnings-error')).toBeNull();
    expect(t.el.querySelector('[data-warning]')).not.toBeNull();
    expect(t.images()).toEqual(pages);
  });

  it('cancels a render still under way when a newer save comes, keeping the old pages (#557)', async () => {
    const t = await render();
    await t.answer();
    const before = t.images();
    t.fixture.componentRef.setInput('delayMs', 50);
    t.fixture.componentRef.setInput('revision', 1);
    await advance(60);
    await t.settle();
    t.page(1).flush(t.png());
    await t.settle();
    const stale = t.page(FIRST_INNER_PAGE);
    // Another save while the inner page renders: its request is cancelled at once.
    t.fixture.componentRef.setInput('revision', 2);
    await t.settle();
    expect(stale.cancelled).toBe(true);
    expect(t.images()).toEqual(before);
    await advance(60);
    await t.settle();
    t.page(1).flush(t.png());
    await t.settle();
    t.page(FIRST_INNER_PAGE).flush(t.png());
    await t.settle();
    t.http.expectOne((r) => r.url === WARNINGS).flush(warningPage([]));
    await t.settle();
    expect(t.images()).toHaveLength(2);
    expect(t.images()).not.toEqual(before);
  });
});
