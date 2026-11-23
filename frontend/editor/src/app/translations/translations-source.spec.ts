import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import { config } from '../releases/testing/releases';
import { TranslationsSource } from './translations-source';

const configDoc = () => ({
  data: { type: 'ProjectConfig', id: 'main', attributes: config() },
});
const manualsDoc = (...titles: string[]) => ({
  data: titles.map((title, i) => ({
    type: 'Manual',
    id: `m${i}`,
    attributes: { title },
  })),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: titles.length },
  },
  links: { next: null },
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      TranslationsSource,
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  return {
    source: TestBed.inject(TranslationsSource),
    http: TestBed.inject(HttpTestingController),
  };
}

const person = (id: string) =>
  TestBed.inject(MeService).set({
    id,
    kind: 'user',
    name: id,
    role: '',
    permissions: new Set(['content.read']),
  });

const isConfig = (r: { url: string }) => r.url === '/api/config';
const isManuals = (r: { url: string }) => r.url === '/api/manuals';
const labels = (source: TranslationsSource) =>
  source.manuals().map((m) => m.label);

describe('TranslationsSource', () => {
  it('reads the configuration and the manuals', async () => {
    const { source, http } = setup();
    person('u1');
    const load = source.load();
    http.expectOne(isConfig).flush(configDoc());
    http.expectOne(isManuals).flush(manualsDoc('Operating'));
    await load;
    expect(labels(source)).toEqual(['Operating']);
    expect(source.sourceLang()).toBe('en');
  });

  it('keeps nothing of a read for the person before that answers after the change (#706)', async () => {
    const { source, http } = setup();
    person('u1');
    const load = source.load();
    const config = http.expectOne(isConfig);
    const manuals = http.expectOne(isManuals);
    person('u2');
    config.flush(configDoc());
    manuals.flush(manualsDoc('Only u1 reads this'));
    await load;
    expect(labels(source)).toEqual([]);
    expect(source.config()).toBeNull();
  });

  it('shows none of the person before’s manuals to the next, even when their own read fails (#706)', async () => {
    const { source, http } = setup();
    person('u1');
    const first = source.load();
    http.expectOne(isConfig).flush(configDoc());
    http.expectOne(isManuals).flush(manualsDoc('Only u1 reads this'));
    await first;

    person('u2');
    const failing = source.load();
    expect(labels(source)).toEqual([]);
    http.expectOne(isConfig).flush(configDoc());
    http.expectOne(isManuals).flush(null, { status: 503, statusText: 'x' });
    await failing;
    expect(labels(source)).toEqual([]);
  });

  it('a failed read of the manuals clears the list it had (#706)', async () => {
    const { source, http } = setup();
    person('u1');
    const first = source.load();
    http.expectOne(isConfig).flush(configDoc());
    http.expectOne(isManuals).flush(manualsDoc('Operating'));
    await first;

    const failing = source.load();
    http.expectOne(isConfig).flush(configDoc());
    http.expectOne(isManuals).flush(null, { status: 503, statusText: 'x' });
    await failing;
    expect(labels(source)).toEqual([]);
  });
});
