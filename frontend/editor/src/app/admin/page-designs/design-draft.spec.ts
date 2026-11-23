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
import {
  createDesign,
  DESIGN_SAVE_POINT_TIMEOUT_MS,
  DesignDraft,
  type DesignChangeSet,
} from './design-draft';
import { newDesign, type PageDesign } from './design-model';

const CS: DesignChangeSet = {
  id: 'cs1',
  branch: 'change-sets/cs1',
  state: 'draft',
  authorId: 'author',
};
const WC = '/api/change-sets/cs1/page-designs/ours/working-copy';
const LOCKS = '/api/change-sets/cs1/locks';
const COMMITS = '/api/change-sets/cs1/commits';
const DESIGN = newDesign('ours', 'Ours', 'classic');

const copyDoc = (
  content: PageDesign,
  version: number,
  issues: unknown[] = [],
) => ({
  data: {
    type: 'WorkingCopy',
    id: 'cs1/design/ours',
    attributes: {
      subject: { type: 'design', designId: 'ours' },
      content,
      version,
      baseCommit: 'c0',
    },
    relationships: { changeSet: { data: { type: 'ChangeSet', id: 'cs1' } } },
    meta: { saved: version > 0, issues },
  },
});

const page = (data: unknown[] = []) => ({
  data,
  meta: {
    page: { currentPage: 1, lastPage: 1, perPage: 50, total: data.length },
  },
  links: {},
});

const lockOf = (changeSet: string) => ({
  type: 'Lock',
  id: 'l1',
  attributes: { subject: { type: 'design', designId: 'ours' } },
  relationships: { changeSet: { data: { type: 'ChangeSet', id: changeSet } } },
});

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
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
      DesignDraft,
    ],
  });
  return {
    draft: TestBed.inject(DesignDraft),
    http: TestBed.inject(HttpTestingController),
  };
}

async function loaded(lock: unknown[] = []) {
  const ctx = setup();
  const done = ctx.draft.load(CS, 'ours');
  ctx.http.expectOne(WC).flush(copyDoc(DESIGN, 0));
  ctx.http.expectOne((r) => r.url === '/api/locks').flush(page(lock));
  await done;
  return ctx;
}

describe('DesignDraft', () => {
  afterEach(() => {
    TestBed.inject(HttpTestingController).verify();
    vi.useRealTimers();
  });

  it('reads the working copy of a draft the person started, to edit', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'ours');
    http.expectOne(WC).flush(copyDoc(DESIGN, 0));
    const locks = http.expectOne((r) => r.url === '/api/locks');
    expect(locks.request.params.get('filter[subject]')).toBe('design/ours');
    locks.flush(page());
    await done;
    expect(draft.status()).toBe('ready');
    expect(draft.mode()).toEqual({ kind: 'edit' });
    expect(draft.design()?.name).toBe('Ours');
    expect(draft.live()).toBe(false);
  });

  it('is missing where the change set has no such design', async () => {
    const { draft, http } = setup();
    const done = draft.load(CS, 'ours');
    http
      .expectOne(WC)
      .flush(
        { errors: [{ status: '404', code: 'not-found', title: 'Not found' }] },
        { status: 404, statusText: 'Not Found' },
      );
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await done;
    expect(draft.status()).toBe('missing');
  });

  it('reads the committed design, read-only with the reason, in someone else’s change set', async () => {
    const { draft, http } = setup('someone-else');
    const done = draft.load(CS, 'ours');
    const req = http.expectOne((r) => r.url === '/api/page-designs/ours');
    expect(req.request.params.get('ref')).toBe('change-sets/cs1');
    req.flush({
      data: {
        type: 'PageDesign',
        id: 'ours',
        attributes: DESIGN,
        meta: { issues: [] },
      },
    });
    await done;
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.pageDesigns.blocked.notAuthor',
    });
    expect(draft.change({ ...DESIGN, name: 'Changed' })).toBe(false);
  });

  it('is read-only while another change set holds the design’s lock', async () => {
    const { draft } = await loaded([lockOf('cs2')]);
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.pageDesigns.blocked.locked',
    });
  });

  it('saves a change into the working copy, its lock first, and the preview follows', async () => {
    const { draft, http } = await loaded();
    expect(
      draft.change({
        ...DESIGN,
        colours: { ...DESIGN.colours, primary: '#000000' },
      }),
    ).toBe(true);
    expect(draft.saveState()).toBe('saving');
    await flush();
    const lock = http.expectOne(LOCKS);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'design',
      designId: 'ours',
    });
    lock.flush({ data: lockOf('cs1') });
    await flush();
    const put = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(put.request.body.data.attributes.content.colours.primary).toBe(
      '#000000',
    );
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
    const issue = {
      severity: 'warning',
      code: 'low-contrast',
      message: 'x',
      at: 'colours.accent',
    };
    put.flush(copyDoc(put.request.body.data.attributes.content, 1, [issue]));
    await flush();
    expect(draft.saveState()).toBe('saved');
    expect(draft.saves()).toBe(1);
    expect(draft.live()).toBe(true);
    expect(draft.issues()).toEqual([issue]);
    expect(draft.canUndo()).toBe(true);

    draft.undo();
    await flush();
    const back = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(back.request.body.data.attributes.content.colours.primary).toBe(
      DESIGN.colours.primary,
    );
    expect(back.request.body.meta.version).toBe(1);
    back.flush(copyDoc(DESIGN, 2));
    await flush();
    expect(draft.canUndo()).toBe(false);
    expect(draft.saves()).toBe(2);
  });

  it('sends nothing of the person before under the next once a switch begins (#716)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    expect(draft.saveState()).toBe('saving');
    // The switch begins before the change went out.
    draft.forget();
    await flush();
    http.expectNone((r) => r.url === WC && r.method === 'PUT');
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.changeSet.switchingReason',
    });
    expect(draft.saveState()).toBe('not-saved');
    // The next person's load reads, with no save point of the change before.
    const next = draft.load(CS, 'other');
    await flush();
    http.expectNone(COMMITS);
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await next;
    expect(draft.design()?.id).toBe('other');
  });

  it('sends a change still under way and commits it before reading another design', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    const next = draft.load(CS, 'other');
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    const commit = http.expectOne(COMMITS);
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'design', designId: 'ours' },
    ]);
    commit.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } });
    await flush();
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await next;
    expect(draft.design()?.id).toBe('other');
  });

  it('lets the last load win while an earlier one waits for its save point', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    const away = draft.load(CS, 'other');
    expect(draft.status()).toBe('loading');
    // Back to the design shown, before the first load got any further.
    const back = draft.load(CS, 'ours');
    await flush();
    http
      .match((r) => r.url === WC && r.method === 'PUT')
      .forEach((r) => r.flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1)));
    await flush();
    // Going back makes its save point too (after the one the first load waits for), then reads.
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await away;
    await flush();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c2', attributes: {} } }),
      );
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'GET')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await back;
    expect(draft.design()?.id).toBe('ours');
    expect(draft.design()?.name).toBe('Changed');
    expect(draft.status()).toBe('ready');
  });

  it('still reads the other design when the save point before it is refused and the shown one read again', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    const away = draft.load(CS, 'other');
    await flush();
    http.expectOne(COMMITS).flush(
      {
        errors: [
          { status: '409', code: 'version-conflict', title: 'Conflict' },
        ],
      },
      { status: 409, statusText: 'Conflict' },
    );
    await flush();
    // The load asked for still goes ahead; the shown design is not read again meanwhile.
    expect(http.match((r) => r.url === WC && r.method === 'GET')).toHaveLength(
      0,
    );
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.match((r) => r.url === '/api/locks').forEach((r) => r.flush(page([])));
    await away;
    expect(draft.design()?.id).toBe('other');
    expect(draft.status()).toBe('ready');
  });

  it('never shows the old design as editable while a navigation waits (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    // A reload of the shown design, still under way when the navigation starts.
    const again = draft.load(CS, 'ours', true);
    await flush();
    const away = draft.load(CS, 'other');
    await flush();
    const seen: string[] = [];
    const watch = () =>
      seen.push(`${draft.status()}:${draft.design()?.id}:${draft.mode().kind}`);
    http
      .match((r) => r.url === WC && r.method === 'GET')
      .forEach((r) => r.flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1)));
    http
      .match((r) => r.url === '/api/locks')
      .forEach((r) => r.flush(page([lockOf('cs1')])));
    await again;
    watch();
    await flush();
    watch();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await flush();
    watch();
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.match((r) => r.url === '/api/locks').forEach((r) => r.flush(page([])));
    await away;
    expect(seen.filter((s) => s.startsWith('ready'))).toEqual([]);
    expect(draft.design()?.id).toBe('other');
    expect(draft.status()).toBe('ready');
  });

  it('times out a save point that hangs before a navigation, with a retry (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const away = draft.load(CS, 'other');
    await flush();
    const hung = http.expectOne(COMMITS);
    expect(draft.status()).toBe('loading');
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS);
    await away;
    expect(hung.cancelled).toBe(true);
    expect(draft.status()).toBe('stalled');
    // Nothing of the other design was read: Retry goes the same way again.
    http.expectNone('/api/change-sets/cs1/page-designs/other/working-copy');

    const retry = draft.load(CS, 'other');
    await flush();
    expect(draft.status()).toBe('loading');
    http
      .expectOne(COMMITS)
      .flush({ data: { type: 'Commit', id: 'c1', attributes: {} } });
    await flush();
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await retry;
    expect(draft.design()?.id).toBe('other');
    expect(draft.status()).toBe('ready');
  });

  it('times out a navigation behind a save that hangs, and sends that change again on Retry (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    const hung = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    const away = draft.load(CS, 'other');
    await flush();
    expect(draft.status()).toBe('loading');
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS);
    await away;
    expect(hung.cancelled).toBe(true);
    expect(draft.status()).toBe('stalled');
    await flush();
    // Whatever runs on (the save point behind the save) shows nothing of the design left.
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await flush();
    expect(draft.status()).toBe('stalled');

    const retry = draft.load(CS, 'other');
    await flush();
    const again = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(again.request.body.data.attributes.content.name).toBe('Changed');
    again.flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    http
      .expectOne(COMMITS)
      .flush({ data: { type: 'Commit', id: 'c2', attributes: {} } });
    await flush();
    http
      .expectOne('/api/change-sets/cs1/page-designs/other/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'other' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await retry;
    expect(draft.design()?.id).toBe('other');
    expect(draft.status()).toBe('ready');
  });

  it('never lets a navigation superseded since cancel the saves the newer one waits for (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    const slow = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    const first = draft.load(CS, 'other');
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS / 2);
    const second = draft.load(CS, 'third');
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS / 2 + 1);
    await first;
    // The first navigation's deadline passed, the second's not: the save goes on.
    expect(slow.cancelled).toBe(false);
    expect(draft.status()).toBe('loading');
    slow.flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await flush();
    http
      .expectOne('/api/change-sets/cs1/page-designs/third/working-copy')
      .flush(copyDoc({ ...DESIGN, id: 'third' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([]));
    await second;
    expect(draft.design()?.id).toBe('third');
  });

  it('sends a change made while a save point hung before reading the design again (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    void draft.savePoint();
    await flush();
    http.expectOne(COMMITS);
    draft.change({ ...DESIGN, name: 'Changed again' });
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS);
    // The change goes out first; the design is read again only after it.
    expect(http.match((r) => r.url === WC && r.method === 'GET')).toHaveLength(
      0,
    );
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed again' }, 2));
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'GET')
      .flush(copyDoc({ ...DESIGN, name: 'Changed again' }, 2));
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await flush();
    expect(draft.design()?.name).toBe('Changed again');
    expect(draft.status()).toBe('ready');
  });

  it('still sends the change a stalled navigation cancelled, and goes back to its design after it (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http.expectOne((r) => r.url === WC && r.method === 'PUT');
    const away = draft.load(CS, 'other');
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS);
    await away;
    expect(draft.status()).toBe('stalled');
    await flush();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await flush();

    const back = draft.load(CS, 'ours');
    await flush();
    const again = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(again.request.body.data.attributes.content.name).toBe('Changed');
    again.flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    http
      .expectOne(COMMITS)
      .flush({ data: { type: 'Commit', id: 'c2', attributes: {} } });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'GET')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await back;
    expect(draft.design()?.name).toBe('Changed');
    expect(draft.status()).toBe('ready');
  });

  it('sends the newest change before reading the design again when going back while a navigation waits (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'X' });
    await flush();
    const x = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    draft.change({ ...DESIGN, name: 'Y' });
    const away = draft.load(CS, 'other');
    await flush();
    const back = draft.load(CS, 'ours');
    await flush();
    expect(http.match((r) => r.url === WC && r.method === 'GET')).toHaveLength(
      0,
    );
    x.flush(copyDoc({ ...DESIGN, name: 'X' }, 1));
    await flush();
    const y = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(y.request.body.data.attributes.content.name).toBe('Y');
    y.flush(copyDoc({ ...DESIGN, name: 'Y' }, 2));
    await flush();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } }),
      );
    await flush();
    http
      .match(COMMITS)
      .forEach((r) =>
        r.flush({ data: { type: 'Commit', id: 'c2', attributes: {} } }),
      );
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'GET')
      .flush(copyDoc({ ...DESIGN, name: 'Y' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await back;
    await away;
    expect(draft.design()?.name).toBe('Y');
    expect(draft.status()).toBe('ready');
  });

  it('reads the design again when a save point times out with no navigation waiting (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const point = draft.savePoint();
    await flush();
    const hung = http.expectOne(COMMITS);
    await vi.advanceTimersByTimeAsync(DESIGN_SAVE_POINT_TIMEOUT_MS);
    expect(await point).toBe(false);
    expect(hung.cancelled).toBe(true);
    // The commit may have landed: what is there now is read, not guessed.
    http
      .expectOne((r) => r.url === WC && r.method === 'GET')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 0));
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await flush();
    expect(draft.status()).toBe('ready');
    expect(draft.design()?.name).toBe('Changed');
  });

  it('keeps the step of a refused undo, so Undo can be tried again (#557)', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    draft.undo();
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(
        { errors: [{ status: '422', code: 'invalid', title: 'Invalid' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await flush();
    expect(draft.design()?.name).toBe('Changed');
    expect(draft.canUndo()).toBe(true);
    draft.undo();
    await flush();
    const again = http.expectOne((r) => r.url === WC && r.method === 'PUT');
    expect(again.request.body.data.attributes.content.name).toBe('Ours');
    again.flush(copyDoc(DESIGN, 2));
    await flush();
    expect(draft.canUndo()).toBe(false);
  });

  it('leaves no refused change to undo', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(
        { errors: [{ status: '422', code: 'invalid', title: 'Invalid' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await flush();
    expect(draft.design()?.name).toBe('Ours');
    expect(draft.canUndo()).toBe(false);
  });

  it('puts the saved design back and turns read-only when the lock went elsewhere', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(
        { errors: [{ status: '409', code: 'locked', title: 'Locked' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await flush();
    expect(draft.design()?.name).toBe('Ours');
    expect(draft.saveState()).toBe('not-saved');
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.pageDesigns.blocked.locked',
    });
  });

  it('commits what is saved as a save point of the design', async () => {
    const { draft, http } = await loaded([lockOf('cs1')]);
    draft.change({ ...DESIGN, name: 'Changed' });
    await flush();
    http
      .expectOne((r) => r.url === WC && r.method === 'PUT')
      .flush(copyDoc({ ...DESIGN, name: 'Changed' }, 1));
    await flush();
    const point = draft.savePoint();
    await flush();
    const commit = http.expectOne(COMMITS);
    expect(commit.request.body.data.attributes).toEqual({
      subjects: [{ type: 'design', designId: 'ours' }],
      message: 'Update the page design ours',
    });
    commit.flush({ data: { type: 'Commit', id: 'c1', attributes: {} } });
    expect(await point).toBe(true);
    // Nothing left: a second one asks nothing.
    expect(await draft.savePoint()).toBe(true);
  });
});

describe('createDesign', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('takes the lock, then saves the first working copy on the change set’s base', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createDesign(api, 'cs1', DESIGN);
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'base1' },
      },
    });
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await flush();
    http.expectOne(LOCKS).flush({ data: lockOf('cs1') });
    await flush();
    const put = http.expectOne(WC);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body.meta).toEqual({ version: 0, baseCommit: 'base1' });
    expect(put.request.body.data.attributes.content).toEqual(DESIGN);
    put.flush(copyDoc(DESIGN, 1));
    await expect(done).resolves.toBeUndefined();
  });

  it('releases the lock it took when the first save fails, so no lock is left (#557)', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createDesign(api, 'cs1', DESIGN);
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'base1' },
      },
    });
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await flush();
    http.expectOne(LOCKS).flush({ data: lockOf('cs1') });
    await flush();
    http
      .expectOne(WC)
      .flush(
        { errors: [{ status: '422', code: 'invalid', title: 'Invalid' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await flush();
    const release = http.expectOne((r) => r.url === '/api/locks/l1');
    expect(release.request.method).toBe('DELETE');
    // Only while the change set has no changes to the design: a save that went through stays.
    expect(release.request.params.get('ifUnchanged')).toBe('true');
    release.flush(null, { status: 204, statusText: 'No Content' });
    await expect(done).rejects.toMatchObject({ code: 'invalid' });
  });

  it('still rejects with the save’s error when releasing the lock fails too', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createDesign(api, 'cs1', DESIGN);
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'base1' },
      },
    });
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await flush();
    http.expectOne(LOCKS).flush({ data: lockOf('cs1') });
    await flush();
    http.expectOne(WC).flush(null, { status: 502, statusText: 'Bad Gateway' });
    await flush();
    http
      .expectOne((r) => r.url === '/api/locks/l1')
      .flush(
        { errors: [{ status: '409', code: 'has-changes', title: 'Changes' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await expect(done).rejects.toMatchObject({ status: 502 });
  });

  it('leaves a lock the change set held before alone when the first save fails', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createDesign(api, 'cs1', DESIGN);
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'base1' },
      },
    });
    http.expectOne((r) => r.url === '/api/locks').flush(page([lockOf('cs1')]));
    await flush();
    http.expectOne(LOCKS).flush({ data: lockOf('cs1') });
    await flush();
    http
      .expectOne(WC)
      .flush(
        { errors: [{ status: '422', code: 'invalid', title: 'Invalid' }] },
        { status: 422, statusText: 'Unprocessable' },
      );
    await expect(done).rejects.toMatchObject({ code: 'invalid' });
    http.expectNone((r) => r.url === '/api/locks/l1');
  });

  it('rejects with the API’s error when the lock is held elsewhere', async () => {
    const { http } = setup();
    const api = TestBed.inject(ApiClient);
    const done = createDesign(api, 'cs1', DESIGN);
    http.expectOne('/api/change-sets/cs1').flush({
      data: {
        type: 'ChangeSet',
        id: 'cs1',
        attributes: { baseCommit: 'base1' },
      },
    });
    http.expectOne((r) => r.url === '/api/locks').flush(page());
    await flush();
    http
      .expectOne(LOCKS)
      .flush(
        { errors: [{ status: '409', code: 'locked', title: 'Locked' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await expect(done).rejects.toMatchObject({ code: 'locked' });
  });
});
