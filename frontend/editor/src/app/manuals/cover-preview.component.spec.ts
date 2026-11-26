import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';

import { provideZard } from '@openfolia/ui/core';

import {
  CoverPreviewComponent,
  type ThumbnailRequest,
} from './cover-preview.component';
import { advance } from '../testing/fake-time';

const REQUEST: ThumbnailRequest = {
  manualId: 'guide',
  variant: 'model=large',
  lang: 'de',
  ref: 'change-sets/1',
  live: true,
};
const PAGE = (n: number) =>
  `/api/manuals/guide/variants/model%3Dlarge/de/pdf/pages/${n}.png`;

let created: string[] = [];
let revoked: string[] = [];

async function render(request: ThumbnailRequest | null = REQUEST) {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([{ path: '**', children: [] }]),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideZard(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  // Fake time: the preview's debounce is waited out on the fake clock. The fake clock runs every
  // timer due in the step, in order, however slow the machine is (#562).
  vi.useFakeTimers();
  const fixture = TestBed.createComponent(CoverPreviewComponent);
  fixture.componentRef.setInput('title', 'Guide');
  fixture.componentRef.setInput('variant', {
    slug: 'model=large',
    label: 'Large',
  });
  fixture.componentRef.setInput('request', request);
  fixture.componentRef.setInput('previewParams', {
    manual: 'guide',
    variant: 'model=large',
  });
  const el = fixture.nativeElement as HTMLElement;
  const settle = async () => {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      await advance();
    }
    fixture.detectChanges();
  };
  await settle();
  const page = (n: number): TestRequest =>
    http.expectOne((r) => r.url === PAGE(n));
  const png = () => new Blob([new Uint8Array([0x89, 0x50])]);
  /** Answers both pages; `settle` between them, as the component asks one after the other. */
  const answerBoth = async () => {
    page(1).flush(png());
    await settle();
    page(2).flush(png());
    await settle();
  };
  const slot = (name: string) =>
    el.querySelector<HTMLElement>(`[data-slot="${name}"]`);
  return { fixture, http, el, settle, page, png, answerBoth, slot };
}

describe('CoverPreviewComponent', () => {
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
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('shows a skeleton, then the cover and the first page as PNGs, linked to the preview', async () => {
    const t = await render();
    expect(t.slot('thumbnails-loading')).not.toBeNull();
    const first = t.page(1);
    expect(first.request.params.get('ref')).toBe('change-sets/1');
    expect(first.request.params.get('workingCopy')).toBe('true');
    expect(first.request.params.get('width')).toBe('272');
    expect(first.request.responseType).toBe('blob');
    first.flush(t.png());
    await t.settle();
    t.page(2).flush(t.png());
    await t.settle();

    const link = t.slot('thumbnails') as HTMLAnchorElement;
    const images = link.querySelectorAll('img');
    expect(Array.from(images).map((i) => i.getAttribute('src'))).toEqual(
      created,
    );
    expect(images[0]?.alt).toBe('Cover page of Guide, Large');
    expect(link.getAttribute('aria-label')).toBe(
      'Open the preview of Guide, Large',
    );
    link.click();
    await t.settle();
    expect(TestBed.inject(Router).url).toBe(
      '/preview?manual=guide&variant=model%3Dlarge',
    );
    expect(t.slot('thumbnails-loading')).toBeNull();
  });

  it('reads committed content without workingCopy when not live', async () => {
    const t = await render({ ...REQUEST, live: false });
    const first = t.page(1);
    expect(first.request.params.has('workingCopy')).toBe(false);
    first.flush(t.png());
    await t.settle();
    t.page(2).flush(t.png());
    await t.settle();
  });

  it('shows only the cover of a one-page PDF', async () => {
    const t = await render();
    t.page(1).flush(t.png());
    await t.settle();
    t.page(2).flush(new Blob(['{}']), { status: 404, statusText: 'Not Found' });
    await t.settle();
    expect(t.slot('thumbnails')?.querySelectorAll('img').length).toBe(1);
  });

  it('after a save, keeps the old pages dimmed until the new ones are there', async () => {
    const t = await render();
    await t.answerBoth();
    const old = [...created];
    t.fixture.componentRef.setInput('delayMs', 40);
    t.fixture.componentRef.setInput('revision', 1);
    await t.settle();
    t.fixture.componentRef.setInput('revision', 2);
    await t.settle();
    // Debounced: nothing is asked until the saves stop.
    t.http.expectNone((r) => r.url === PAGE(1));
    await vi.advanceTimersByTimeAsync(60);
    await t.settle();
    const link = t.slot('thumbnails');
    expect(link?.classList).toContain('opacity-50');
    expect(link?.getAttribute('aria-busy')).toBe('true');
    expect(revoked).toEqual([]);
    await t.answerBoth();
    expect(t.slot('thumbnails')?.classList).not.toContain('opacity-50');
    // The old pages' URLs are released once the new ones show.
    expect(revoked).toEqual(old);
  });

  it('drops a render the request changed under, and releases its URLs', async () => {
    const t = await render();
    t.page(1).flush(t.png());
    await t.settle();
    // Another variant while page 2 of the first is still being asked for.
    t.fixture.componentRef.setInput('request', {
      ...REQUEST,
      variant: 'model=small',
    });
    await t.settle();
    t.page(2).flush(t.png());
    await t.settle();
    // The first run's URLs are released and nothing of it is shown.
    expect(revoked).toEqual(created);
    expect(t.slot('thumbnails')).toBeNull();
    const small = (n: number) => PAGE(n).replace('large', 'small');
    t.http.expectOne((r) => r.url === small(1)).flush(t.png());
    await t.settle();
    t.http.expectOne((r) => r.url === small(2)).flush(t.png());
    await t.settle();
    expect(t.slot('thumbnails')?.querySelectorAll('img').length).toBe(2);
  });

  it('cancels the page it is asking for when it closes (#935)', async () => {
    const t = await render();
    const first = t.page(1);
    t.fixture.destroy();
    expect(first.cancelled).toBe(true);
    await t.settle();
    // No page 2, nothing shown: `verify` finds no other request.
    expect(created).toEqual([]);
  });

  it('shows an error with Retry, which renders again', async () => {
    const t = await render();
    t.page(1).flush(new Blob(['{}']), {
      status: 500,
      statusText: 'Server Error',
    });
    await t.settle();
    const error = t.slot('thumbnails-error');
    expect(error?.textContent).toContain(
      'The PDF pages could not be rendered.',
    );
    error?.querySelector('button')?.click();
    await t.settle();
    await t.answerBoth();
    expect(t.slot('thumbnails-error')).toBeNull();
    expect(t.slot('thumbnails')?.querySelectorAll('img').length).toBe(2);
  });

  it('renders nothing without a request, and releases its URLs when destroyed', async () => {
    const empty = await render(null);
    expect(empty.el.querySelector('img, z-skeleton')).toBeNull();
    empty.fixture.destroy();
    TestBed.resetTestingModule();

    const t = await render();
    await t.answerBoth();
    t.fixture.destroy();
    expect(revoked).toEqual(created);
  });
});
