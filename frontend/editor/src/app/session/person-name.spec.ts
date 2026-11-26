import {
  HttpClient,
  provideHttpClient,
  withInterceptors,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { type Named, PeopleStates } from '../api';
import { peopleInterceptor } from '../api/api-interceptors';
import { injectPersonText } from '../history/history-model';
import { DemoSession } from './demo-session';
import { PersonNameComponent } from './person-name.component';

const ada: Named = { kind: 'user', id: 'ada' };

async function shown(who: Named, name: string) {
  const fixture = TestBed.createComponent(PersonNameComponent);
  fixture.componentRef.setInput('who', who);
  fixture.componentRef.setInput('name', name);
  await fixture.whenStable();
  return {
    fixture,
    text: () =>
      (fixture.nativeElement as HTMLElement).textContent
        ?.replace(/\s+/g, ' ')
        .trim(),
  };
}

describe('a person named by a screen (#928)', () => {
  let http: HttpTestingController;
  /** An answer of the API saying this of the people it names. */
  const answer = (people: unknown, url = '/api/x') => {
    TestBed.inject(HttpClient)
      .get(url)
      .subscribe({ error: () => undefined });
    http.expectOne(url).flush({ data: [], meta: { people } });
  };

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([peopleInterceptor])),
        provideHttpClientTesting(),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('is marked while the answers say they are deactivated, in text', async () => {
    const { fixture, text } = await shown(ada, 'Ada Long');
    expect(text()).toBe('Ada Long');
    answer([{ id: 'ada', deactivated: true }]);
    await fixture.whenStable();
    expect(text()).toBe('Ada Long (deactivated)');
    // An answer that does not name them says nothing of them.
    answer([{ id: 'bo', deactivated: false }]);
    await fixture.whenStable();
    expect(text()).toBe('Ada Long (deactivated)');
    answer([{ id: 'ada', deactivated: false }]);
    await fixture.whenStable();
    expect(text()).toBe('Ada Long');
  });

  it('is marked in a sentence as on its own', () => {
    TestBed.inject(PeopleStates).read([{ id: 'ada', deactivated: true }]);
    const personText = TestBed.runInInjectionContext(injectPersonText);
    expect(personText(ada, 'Ada Long')).toBe('Ada Long (deactivated)');
    expect(personText({ kind: 'user', id: 'bo' }, 'Bo')).toBe('Bo');
  });

  it('is never marked when it is no user, whatever its ID', async () => {
    TestBed.inject(PeopleStates).read([{ id: 'ada', deactivated: true }]);
    const { text } = await shown({ kind: 'service', id: 'ada' }, 'ada');
    expect(text()).toBe('ada');
  });

  it('reads nothing from an answer of another server, nor from a malformed one', () => {
    const states = TestBed.inject(PeopleStates);
    answer([{ id: 'ada', deactivated: true }], 'https://example.com/x');
    answer('ada');
    TestBed.inject(HttpClient).get('/api/none').subscribe();
    http.expectOne('/api/none').flush(null);
    expect(states.deactivated().size).toBe(0);
  });

  it('keeps a deactivated demo user’s name, read once', async () => {
    const demo = TestBed.inject(DemoSession);
    const page = (...ids: string[]) => ({
      data: ids.map((id) => ({
        type: 'User',
        id,
        attributes: { name: `Name ${id}` },
        relationships: { roles: { data: [] } },
        meta: { permissions: [] },
      })),
      meta: { page: { currentPage: 1, lastPage: 1, perPage: 200, total: 1 } },
    });
    const asked = (status: string | null) =>
      http.expectOne(
        (r) =>
          r.url === '/api/demo/users' &&
          r.params.get('filter[status]') === status,
      );
    const probing = demo.probe();
    asked(null).flush(page('bo'));
    await probing;
    expect(demo.nameOf('ada')).toBeUndefined();

    answer([
      { id: 'ada', deactivated: true },
      { id: 'gone', deactivated: true },
    ]);
    TestBed.tick();
    asked('deactivated').flush(page('ada'));
    await vi.waitFor(() => expect(demo.nameOf('ada')).toBe('Name ada'));
    // Nobody to act as, and an ID without a name is not asked for again.
    expect(demo.users().map((u) => u.id)).toEqual(['bo']);
    expect(demo.nameOf('gone')).toBeUndefined();
    answer([{ id: 'bo', deactivated: true }]);
    TestBed.tick();
  });
});
