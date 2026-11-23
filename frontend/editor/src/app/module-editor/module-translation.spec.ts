import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ModuleTranslation, translationOf } from './module-translation';

const WC = (lang: string) =>
  `/api/change-sets/cs1/modules/${lang}/charging/working-copy`;
const source = {
  schemaVersion: 1,
  id: 'charging',
  meta: {
    title: 'Charging',
    type: 'procedure',
    lang: 'en',
    facets: { line: ['small'] },
    keywords: ['battery'],
  },
  blocks: [
    {
      type: 'heading',
      id: 'top',
      level: 2,
      content: [{ type: 'text', text: 'Charge' }],
    },
    {
      type: 'paragraph',
      id: 'intro',
      content: [{ type: 'text', text: 'It charges.' }],
    },
  ],
};
const notFound = () =>
  [
    { errors: [{ status: '404', code: 'not-found' }] },
    { status: 404, statusText: 'Not Found' },
  ] as const;

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(MeService).set({
    id: 'author',
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  return {
    translation: TestBed.inject(ModuleTranslation),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

const flushAll = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

const start = { moduleId: 'charging', from: 'en', to: 'de', title: 'Charging' };

describe('translationOf', () => {
  it('keeps every block with its ID and the metadata, in the new language', () => {
    const copy = translationOf(source as never, 'de');
    expect(copy.blocks).toEqual(source.blocks);
    expect(copy.meta).toEqual({ ...source.meta, lang: 'de' });
    expect(copy.id).toBe('charging');
  });

  it('leaves the deprecation out: a module has the one of its source file (#266)', () => {
    const deprecated = {
      ...source,
      meta: { ...source.meta, deprecated: { reason: 'Superseded.' } },
    };
    expect(translationOf(deprecated as never, 'de').meta).toEqual({
      ...source.meta,
      lang: 'de',
    });
  });
});

describe('ModuleTranslation', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('takes the lock and saves a copy of the source as the new language', async () => {
    const { translation, http } = setup();
    const done = translation.start(start, 'cs1');
    await flushAll();
    http.expectOne(WC('de')).flush(...notFound());
    http.expectOne(WC('en')).flush({
      data: {
        attributes: { content: source, version: 3, baseCommit: 'c1' },
        meta: { saved: true },
      },
    });
    http
      .expectOne('/api/change-sets/cs1')
      .flush({ data: { attributes: { baseCommit: 'base1' } } });
    await flushAll();
    const lock = http.expectOne('/api/change-sets/cs1/locks');
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'module',
      lang: 'de',
      moduleId: 'charging',
    });
    lock.flush({ data: { id: 'l1' } }, { status: 201, statusText: 'Created' });
    await flushAll();
    const put = http.expectOne((r) => r.method === 'PUT' && r.url === WC('de'));
    expect(put.request.body).toEqual({
      data: {
        type: 'WorkingCopy',
        attributes: {
          content: { ...source, meta: { ...source.meta, lang: 'de' } },
        },
      },
      meta: { version: 0, baseCommit: 'base1' },
    });
    put.flush({ data: {} });
    expect(await done).toBe(true);
    // Nothing is committed: the editor's save point does that.
    http.expectNone('/api/change-sets/cs1/commits');
  });

  it('opens a version another tab started, as it is', async () => {
    const { translation, http } = setup();
    const done = translation.start(start, 'cs1');
    await flushAll();
    http.expectOne(WC('de')).flush({
      data: {
        attributes: { content: source, version: 1, baseCommit: 'c1' },
        meta: { saved: true },
      },
    });
    http.expectOne(WC('en')).flush({
      data: {
        attributes: { content: source, version: 0, baseCommit: 'c1' },
        meta: { saved: false },
      },
    });
    http
      .expectOne('/api/change-sets/cs1')
      .flush({ data: { attributes: { baseCommit: 'b' } } });
    expect(await done).toBe(true);
    http.expectNone('/api/change-sets/cs1/locks');
  });

  it('says another change set is editing that language', async () => {
    const { translation, http, toast } = setup();
    const done = translation.start(start, 'cs1');
    await flushAll();
    http.expectOne(WC('de')).flush(...notFound());
    http.expectOne(WC('en')).flush({
      data: {
        attributes: { content: source, version: 0, baseCommit: 'c1' },
        meta: { saved: false },
      },
    });
    http
      .expectOne('/api/change-sets/cs1')
      .flush({ data: { attributes: { baseCommit: 'b' } } });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/locks')
      .flush(
        { errors: [{ status: '409', code: 'locked' }] },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await done).toBe(false);
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.moduleEditor.translate.locked',
    });
  });
});
