import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { MeService } from '../permissions/me';
import { TermIndex } from './term-index';

const termsPage = (...ids: string[]) => ({
  data: ids.map((id) => ({
    type: 'Term',
    id,
    attributes: {
      domain: undefined,
      status: 'approved',
      languages: { en: { preferred: `Term ${id}`, variants: [] } },
    },
    meta: {},
  })),
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: ids.length },
  },
  links: {},
});

function setup() {
  TestBed.configureTestingModule({
    providers: [TermIndex, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    index: TestBed.inject(TermIndex),
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

const isTerms = (r: { url: string }) => r.url === '/api/terms';
const ids = (index: TermIndex) => index.terms().map((t) => t.id);

describe('TermIndex', () => {
  it('reads every term', async () => {
    const { index, http } = setup();
    person('u1');
    const load = index.load();
    http.expectOne(isTerms).flush(termsPage('t1', 't2'));
    await load;
    expect(ids(index)).toEqual(['t1', 't2']);
    expect(index.ready()).toBe(true);
  });

  it('keeps nothing of a read for the person before that answers after the change (#706)', async () => {
    const { index, http } = setup();
    person('u1');
    const load = index.load();
    const before = http.expectOne(isTerms);
    person('u2');
    before.flush(termsPage('secret'));
    await load;
    expect(ids(index)).toEqual([]);
  });

  it('a failed read keeps no terms read before it (#706)', async () => {
    const { index, http } = setup();
    person('u1');
    const first = index.load();
    http.expectOne(isTerms).flush(termsPage('secret'));
    await first;

    person('u2');
    const failing = index.load();
    http.expectOne(isTerms).flush(null, { status: 503, statusText: 'x' });
    await failing;
    expect(ids(index)).toEqual([]);
    expect(index.ready()).toBe(true);
  });

  it('offers none of the person before’s terms while the next one’s are read (#706)', async () => {
    const { index, http } = setup();
    person('u1');
    const first = index.load();
    http.expectOne(isTerms).flush(termsPage('secret'));
    await first;

    person('u2');
    const next = index.load();
    expect(ids(index)).toEqual([]);
    expect(index.ready()).toBe(false);
    http.expectOne(isTerms).flush(termsPage('t2'));
    await next;
    expect(ids(index)).toEqual(['t2']);
  });
});
