import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { MeService } from '../permissions/me';
import { PermissionService } from '../permissions/permission.service';
import {
  ManualDraft,
  SAVE_POINT_DELAY_MS,
  type DraftChangeSet,
} from './manual-draft';
import { toRows, type ManifestEntry } from './manual-outline';

const CS: DraftChangeSet = {
  id: 'cs1',
  branch: 'change-sets/cs1',
  state: 'draft',
  authorId: 'author',
};
const MANUAL = '/api/manuals/guide';
const WC = '/api/change-sets/cs1/manuals/guide/working-copy';
const LOCKS = '/api/change-sets/cs1/locks';
const COMMITS = '/api/change-sets/cs1/commits';

const ENTRIES: ManifestEntry[] = [{ module: 'a' }, { module: 'b' }];
const HEADER = {
  schemaVersion: 1 as const,
  id: 'guide',
  title: 'Guide',
  variants: [{ model: 'l' }],
  attributes: {},
};

const manualDoc = (entries = ENTRIES) => ({
  data: {
    type: 'Manual',
    id: 'guide',
    attributes: {
      schemaVersion: 1,
      title: 'Guide',
      variants: [{ model: 'l' }],
      textAttributes: {},
      entries,
    },
    meta: {
      variants: [{ slug: 'model=l', label: 'L', values: { model: 'l' } }],
      issues: [],
    },
  },
});

const copyDoc = (entries: ManifestEntry[], version: number, base = 'c0') => ({
  data: {
    type: 'WorkingCopy',
    id: 'cs1/manual/guide',
    attributes: {
      subject: { type: 'manual', manualId: 'guide' },
      content: { ...HEADER, entries },
      version,
      baseCommit: base,
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: 'cs1' } } },
    meta: { saved: version > 0, issues: [] },
  },
});

const page = (data: unknown[] = []) => ({
  data,
  meta: { page: { currentPage: 1, lastPage: 1, perPage: 50, total: 0 } },
  links: {},
});

const error = (status: number, code: string) =>
  [
    { errors: [{ status: String(status), code }] },
    { status, statusText: code },
  ] as const;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function setup(person = 'author') {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: MeService, useValue: { me: () => ({ id: person }) } },
      {
        provide: PermissionService,
        useValue: { state: () => ({ kind: 'enabled' }) },
      },
      ManualDraft,
    ],
  });
  return {
    draft: TestBed.inject(ManualDraft),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

/** Loads the guide in the change set, its working copy at `version`. */
async function loaded(version = 0, lock: unknown[] = []) {
  const ctx = setup();
  const done = ctx.draft.load('guide', CS);
  ctx.http.expectOne((r) => r.url === MANUAL).flush(manualDoc());
  await flush();
  ctx.http.expectOne(WC).flush(copyDoc(ENTRIES, version));
  ctx.http.expectOne((r) => r.url === '/api/locks').flush(page(lock));
  await done;
  return ctx;
}

describe('ManualDraft', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('reads the working copy of a draft the person started, to edit', async () => {
    const { draft } = await loaded();
    expect(draft.status()).toBe('ready');
    expect(draft.mode()).toEqual({ kind: 'edit' });
    expect(draft.rows().map((r) => r.id)).toEqual(['a', 'b']);
    expect(draft.manual()?.variants[0]?.slug).toBe('model=l');
  });

  it('reads another author’s change set read-only, with the reason', async () => {
    const { draft, http } = setup();
    const done = draft.load('guide', { ...CS, authorId: 'someone' });
    http.expectOne((r) => r.url === MANUAL).flush(manualDoc());
    await done;
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.manuals.blocked.notAuthor',
    });
  });

  it('is read-only when another change set holds the lock', async () => {
    const { draft } = await loaded(0, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs2' } },
        },
      },
    ]);
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.manuals.blocked.locked',
    });
  });

  it('saves a change eagerly: the lock first, then the working copy with its version', async () => {
    const { draft, http } = await loaded();
    const next = [...draft.rows()].reverse();
    draft.change(next);
    expect(draft.rows()).toEqual(next);
    expect(draft.saveState()).toBe('saving');
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    const put = http.expectOne(WC);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
    expect(put.request.body.data.attributes.content.entries).toEqual([
      { module: 'b' },
      { module: 'a' },
    ]);
    put.flush(copyDoc([{ module: 'b' }, { module: 'a' }], 1, 'c0'));
    await flush();
    expect(draft.saveState()).toBe('saved');
    // The next save sends the version it got, and takes no lock again.
    draft.change(toRows(ENTRIES));
    await flush();
    const second = http.expectOne(WC);
    expect(second.request.body.meta.version).toBe(1);
    second.flush(copyDoc(ENTRIES, 2));
    await flush();
  });

  it('puts the saved outline back on a refusal and offers a retry', async () => {
    const { draft, http, toast } = await loaded(1, []);
    const before = draft.rows();
    draft.change([...before].reverse());
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    http.expectOne(WC).flush(...error(422, 'invalid-body'));
    await flush();
    expect(draft.rows()).toEqual(before);
    expect(draft.saveState()).toBe('not-saved');
    const shown = toast.toasts().at(-1);
    expect(shown?.kind).toBe('error');
    toast.runAction(shown!.id);
    await flush();
    const retry = http.expectOne(WC);
    expect(retry.request.body.data.attributes.content.entries[0]).toEqual({
      module: 'b',
    });
    retry.flush(copyDoc([{ module: 'b' }, { module: 'a' }], 2));
    await flush();
    expect(draft.saveState()).toBe('saved');
  });

  it('turns read-only when the lock is taken elsewhere meanwhile', async () => {
    const { draft, http } = await loaded();
    draft.change([...draft.rows()].reverse());
    await flush();
    http.expectOne(LOCKS).flush(...error(409, 'locked'));
    await flush();
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.manuals.blocked.locked',
    });
    expect(draft.rows().map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('makes a save point of what is saved; the next save starts on that commit', async () => {
    const { draft, http } = await loaded(3, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
        },
      },
    ]);
    const done = draft.savePoint();
    await flush();
    const commit = http.expectOne(COMMITS);
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'manual', manualId: 'guide' },
    ]);
    commit.flush({ data: { type: 'Commit', id: 'c9', attributes: {} } });
    expect(await done).toBe(true);
    draft.change([...draft.rows()].reverse());
    await flush();
    const put = http.expectOne(WC);
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c9' });
    put.flush(copyDoc(ENTRIES, 1, 'c9'));
    await flush();
  });

  it('takes the lock again when it was broken meanwhile', async () => {
    const { draft, http, toast } = await loaded();
    draft.change([...draft.rows()].reverse());
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    http.expectOne(WC).flush(...error(409, 'lock-required'));
    await flush();
    toast.runAction(toast.toasts().at(-1)!.id);
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l2' } });
    await flush();
    http.expectOne(WC).flush(copyDoc([{ module: 'b' }, { module: 'a' }], 1));
    await flush();
    expect(draft.saveState()).toBe('saved');
  });

  it('offers no retry of a refused save once a newer change is made', async () => {
    const { draft, http, toast } = await loaded(0, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
        },
      },
    ]);
    draft.change([...draft.rows()].reverse());
    await flush();
    http.expectOne(WC).flush(...error(422, 'invalid-body'));
    await flush();
    const failed = toast.toasts().at(-1)!;
    draft.change(toRows([{ module: 'a' }]));
    await flush();
    http.expectOne(WC).flush(copyDoc([{ module: 'a' }], 1));
    await flush();
    toast.runAction(failed.id);
    await flush();
    http.expectNone(WC);
    expect(draft.rows().map((r) => r.id)).toEqual(['a']);
  });

  it('takes the lock before a save point when it holds none', async () => {
    const { draft, http } = await loaded(2);
    const done = draft.savePoint();
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    http
      .expectOne(COMMITS)
      .flush({ data: { type: 'Commit', id: 'c9', attributes: {} } });
    expect(await done).toBe(true);
  });

  it('turns read-only when a save point finds the lock held elsewhere', async () => {
    const { draft, http } = await loaded(2);
    const done = draft.savePoint();
    await flush();
    http.expectOne(LOCKS).flush(...error(409, 'locked'));
    expect(await done).toBe(false);
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.manuals.blocked.locked',
    });
  });

  it('reads the manual again when a save point finds the lock gone', async () => {
    const { draft, http } = await loaded(2, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
        },
      },
    ]);
    const done = draft.savePoint();
    await flush();
    http.expectOne(COMMITS).flush(...error(409, 'lock-required'));
    expect(await done).toBe(false);
    await flush();
    http.expectOne((r) => r.url === MANUAL).flush(manualDoc());
    await flush();
    http.expectOne(WC).flush(copyDoc(ENTRIES, 2));
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await flush();
    expect(draft.status()).toBe('ready');
  });

  it('changes the settings: shown at once, saved with the outline; a refusal puts them back', async () => {
    const { draft, http } = await loaded(1, []);
    expect(draft.settings()).toEqual({
      audience: undefined,
      variants: [{ model: 'l' }],
      attributes: {},
    });
    draft.changeSettings({
      audience: 'public',
      variants: [{ model: 'l' }, { model: 'xl' }],
      attributes: { product: 'Lifter' },
    });
    expect(draft.settings()?.audience).toBe('public');
    expect(draft.manual()?.variants.map((v) => v.slug)).toEqual([
      'model=l',
      'model=xl',
    ]);
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    const put = http.expectOne(WC);
    expect(put.request.body.data.attributes.content).toMatchObject({
      audience: 'public',
      variants: [{ model: 'l' }, { model: 'xl' }],
      attributes: { product: 'Lifter' },
      entries: ENTRIES,
    });
    put.flush(...error(422, 'invalid-body'));
    await flush();
    expect(draft.settings()).toEqual({
      audience: undefined,
      variants: [{ model: 'l' }],
      attributes: {},
    });
    expect(draft.manual()?.variants.map((v) => v.slug)).toEqual(['model=l']);
  });

  it('clears the audience, and keeps one variant at least', async () => {
    const { draft, http } = await loaded(1, []);
    draft.changeSettings({ variants: [] });
    expect(draft.saveState()).toBeNull();
    draft.changeSettings({ audience: 'public' });
    draft.changeSettings({ audience: undefined });
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    const put = http.expectOne(WC);
    expect('audience' in put.request.body.data.attributes.content).toBe(false);
    put.flush(copyDoc(ENTRIES, 2));
    await flush();
  });

  it('changes nothing while it is read again', async () => {
    const { draft, http } = await loaded(1, []);
    const reload = draft.load('guide', CS);
    draft.changeSettings({ audience: 'public' });
    draft.change([...draft.rows()].reverse());
    expect(draft.settings()?.audience).toBeUndefined();
    expect(draft.saveState()).toBeNull();
    http.expectOne((r) => r.url === MANUAL).flush(manualDoc());
    await flush();
    http.expectOne(WC).flush(copyDoc(ENTRIES, 1));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await reload;
    expect(draft.scope()).toBe('guide\ncs1');
  });

  it('shows the committed settings read-only', async () => {
    const { draft, http } = setup();
    const done = draft.load('guide', { ...CS, authorId: 'someone' });
    const doc = manualDoc();
    http
      .expectOne((r) => r.url === MANUAL)
      .flush({
        data: {
          ...doc.data,
          attributes: {
            ...doc.data.attributes,
            audience: 'internal',
            textAttributes: { product: 'Lifter' },
          },
        },
      });
    await done;
    expect(draft.settings()).toEqual({
      audience: 'internal',
      variants: [{ model: 'l' }],
      attributes: { product: 'Lifter' },
    });
    draft.changeSettings({ audience: 'public' });
    expect(draft.settings()?.audience).toBe('internal');
  });

  it('renames: the title shows at once and is saved with the outline; a refusal puts it back', async () => {
    const { draft, http, toast } = await loaded(1, []);
    draft.rename('  Field   guide ');
    expect(draft.manual()?.title).toBe('Field guide');
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    const put = http.expectOne(WC);
    expect(put.request.body.data.attributes.content).toEqual({
      ...HEADER,
      title: 'Field guide',
      entries: ENTRIES,
    });
    put.flush(...error(422, 'invalid-body'));
    await flush();
    expect(draft.manual()?.title).toBe('Guide');
    // The retry sends the new title again.
    toast.runAction(toast.toasts().at(-1)!.id);
    expect(draft.manual()?.title).toBe('Field guide');
    await flush();
    const retry = http.expectOne(WC);
    expect(retry.request.body.data.attributes.content.title).toBe(
      'Field guide',
    );
    retry.flush(copyDoc(ENTRIES, 2));
    await flush();
    // An empty title or the same one changes nothing.
    draft.rename('   ');
    draft.rename('Field guide');
    await flush();
    http.expectNone(WC);
  });

  it('reads a manual not on the branch from the working copy, and makes no save point while it is empty', async () => {
    vi.useFakeTimers();
    try {
      const { draft, http } = setup();
      const done = draft.load('guide', CS);
      http.expectOne((r) => r.url === MANUAL).flush(...error(404, 'not-found'));
      await vi.advanceTimersByTimeAsync(0);
      http.expectOne(WC).flush(copyDoc([], 1));
      http.expectOne((r) => r.url === '/api/locks').flush(page([]));
      await done;
      expect(draft.status()).toBe('ready');
      expect(draft.mode()).toEqual({ kind: 'edit' });
      expect(draft.manual()).toMatchObject({
        title: 'Guide',
        committed: false,
      });
      expect(draft.manual()?.variants[0]?.slug).toBe('model=l');
      expect(await draft.savePoint()).toBe(true);
      await vi.advanceTimersByTimeAsync(SAVE_POINT_DELAY_MS + 1);
      http.expectNone(COMMITS);
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not found when the manual is neither on the branch nor in a working copy', async () => {
    const { draft, http } = setup();
    const done = draft.load('guide', CS);
    http.expectOne((r) => r.url === MANUAL).flush(...error(404, 'not-found'));
    await flush();
    http.expectOne(WC).flush(...error(404, 'not-found'));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await done;
    expect(draft.status()).toBe('error');
    expect(draft.error()?.status).toBe(404);
  });

  it('settles: the manifest as saved once queued saves are done; reset forgets it', async () => {
    const { draft, http } = await loaded(1, []);
    draft.change([...draft.rows()].reverse());
    const settled = draft.settled();
    await flush();
    http.expectOne(LOCKS).flush({ data: { type: 'Lock', id: 'l1' } });
    await flush();
    http.expectOne(WC).flush(copyDoc([{ module: 'b' }, { module: 'a' }], 2));
    expect(await settled).toEqual({
      ...HEADER,
      entries: [{ module: 'b' }, { module: 'a' }],
    });
    draft.reset();
    expect(draft.manual()).toBeNull();
    expect(draft.status()).toBe('idle');
    expect(await draft.settled()).toBeNull();
  });
});
