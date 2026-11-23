import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { ModuleDeletion } from './module-deletion';

const WC = (lang: string) =>
  `/api/change-sets/cs1/modules/${lang}/charging/working-copy`;
const content = (lang: string) => ({
  schemaVersion: 1,
  id: 'charging',
  meta: { title: 'Charging', type: 'procedure', lang, facets: {} },
  blocks: [
    { type: 'paragraph', id: 'intro', content: [{ type: 'text', text: lang }] },
  ],
});
const copy = (lang: string, saved = false) => ({
  data: {
    type: 'WorkingCopy',
    attributes: {
      content: content(lang),
      version: saved ? 2 : 0,
      baseCommit: 'c0',
    },
    meta: { saved, issues: [] },
  },
});
const notFound = () =>
  [
    { errors: [{ status: '404', code: 'not-found' }] },
    { status: 404, statusText: 'Not Found' },
  ] as const;

function setup(person = 'author') {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  TestBed.inject(MeService).set({
    id: person,
    kind: 'user',
    name: 'Author',
    role: '',
    permissions: new Set(['content.read', 'content.edit']),
  });
  return {
    deletion: TestBed.inject(ModuleDeletion),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

const flushAll = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
};

/** Takes the lock on `lang` (held already or not: the same answer to this call). */
async function lock(http: HttpTestingController, lang: string) {
  const take = http.expectOne('/api/change-sets/cs1/locks');
  expect(take.request.body.data.attributes.subject).toEqual({
    type: 'module',
    lang,
    moduleId: 'charging',
  });
  take.flush({ data: { id: `l-${lang}` } });
  await flushAll();
}

describe('ModuleDeletion', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('deletes every language in one save point, then Undo writes them back and commits them', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      {
        moduleId: 'charging',
        title: 'Charging',
        langs: ['en', 'de'],
        all: true,
      },
      'cs1',
    );
    await flushAll();
    // What each language holds now: the committed file (en) and an edited working copy (de).
    http.expectOne(WC('en')).flush(copy('en'));
    http.expectOne(WC('de')).flush(copy('de', true));
    await flushAll();
    // A saved working copy is checked for a file on the branch.
    http
      .expectOne((r) => r.url === '/api/modules/de/charging')
      .flush({ data: {} });
    await flushAll();
    await lock(http, 'en');
    await lock(http, 'de');
    const commit = http.expectOne('/api/change-sets/cs1/commits');
    expect(commit.request.body.data.attributes).toEqual({
      subjects: [],
      deletes: [
        { type: 'module', lang: 'en', moduleId: 'charging' },
        { type: 'module', lang: 'de', moduleId: 'charging' },
      ],
      message: 'Delete module charging',
    });
    commit.flush(
      { data: { id: 'del1' } },
      { status: 201, statusText: 'Created' },
    );
    expect(await done).toEqual(['en', 'de']);
    expect(deletion.deleted().map((d) => [d.moduleId, d.langs])).toEqual([
      ['charging', ['en', 'de']],
    ]);
    expect(deletion.changed()).toBe(1);

    // The toast says so and offers Undo.
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('success');
    expect(shown?.message).toMatchObject({
      key: 'editor.content.delete.doneAll',
    });
    shown?.onAction?.();
    await flushAll();
    for (const lang of ['en', 'de']) {
      await lock(http, lang);
      http.expectOne(WC(lang)).flush(...notFound());
      await flushAll();
      const put = http.expectOne(
        (r) => r.method === 'PUT' && r.url === WC(lang),
      );
      // What was there before the delete, on the delete's commit.
      expect(put.request.body).toEqual({
        data: { type: 'WorkingCopy', attributes: { content: content(lang) } },
        meta: { version: 0, baseCommit: 'del1' },
      });
      put.flush({ data: {} });
      await flushAll();
    }
    const restore = http.expectOne('/api/change-sets/cs1/commits');
    expect(restore.request.body.data.attributes.subjects).toEqual([
      { type: 'module', lang: 'en', moduleId: 'charging' },
      { type: 'module', lang: 'de', moduleId: 'charging' },
    ]);
    restore.flush(
      { data: { id: 'back1' } },
      { status: 201, statusText: 'Created' },
    );
    await flushAll();
    expect(deletion.deleted()).toEqual([]);
    expect(deletion.changed()).toBe(2);
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.content.delete.restored',
    });
  });

  it('discards a language that is only a working copy, and never deletes it from the branch', async () => {
    const { deletion, http } = setup();
    const done = deletion.delete(
      { moduleId: 'charging', title: 'Charging', langs: ['fr'], all: false },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('fr')).flush(copy('fr', true));
    await flushAll();
    http
      .expectOne((r) => r.url === '/api/modules/fr/charging')
      .flush(...notFound());
    await flushAll();
    await lock(http, 'fr');
    const discard = http.expectOne(
      (r) => r.method === 'DELETE' && r.url === WC('fr'),
    );
    discard.flush(null, { status: 204, statusText: 'No Content' });
    expect(await done).toEqual(['fr']);
    http.expectNone('/api/change-sets/cs1/commits');
  });

  it('says a working copy that cannot be discarded was not deleted', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      { moduleId: 'charging', title: 'Charging', langs: ['fr'], all: false },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('fr')).flush(copy('fr', true));
    await flushAll();
    const branch = http.expectOne((r) => r.url === '/api/modules/fr/charging');
    // The branch is the change set's, named, whichever one is chosen now.
    expect(branch.request.params.get('ref')).toBe('change-sets/cs1');
    branch.flush(...notFound());
    await flushAll();
    await lock(http, 'fr');
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === WC('fr'))
      .flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await done).toBeNull();
    expect(deletion.deleted()).toEqual([]);
    expect(String(toast.toasts().at(-1)?.message)).toContain(
      'Could not delete “Charging”',
    );
  });

  it('names only what it deleted when a working copy of another language stays', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      {
        moduleId: 'charging',
        title: 'Charging',
        langs: ['en', 'fr'],
        all: true,
      },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('en')).flush(copy('en'));
    http.expectOne(WC('fr')).flush(copy('fr', true));
    await flushAll();
    http
      .expectOne((r) => r.url === '/api/modules/fr/charging')
      .flush(...notFound());
    await flushAll();
    await lock(http, 'en');
    await lock(http, 'fr');
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush({ data: { id: 'del1' } }, { status: 201, statusText: 'Created' });
    await flushAll();
    http
      .expectOne((r) => r.method === 'DELETE' && r.url === WC('fr'))
      .flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await done).toEqual(['en']);
    expect(deletion.deleted().map((d) => [d.langs, d.all])).toEqual([
      [['en'], false],
    ]);
    const texts = toast.toasts().map((t) => String(t.message));
    expect(texts.some((t) => t.includes('was not deleted in French'))).toBe(
      true,
    );
    // The done toast names English only, not "every language".
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.content.delete.done',
      params: { languages: 'English' },
    });
  });

  it('says a refused save point, keeps the locks with the change set and offers a retry', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      { moduleId: 'charging', title: 'Charging', langs: ['de'], all: false },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('de')).flush(copy('de'));
    await flushAll();
    await lock(http, 'de');
    http.expectOne('/api/change-sets/cs1/commits').flush(
      {
        errors: [
          {
            status: '409',
            code: 'invalid-state',
            meta: { state: 'in-review' },
          },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    expect(await done).toBeNull();
    // A lock is never given back: another tab of the change set may hold it meanwhile.
    http.expectNone((r) => r.url.startsWith('/api/locks/'));
    expect(deletion.deleted()).toEqual([]);
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('error');
    expect(shown?.actionLabel).toMatchObject({ key: 'editor.session.retry' });
  });

  it('says another change set holds it, and deletes nothing', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      { moduleId: 'charging', title: 'Charging', langs: ['de'], all: false },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('de')).flush(copy('de'));
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/locks')
      .flush(
        { errors: [{ status: '409', code: 'locked' }] },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await done).toBeNull();
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.content.delete.locked',
    });
  });

  it('does not overwrite a module put back since: Undo says so instead', async () => {
    const { deletion, http, toast } = setup();
    const done = deletion.delete(
      { moduleId: 'charging', title: 'Charging', langs: ['de'], all: false },
      'cs1',
    );
    await flushAll();
    http.expectOne(WC('de')).flush(copy('de'));
    await flushAll();
    await lock(http, 'de');
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush({ data: { id: 'del1' } }, { status: 201, statusText: 'Created' });
    await done;
    const key = deletion.deleted()[0]?.key ?? 0;
    const undone = deletion.undo(key);
    await flushAll();
    await lock(http, 'de');
    // Someone started the German version again meanwhile, with other text.
    const since = copy('de', true);
    since.data.attributes.content.blocks = [];
    http.expectOne(WC('de')).flush(since);
    expect(await undone).toBe(false);
    http.expectNone((r) => r.method === 'PUT');
    expect(toast.toasts().at(-1)?.message).toMatchObject({
      key: 'editor.content.delete.undoTaken',
    });
    expect(deletion.deleted().length).toBe(1);
  });
});
