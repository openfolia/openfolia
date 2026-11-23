import { Component, inject } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import {
  chunks,
  ID_CHARS_PER_READ,
  IDS_PER_READ,
  OutlineSummaries,
  RETRY_FIRST,
} from './outline-summaries';

@Component({ template: '', providers: [OutlineSummaries] })
class Page {
  readonly outline = inject(OutlineSummaries);
}

const summary = (id: string) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    moduleId: id,
    title: id.toUpperCase(),
    titleLang: 'en',
    moduleType: 'concept',
    facets: {},
    keywords: [],
    languages: ['en'],
    variants: [],
  },
  meta: { changed: false },
});

const busy = { status: 503, statusText: 'Service Unavailable' };

describe('OutlineSummaries', () => {
  it('backs off after a failed read and says so once, however often the outline changes (#561)', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(Page);
    const { outline } = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    const errors = vi.spyOn(TestBed.inject(ToastService), 'error');
    const reads = () =>
      http.match(
        (r) => r.url === '/api/module-summaries' && r.params.has('filter[id]'),
      );

    void outline.want(['a']);
    await vi.advanceTimersByTimeAsync(0);
    for (const r of reads()) r.flush(null, busy);
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toHaveBeenCalledTimes(1);

    // Ten outline changes meanwhile read nothing: they wait for the backoff.
    for (let i = 0; i < 10; i++) {
      void outline.want([
        'a',
        ...Array.from({ length: i + 1 }, (_, n) => `m${n}`),
      ]);
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(reads()).toEqual([]);

    // Then one read asks for what the outline names now; failing again, it waits longer, and
    // says nothing more.
    await vi.advanceTimersByTimeAsync(RETRY_FIRST);
    const second = reads();
    expect(second).toHaveLength(1);
    expect(second[0]?.request.params.get('filter[id]')?.split(',')).toEqual([
      'a',
      ...Array.from({ length: 10 }, (_, n) => `m${n}`),
    ]);
    second[0]?.flush(null, busy);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST);
    expect(reads()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RETRY_FIRST);
    const third = reads();
    expect(third).toHaveLength(1);
    third[0]?.flush({
      data: [summary('a'), summary('m0')],
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 2 } },
      links: { self: '', first: '', last: '', prev: null, next: null },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(outline.summaries()?.get('a')?.attributes.title).toBe('A');
    expect(errors).toHaveBeenCalledTimes(1);

    // Read again, nothing is asked twice and nothing more is retried.
    void outline.want(['a', 'm0']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(reads()).toEqual([]);
    http.verify();
  });

  it('neither retries nor says anything once the page is gone (#561)', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(Page);
    const { outline } = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    const errors = vi.spyOn(TestBed.inject(ToastService), 'error');
    const isRead = (r: { url: string }) => r.url === '/api/module-summaries';
    void outline.want(['a']);
    await vi.advanceTimersByTimeAsync(0);
    const read = http.expectOne(isRead);
    fixture.destroy();
    read.flush(null, busy);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(errors).not.toHaveBeenCalled();
    http.verify();
  });

  it('forgets the backoff on a new reading', async () => {
    vi.useFakeTimers();
    onTestFinished(() => void vi.useRealTimers());
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(Page);
    const { outline } = fixture.componentInstance;
    const http = TestBed.inject(HttpTestingController);
    const isRead = (r: { url: string }) => r.url === '/api/module-summaries';
    void outline.want(['a']);
    await vi.advanceTimersByTimeAsync(0);
    http.expectOne(isRead).flush(null, busy);
    await vi.advanceTimersByTimeAsync(0);
    outline.reset();
    void outline.want(['b']);
    await vi.advanceTimersByTimeAsync(0);
    expect(http.expectOne(isRead).request.params.get('filter[id]')).toBe('b');
    await vi.advanceTimersByTimeAsync(60_000);
    http.verify();
  });
});

describe('chunks', () => {
  it('puts IDs into reads of at most a page of them', () => {
    const ids = Array.from({ length: 450 }, (_, i) => `m${i}`);
    const reads = chunks(ids);
    expect(reads.map((r) => r.length)).toEqual([200, 200, 50]);
    expect(reads.flat()).toEqual(ids);
    expect(IDS_PER_READ).toBe(200);
  });

  it('keeps each read’s IDs, commas included, within the characters a read may name', () => {
    const ids = Array.from(
      { length: 150 },
      (_, i) => `${'x'.repeat(95)}-${String(i).padStart(3, '0')}`,
    );
    const reads = chunks(ids);
    expect(reads.length).toBeGreaterThan(1);
    for (const read of reads) {
      expect(read.join(',').length).toBeLessThanOrEqual(ID_CHARS_PER_READ);
    }
    expect(reads.flat()).toEqual(ids);
  });

  it('reads nothing for no IDs', () => {
    expect(chunks([])).toEqual([]);
  });
});
