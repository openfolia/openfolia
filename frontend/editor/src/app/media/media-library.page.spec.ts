import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';
import { ToastService } from '@openfolia/ui/toast';

import { MeService } from '../permissions/me';
import { MediaLibraryPage } from './media-library.page';

const USED = 'a'.repeat(64);
const SPARE = 'b'.repeat(64);
const DOC = 'c'.repeat(64);

const config = {
  languages: { source: 'en', targets: ['de'] },
  moduleTypes: [],
  audiences: [],
  facets: [],
  variantAttributes: [],
  textAttributes: [],
  safetySymbols: [],
  outputLabels: {},
};

const asset = (
  hash: string,
  options: {
    title?: string;
    fileName?: string;
    contentType?: string;
    usedAs?: ('image' | 'attachment')[];
  } = {},
) => ({
  type: 'Asset',
  id: hash,
  attributes: {
    reference: `sha256:${hash}`,
    fileName: options.fileName ?? null,
    contentType: options.contentType ?? 'image/png',
    size: 2048,
    width: 640,
    height: 400,
  },
  meta: {
    usedIn: options.title
      ? [{ moduleId: 'pump', lang: 'en', title: options.title }]
      : [],
    usedInCount: options.title ? 1 : 0,
    languages: options.title ? ['en'] : [],
    usedAs: options.usedAs ?? ['image'],
    uploaded: false,
    missing: false,
  },
});

const page = (data: unknown[]) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 24, total: data.length },
  },
  links: { self: '', first: '', last: '', prev: null, next: null },
});

const flush = () => new Promise((resolve) => setTimeout(resolve));

async function render(url = '/media', editsEverything = true) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: 'media', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:local');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  TestBed.inject(MeService).set({
    id: 'u1',
    kind: 'user',
    name: 'U',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
    editsEverything,
  });
  const router = TestBed.inject(Router);
  await router.navigateByUrl(url);
  const fixture = TestBed.createComponent(MediaLibraryPage);
  const http = TestBed.inject(HttpTestingController);
  /** Renders what changed, leaving the requests it made open. */
  const draw = async () => {
    await flush();
    fixture.detectChanges();
    await flush();
  };
  const settle = async () => {
    await draw();
    // Thumbnails and the details' module reads: answered with nothing.
    http
      .match(
        (r) =>
          r.url.startsWith('/api/assets/') || r.url.startsWith('/api/modules/'),
      )
      .forEach((r) => r.flush(null, { status: 404, statusText: 'Not Found' }));
    fixture.detectChanges();
    await flush();
  };
  await settle();
  http
    .match('/api/config')
    .forEach((r) => r.flush({ data: { attributes: config } }));
  const list = (): TestRequest => {
    const found = http
      .match((r) => r.url === '/api/assets')
      .filter((r) => !r.cancelled);
    expect(found.length).toBeGreaterThan(0);
    return found.at(-1)!;
  };
  const el = fixture.nativeElement as HTMLElement;
  return { fixture, http, el, draw, settle, list, router };
}

describe('the media library', () => {
  afterEach(() => document.querySelector('.cdk-overlay-container')?.remove());

  it('shows the files as a grid of 320 renditions inside the frame, the pagination outside', async () => {
    const { el, draw, settle, list, http } = await render();
    const req = list();
    expect(req.request.params.get('page[size]')).toBe('24');
    expect(req.request.params.has('filter[unused]')).toBe(false);
    req.flush(
      page([
        asset(USED, { title: 'Pump' }),
        asset(DOC, {
          fileName: 'a-very-long-datasheet-name-without-any-break.pdf',
          contentType: 'application/pdf',
          usedAs: ['attachment'],
          title: 'Pump',
        }),
      ]),
    );
    await draw();
    const thumb = http.match((r) => r.url === `/api/assets/${USED}`)[0];
    expect(thumb?.request.params.get('width')).toBe('320');
    await settle();
    const scroller = el.querySelector('[data-slot="list-scroller"]')!;
    const tiles = [...scroller.querySelectorAll('[role="option"]')];
    expect(
      tiles.map((t) =>
        [...t.querySelectorAll('span, z-badge')]
          .filter((s) => s.children.length === 0)
          .map((s) => s.textContent?.trim()),
      ),
    ).toEqual([
      ['Pump', 'Used'],
      ['PDF', 'a-very-long-datasheet-name-without-any-break.pdf', 'Used'],
    ]);
    expect(
      scroller.contains(el.querySelector('[data-slot="list-pagination"]')),
    ).toBe(false);
    // Long names wrap.
    expect(tiles[1]?.innerHTML).toContain('[overflow-wrap:anywhere]');
  });

  it('names a file by the module title in the interface language when no language is chosen', async () => {
    const { el, settle, list } = await render();
    const shared = asset(USED);
    list().flush(
      page([
        {
          ...shared,
          meta: {
            ...shared.meta,
            usedIn: [
              { moduleId: 'charging', lang: 'de', title: 'Laden' },
              { moduleId: 'charging', lang: 'en', title: 'Charging' },
            ],
            usedInCount: 2,
            languages: ['de', 'en'],
          },
        },
      ]),
    );
    await settle();
    const tile = el.querySelector(
      '[data-slot="list-scroller"] [role="option"]',
    )!;
    expect(tile.textContent).toContain('Charging');
    expect(tile.textContent).not.toContain('Laden');
  });

  it('switches to the table, kept in the address', async () => {
    const { el, settle, list, router, http } = await render();
    list().flush(page([asset(USED, { title: 'Pump' })]));
    await settle();
    const table = [
      ...el.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ].find((i) => i.value === 'table')!;
    table.click();
    await settle();
    expect(router.url).toBe('/media?view=table');
    // The same page, shown otherwise: nothing read again.
    expect(http.match((r) => r.url === '/api/assets')).toHaveLength(0);
    const row = el.querySelector('[data-slot="media-row"]')!;
    expect(row.textContent).toContain('Pump');
    expect(row.textContent).toContain('PNG');
    expect(row.textContent).toContain('2 kB');
    expect(row.textContent).toContain('640 × 400 px');
  });

  it('filters by type and language, and lists the unused files without a language', async () => {
    const { list, settle } = await render('/media?type=image&lang=de&q=pump');
    let req = list();
    expect(req.request.params.get('filter[type]')).toBe('image');
    expect(req.request.params.get('filter[lang]')).toBe('de');
    expect(req.request.params.get('filter[q]')).toBe('pump');
    req.flush(page([]));
    await settle();
    TestBed.resetTestingModule();
    const unused = await render('/media?usage=unused&lang=de');
    req = unused.list();
    expect(req.request.params.get('filter[unused]')).toBe('true');
    expect(req.request.params.has('filter[lang]')).toBe(false);
    req.flush(page([]));
    await unused.settle();
    expect(unused.el.textContent).toContain('No unused files');
  });

  it('does not list unused files for a role whose scope is restricted', async () => {
    const { list, el, settle, router } = await render(
      '/media?usage=unused',
      false,
    );
    await settle();
    const req = list();
    expect(req.request.params.has('filter[unused]')).toBe(false);
    req.flush(page([]));
    await settle();
    expect(router.url).toBe('/media');
    expect(el.textContent).not.toContain('Usage');
  });

  it('opens a file linked by its hash, on the unused list when nothing uses it (#404)', async () => {
    const link = `/media?q=${SPARE}&file=${SPARE}`;
    const { list, settle, router, el } = await render(link);
    let req = list();
    expect(req.request.params.get('filter[q]')).toBe(SPARE);
    expect(req.request.params.has('filter[unused]')).toBe(false);
    req.flush(page([]));
    await settle();
    req = list();
    expect(req.request.params.get('filter[unused]')).toBe('true');
    expect(req.request.params.get('filter[q]')).toBe(SPARE);
    req.flush(page([asset(SPARE, { fileName: 'spare.png' })]));
    await settle();
    expect(router.url).toContain('usage=unused');
    expect(router.url).toContain(`file=${SPARE}`);
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(1);
    TestBed.resetTestingModule();
    // A role that may not list unused files stays on the usual list.
    const restricted = await render(link, false);
    restricted.list().flush(page([]));
    await restricted.settle();
    expect(restricted.router.url).not.toContain('usage=unused');
  });

  it('moves through the grid with the arrow keys and opens the details', async () => {
    const { el, settle, list, router, http } = await render();
    list().flush(
      page([asset(USED, { title: 'Pump' }), asset(SPARE, { title: 'Valve' })]),
    );
    await settle();
    const grid = el.querySelector<HTMLElement>('[data-slot="media-grid"]')!;
    const tiles = [...grid.querySelectorAll<HTMLElement>('[role="option"]')];
    expect(tiles.map((t) => t.tabIndex)).toEqual([0, -1]);
    tiles[0]!.focus();
    tiles[0]!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
    );
    await settle();
    expect(document.activeElement).toBe(tiles[1]);
    tiles[1]!.click();
    await settle();
    expect(router.url).toBe(`/media?file=${SPARE}`);
    // Opening a file reads no list again.
    expect(http.match((r) => r.url === '/api/assets')).toHaveLength(0);
    const detail = el.querySelector('[data-slot="media-detail"]')!;
    expect(detail.textContent).toContain('Valve');
    expect(tiles[1]!.getAttribute('aria-selected')).toBe('true');
  });

  it('swaps the details in place on another file, and closes them back to the clicked tile', async () => {
    const { el, settle, list, router } = await render();
    list().flush(
      page([asset(USED, { title: 'Pump' }), asset(SPARE, { title: 'Valve' })]),
    );
    await settle();
    const panel = el.querySelector<HTMLElement>('[data-slot="side-panel"]')!;
    expect(panel.getAttribute('data-state')).toBe('closed');
    const tiles = [...el.querySelectorAll<HTMLElement>('[role="option"]')];
    tiles[0]!.focus();
    tiles[0]!.click();
    await settle();
    expect(panel.getAttribute('data-state')).toBe('open');
    // Focus moves into the details.
    expect(
      panel
        .querySelector('[data-slot="media-detail"]')!
        .contains(document.activeElement),
    ).toBe(true);

    tiles[1]!.focus();
    tiles[1]!.click();
    await settle();
    expect(router.url).toBe(`/media?file=${SPARE}`);
    // Not closed and reopened: the same panel, open, the new file in front.
    expect(el.querySelector('[data-slot="side-panel"]')).toBe(panel);
    expect(panel.getAttribute('data-state')).toBe('open');
    const current = [
      ...panel.querySelectorAll('[data-layer]:not([aria-hidden])'),
    ];
    expect(current).toHaveLength(1);
    expect(current[0]!.textContent).toContain('Valve');

    const close = [...panel.querySelectorAll<HTMLButtonElement>('button')]
      .filter((b) => !b.closest('[aria-hidden]'))
      .find((b) => b.getAttribute('aria-label') === 'Close details')!;
    close.focus();
    close.click();
    await settle();
    expect(router.url).toBe('/media');
    // The details stay on screen, inert, while the panel shrinks; focus is back on the tile.
    expect(panel.getAttribute('data-state')).toBe('closing');
    expect(panel.textContent).toContain('Valve');
    expect(document.activeElement).toBe(tiles[1]);
  });

  it('deletes an unused file with Undo: hidden at once, sent when the toast ends', async () => {
    const { el, settle, list, http } = await render(
      `/media?usage=unused&file=${SPARE}`,
    );
    list().flush(page([asset(SPARE)]));
    await settle();
    const del = [...el.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.getAttribute('aria-label')?.startsWith('Delete '),
    )!;
    del.click();
    await settle();
    expect(el.querySelectorAll('[role="option"]')).toHaveLength(0);
    http.expectNone(`/api/assets/${SPARE}`);
    const toast = TestBed.inject(ToastService);
    toast.dismiss(toast.toasts().at(-1)!.id);
    await flush();
    const request = http
      .match((r) => r.url === `/api/assets/${SPARE}` && r.method === 'DELETE')
      .at(0)!;
    request.flush(null, { status: 204, statusText: 'No Content' });
    await settle();
    // The list is read again.
    list().flush(page([]));
    await settle();
    expect(el.textContent).toContain('No unused files');
  });
});
