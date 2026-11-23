import { Component, inject } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { RASTERIZE_SVG, svgAspect } from './svg-raster';
import { SymbolSources, symbolPng } from './symbol-sources';

@Component({ template: '', providers: [SymbolSources] })
class Page {
  readonly sources = inject(SymbolSources);
}

const flush = () => new Promise((resolve) => setTimeout(resolve));
const PNG = new Blob(['png'], { type: 'image/png' });

function setup() {
  const rasterized: Blob[] = [];
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: RASTERIZE_SVG,
        useValue: (svg: Blob) => {
          rasterized.push(svg);
          return Promise.resolve(new Blob(['raster'], { type: 'image/png' }));
        },
      },
    ],
  });
  TestBed.inject(ReadRef).ref.set('change-sets/cs1');
  const fixture = TestBed.createComponent(Page);
  const made: Blob[] = [];
  const revoked: string[] = [];
  const create = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    made.push(blob as Blob);
    return `blob:${made.length - 1}`;
  });
  const revoke = vi
    .spyOn(URL, 'revokeObjectURL')
    .mockImplementation((url) => void revoked.push(url));
  onTestFinished(() => {
    create.mockRestore();
    revoke.mockRestore();
  });
  return {
    fixture,
    sources: fixture.componentInstance.sources,
    http: TestBed.inject(HttpTestingController),
    made,
    revoked,
    rasterized,
  };
}

describe('SymbolSources', () => {
  it('reads a PNG symbol at the branch once and shows it as it is', async () => {
    const { sources, http, made } = setup();
    const first = sources.source('w001');
    const again = sources.source('w001');
    await flush();
    http.expectOne('/api/symbols/w001?ref=change-sets/cs1').flush(PNG);
    expect(await first).toBe('blob:0');
    expect(await again).toBe('blob:0');
    expect(made).toEqual([PNG]);
    http.verify();
  });

  it('never makes a URL of an SVG: it shows the PNG rasterised from it', async () => {
    const { sources, http, made, rasterized } = setup();
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    const shown = sources.source('w002');
    await flush();
    http.expectOne('/api/symbols/w002?ref=change-sets/cs1').flush(svg);
    expect(await shown).toBe('blob:0');
    expect(rasterized).toHaveLength(1);
    expect(made.map((b) => b.type)).toEqual(['image/png']);
  });

  it('is null for a symbol without artwork or with a file that is none, and anything not an image', async () => {
    const { sources, http, made } = setup();
    const missing = sources.source('w404');
    const invalid = sources.source('w422');
    const html = sources.source('html');
    await flush();
    http
      .expectOne('/api/symbols/w404?ref=change-sets/cs1')
      .flush(null, { status: 404, statusText: 'Not Found' });
    http
      .expectOne('/api/symbols/w422?ref=change-sets/cs1')
      .flush(null, { status: 422, statusText: 'Unprocessable' });
    http
      .expectOne('/api/symbols/html?ref=change-sets/cs1')
      .flush(new Blob(['<p>'], { type: 'text/html' }));
    expect(await missing).toBeNull();
    expect(await invalid).toBeNull();
    expect(await html).toBeNull();
    expect(made).toEqual([]);
  });

  it('asks again after a failure, and revokes its URLs when the page goes', async () => {
    const { fixture, sources, http, revoked } = setup();
    const failing = sources.source('w001');
    await flush();
    http
      .expectOne('/api/symbols/w001?ref=change-sets/cs1')
      .flush(null, { status: 500, statusText: 'Server Error' });
    await expect(failing).rejects.toBeTruthy();
    const retry = sources.source('w001');
    await flush();
    http.expectOne('/api/symbols/w001?ref=change-sets/cs1').flush(PNG);
    expect(await retry).toBe('blob:0');
    fixture.destroy();
    expect(revoked).toEqual(['blob:0']);
  });

  it('reads a symbol anew for another person (#706)', async () => {
    const { sources, http } = setup();
    const person = (id: string) =>
      TestBed.inject(MeService).set({
        id,
        kind: 'user',
        name: id,
        role: '',
        permissions: new Set(),
      });
    person('u1');
    const first = sources.source('w001');
    await flush();
    http.expectOne('/api/symbols/w001?ref=change-sets/cs1').flush(PNG);
    expect(await first).toBe('blob:0');

    person('u2');
    const next = sources.source('w001');
    await flush();
    http
      .expectOne('/api/symbols/w001?ref=change-sets/cs1')
      .flush(null, { status: 404, statusText: 'Not Found' });
    expect(await next).toBeNull();
  });
});

describe('symbolPng', () => {
  it('keeps a PNG, rasterises an SVG, and refuses a raster that is no PNG', async () => {
    const svg = new Blob(['<svg/>'], { type: 'image/svg+xml' });
    expect(await symbolPng(PNG, () => Promise.resolve(null))).toBe(PNG);
    expect(await symbolPng(svg, () => Promise.resolve(PNG))).toBe(PNG);
    expect(
      await symbolPng(svg, () =>
        Promise.resolve(new Blob(['x'], { type: 'image/svg+xml' })),
      ),
    ).toBeNull();
    expect(
      await symbolPng(new Blob(['x'], { type: 'image/webp' }), () =>
        Promise.resolve(PNG),
      ),
    ).toBeNull();
  });
});

describe('svgAspect', () => {
  it('reads the width and height, else the viewBox, else square', () => {
    const svg = (attrs: string) =>
      `<svg xmlns="http://www.w3.org/2000/svg" ${attrs}></svg>`;
    expect(svgAspect(svg('width="200" height="100"'))).toBe(2);
    expect(svgAspect(svg('width="20px" height="40px"'))).toBe(0.5);
    expect(svgAspect(svg('viewBox="0 0 100 90"'))).toBeCloseTo(100 / 90);
    expect(svgAspect(svg('width="100%" viewBox="0,0,50,100"'))).toBe(0.5);
    expect(svgAspect(svg(''))).toBe(1);
    expect(svgAspect('not svg')).toBe(1);
  });
});
