import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ApiClient } from '../../api';
import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import type { DesignChangeSet } from './design-draft';
import {
  createTemplate,
  TEMPLATE_FILE_MAX_BYTES,
  TemplateDraft,
} from './template-draft';

const CS: DesignChangeSet = {
  id: 'cs1',
  branch: 'change-sets/cs1',
  state: 'draft',
  authorId: 'author',
};
const FILES = '/api/page-design-templates/house/files';
const FILE = '/api/page-design-templates/house/file';
const WC =
  '/api/change-sets/cs1/page-design-templates/house/files/working-copy';
const LOCKS = '/api/change-sets/cs1/locks';
const COMMITS = '/api/change-sets/cs1/commits';

const page = (data: unknown[] = []) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 200, total: data.length },
  },
  links: {},
});

const file = (path: string, draft = false, text = true, committed = true) => ({
  type: 'PageDesignTemplateFile',
  id: path,
  attributes: { path, size: 10, text },
  meta: { draft, committed },
});

const copyDoc = (path: string, text: string, version: number) => ({
  data: {
    type: 'WorkingCopy',
    id: `cs1/template/house/${path}`,
    attributes: {
      subject: { type: 'template', templateId: 'house', path },
      content: { schemaVersion: 1, text },
      version,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: 'cs1' } } },
    meta: { saved: version > 0, issues: [] },
  },
});

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

function setup(person = 'author', may = true) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: MeService, useValue: { me: () => ({ id: person }) } },
      {
        provide: PermissionService,
        useValue: { state: () => ({ kind: may ? 'enabled' : 'hidden' }) },
      },
      TemplateDraft,
    ],
  });
  return {
    draft: TestBed.inject(TemplateDraft),
    http: TestBed.inject(HttpTestingController),
  };
}

/** The template loaded in the author's draft, `manual.typ` open with `text`. */
async function opened(text = '#let x = 1') {
  const ctx = setup();
  const done = ctx.draft.load(CS, 'house');
  ctx.http
    .expectOne((r) => r.url === FILES)
    .flush(page([file('logo.png', false, false), file('manual.typ')]));
  await done;
  const open = ctx.draft.open('manual.typ');
  await flush();
  ctx.http
    .expectOne((r) => r.url === WC && r.method === 'GET')
    .flush(copyDoc('manual.typ', text, 0));
  ctx.http.expectOne((r) => r.url === '/api/locks').flush(page());
  await open;
  return ctx;
}

describe('TemplateDraft', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
  });

  it('lists the files with the drafts in the person’s own revision, to edit', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'house');
    const list = http.expectOne((r) => r.url === FILES);
    expect(list.request.params.get('ref')).toBe('change-sets/cs1');
    expect(list.request.params.get('workingCopy')).toBe('true');
    list.flush(page([file('manual.typ', true)]));
    await done;
    expect(draft.status()).toBe('ready');
    expect(draft.mode()).toEqual({ kind: 'edit' });
    expect(draft.files()).toEqual([
      {
        path: 'manual.typ',
        size: 10,
        text: true,
        draft: true,
        committed: true,
      },
    ]);
  });

  it('is missing where the revision has no such template', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'house');
    http
      .expectOne((r) => r.url === FILES)
      .flush(
        { errors: [{ status: '404', code: 'not-found', title: 'Not found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    await done;
    expect(draft.status()).toBe('missing');
  });

  it('reads the committed files, read-only with the reason, in someone else’s revision', async () => {
    const { draft, http } = setup('someone-else');
    const done = draft.load(CS, 'house');
    const list = http.expectOne((r) => r.url === FILES);
    expect(list.request.params.has('workingCopy')).toBe(false);
    list.flush(page([file('manual.typ')]));
    await done;
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.pageDesigns.blocked.notAuthor',
    });
    const open = draft.open('manual.typ');
    const read = http.expectOne((r) => r.url === FILE);
    expect(read.request.params.get('path')).toBe('manual.typ');
    expect(read.request.params.get('ref')).toBe('change-sets/cs1');
    read.flush({
      data: {
        type: 'PageDesignTemplateFileText',
        id: 'manual.typ',
        attributes: { path: 'manual.typ', text: '= Hi' },
      },
    });
    await open;
    expect(draft.text()).toBe('= Hi');
    expect(draft.editable()).toBe(false);
    draft.change('changed');
    expect(draft.text()).toBe('= Hi');
  });

  it('never edits for a role without content.edit', async () => {
    const { draft, http } = setup('author', false);
    const done = draft.load(CS, 'house');
    http.expectOne((r) => r.url === FILES).flush(page([file('manual.typ')]));
    await done;
    expect(draft.mode()).toEqual({ kind: 'read', reason: null });
  });

  it('saves typing into the file’s working copy, its lock first, then makes a save point of the file alone', async () => {
    const { draft, http } = await opened();
    expect(draft.editable()).toBe(true);
    draft.change('#let x = 2');
    expect(draft.saveState()).toBe('saving');
    const point = draft.savePoint();
    await flush();
    const lock = http.expectOne(LOCKS);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'template',
      templateId: 'house',
      path: 'manual.typ',
    });
    lock.flush({ data: {} });
    await flush();
    const put = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(put.request.params.get('path')).toBe('manual.typ');
    expect(put.request.body.data.attributes.content.text).toBe('#let x = 2');
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
    put.flush(copyDoc('manual.typ', '#let x = 2', 1));
    await flush();
    expect(draft.saveState()).toBe('saved');
    expect(draft.saves()).toBe(1);
    expect(draft.files().find((f) => f.path === 'manual.typ')?.draft).toBe(
      true,
    );
    const commit = http.expectOne(COMMITS);
    // Named always: a commit naming none would take every working copy of the revision.
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'template', templateId: 'house', path: 'manual.typ' },
    ]);
    expect(commit.request.body.data.attributes).not.toHaveProperty('deletes');
    commit.flush({
      data: { type: 'Commit', id: 'c1', attributes: {} },
    });
    expect(await point).toBe(true);
  });

  it('makes a save point of every draft of the template, also the files not opened here', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'house');
    http
      .expectOne((r) => r.url === FILES)
      .flush(
        page([
          file('default.typ', true, true, false),
          file('manual.typ', true, true, false),
        ]),
      );
    await done;
    const point = draft.savePoint();
    await flush();
    for (let i = 0; i < 2; i++) {
      http.expectOne(LOCKS).flush({ data: {} });
      await flush();
    }
    const commit = http.expectOne(COMMITS);
    expect(
      commit.request.body.data.attributes.subjects.map(
        (s: { path: string }) => s.path,
      ),
    ).toEqual(['default.typ', 'manual.typ']);
    commit.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } });
    expect(await point).toBe(true);
    expect(draft.files().map((f) => [f.draft, f.committed])).toEqual([
      [false, true],
      [false, true],
    ]);
  });

  it('keeps a file past the size limit unsent, and says so', async () => {
    const { draft } = await opened();
    draft.change('x'.repeat(TEMPLATE_FILE_MAX_BYTES + 1));
    expect(draft.saveState()).toBe('not-saved');
    await flush();
  });

  it('deletes a committed file with a save point naming it', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'house');
    http
      .expectOne((r) => r.url === FILES)
      .flush(page([file('manual.typ'), file('parts/a.typ')]));
    await done;
    const deleted = draft.deleteFile('parts/a.typ', true);
    await flush();
    http.expectOne(LOCKS).flush({ data: {} });
    await flush();
    const commit = http.expectOne(COMMITS);
    expect(commit.request.body.data.attributes.subjects).toEqual([]);
    expect(commit.request.body.data.attributes.deletes).toEqual([
      { type: 'template', templateId: 'house', path: 'parts/a.typ' },
    ]);
    commit.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } });
    await flush();
    http.expectOne((r) => r.url === FILES).flush(page([file('manual.typ')]));
    await deleted;
    expect(draft.files().map((f) => f.path)).toEqual(['manual.typ']);
  });

  it('never deletes the entry file', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'house');
    http.expectOne((r) => r.url === FILES).flush(page([file('manual.typ')]));
    await done;
    await draft.deleteFile('manual.typ', true);
    http.expectNone(COMMITS);
  });
});

describe('createTemplate', () => {
  it('copies the example’s files into the revision, the entry file first', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createTemplate(api, 'cs1', 'fresh');
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'c0' },
      },
    });
    http
      .expectOne((r) => r.url === '/api/page-design-template-example/files')
      .flush(
        page(
          ['default.typ', 'manual.typ'].map((path) => ({
            type: 'PageDesignTemplateFileText',
            id: path,
            attributes: { path, text: `// ${path}` },
          })),
        ),
      );
    const order: string[] = [];
    for (let i = 0; i < 2; i++) {
      await flush();
      const lock = http.expectOne('/api/change-sets/cs1/locks');
      order.push(lock.request.body.data.attributes.subject.path);
      lock.flush({ data: {} });
      await flush();
      const put = http.expectOne(
        (r) =>
          r.url ===
            '/api/change-sets/cs1/page-design-templates/fresh/files/working-copy' &&
          r.method === 'PUT',
      );
      expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
      expect(put.request.body.data.attributes.content.text).toBe(
        `// ${put.request.params.get('path')}`,
      );
      put.flush({ data: {} });
    }
    await done;
    expect(order).toEqual(['manual.typ', 'default.typ']);
    http.verify();
  });
});
