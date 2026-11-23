import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
  type TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ReadRef } from '../api';
import { MeService } from '../permissions/me';
import { ModuleChoices } from './module-choices';

const summary = (id: string) => ({
  type: 'ModuleSummary',
  id,
  attributes: {
    moduleId: id,
    title: `Title ${id}`,
    titleLang: 'en',
    moduleType: 'concept',
    facets: {},
    keywords: [],
    languages: ['en'],
    variants: [],
  },
  meta: { changed: false },
});

const answer = (req: TestRequest, ...ids: string[]) =>
  req.flush({
    data: ids.map(summary),
    meta: {
      page: { currentPage: 1, lastPage: 1, perPage: 50, total: ids.length },
    },
    links: {},
  });

function setup() {
  TestBed.configureTestingModule({
    providers: [ModuleChoices, provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    choices: TestBed.inject(ModuleChoices),
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

const isSummaries = (r: { url: string }) => r.url === '/api/module-summaries';
const shown = (choices: ModuleChoices) =>
  choices.state().items.map((s) => s.id);

describe('ModuleChoices', () => {
  it('reads the add list while it is open', () => {
    const { choices, http } = setup();
    person('u1');
    choices.open();
    TestBed.tick();
    answer(http.expectOne(isSummaries), 'm1');
    expect(shown(choices)).toEqual(['m1']);
    expect(choices.state().status).toBe('ready');
    http.verify();
  });

  it('reads the list again for the next person, and never shows the previous one’s meanwhile (#716)', () => {
    const { choices, http } = setup();
    person('u1');
    choices.open();
    TestBed.tick();
    answer(http.expectOne(isSummaries), 'only-u1');

    // Another person in the same tab: their list is read without being asked, and the
    // previous person's modules are not shown (dimmed) while it is.
    person('u2');
    TestBed.tick();
    const next = http.expectOne(isSummaries);
    expect(choices.state().status).toBe('loading');
    expect(shown(choices)).toEqual([]);
    answer(next, 'seen-by-u2');
    expect(shown(choices)).toEqual(['seen-by-u2']);
    http.verify();
  });

  it('drops an answer read for the previous person that comes after the change (#716)', () => {
    const { choices, http } = setup();
    person('u1');
    choices.open();
    TestBed.tick();
    const before = http.expectOne(isSummaries);
    // The person changes before it answers, and before anything reacted to the change.
    person('u2');
    answer(before, 'only-u1');
    expect(shown(choices)).toEqual([]);
    TestBed.tick();
    answer(http.expectOne(isSummaries), 'seen-by-u2');
    expect(shown(choices)).toEqual(['seen-by-u2']);
    http.verify();
  });

  it('reads the list again at another ref, without showing the other ref’s meanwhile (#716)', () => {
    const { choices, http } = setup();
    person('u1');
    choices.open();
    TestBed.tick();
    answer(http.expectOne(isSummaries), 'on-main');
    TestBed.inject(ReadRef).ref.set('change-sets/cs1');
    TestBed.tick();
    const next = http.expectOne(isSummaries);
    expect(shown(choices)).toEqual([]);
    answer(next, 'in-cs1');
    expect(shown(choices)).toEqual(['in-cs1']);
    http.verify();
  });
});
