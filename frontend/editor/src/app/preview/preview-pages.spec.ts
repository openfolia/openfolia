import { TestBed } from '@angular/core/testing';
import { HttpParams, provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { RASTERIZE_SVG } from '../images/svg-raster';
import { PreviewPages } from './preview-pages';

const HASH = 'b'.repeat(64);
const flush = () => new Promise((resolve) => setTimeout(resolve));

describe('PreviewPages', () => {
  it('shows a safety symbol’s SVG artwork as a PNG, and never makes a URL of an SVG', async () => {
    const raster = new Blob(['raster'], { type: 'image/png' });
    const rasterized: Blob[] = [];
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: RASTERIZE_SVG,
          useValue: (svg: Blob) => {
            rasterized.push(svg);
            return Promise.resolve(raster);
          },
        },
      ],
    });
    const made: Blob[] = [];
    const create = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation((blob) => {
        made.push(blob as Blob);
        return `blob:test/${made.length}`;
      });
    onTestFinished(() => create.mockRestore());
    const pages = TestBed.inject(PreviewPages);
    const http = TestBed.inject(HttpTestingController);

    const read = pages.read(
      '/modules/en/safety-note/preview',
      new HttpParams().set('ref', 'main'),
      () => true,
    );
    http
      .expectOne((r) => r.url.endsWith('/api/modules/en/safety-note/preview'))
      .flush(
        `<!doctype html><html lang="en"><body><article>` +
          `<img class="of-safety__symbol" src="../../../symbols/w001?ref=main" alt="General warning">` +
          `<img alt="Diagram" src="../../../assets/${HASH}?ref=main">` +
          `</article></body></html>`,
      );
    await flush();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
    http
      .expectOne('/api/symbols/w001?ref=main')
      .flush(new Blob([svg], { type: 'image/svg+xml' }));
    // An SVG image (not a symbol) keeps the rule it had: shown from no SVG URL either.
    http
      .expectOne(`/api/assets/${HASH}?ref=main`)
      .flush(new Blob([svg], { type: 'image/svg+xml' }));
    const page = await read;

    expect(rasterized).toHaveLength(1);
    expect(made.map((b) => b.type).sort()).toEqual([
      'application/octet-stream',
      'image/png',
    ]);
    const doc = new DOMParser().parseFromString(
      pages.document(page!, false),
      'text/html',
    );
    const symbol = doc.querySelector('img.of-safety__symbol');
    expect(made[Number(symbol?.getAttribute('src')?.split('/')[1]) - 1]).toBe(
      raster,
    );
    expect(symbol?.getAttribute('alt')).toBe('General warning');
    http.verify();
  });
});
