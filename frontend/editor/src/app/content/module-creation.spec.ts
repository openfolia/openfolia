import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../api/api-interceptors';
import { ModuleCreation, type NewModule } from './module-creation';

const CS = { id: 'cs1', branch: 'change-sets/cs1' };
const module: NewModule = {
  id: 'charging',
  title: 'Charging',
  lang: 'en',
  type: 'procedure',
  audience: 'public',
  facets: { region: ['north'], empty: [] },
  keywords: ['maintenance', 'battery'],
};
const content = {
  schemaVersion: 1,
  id: 'charging',
  meta: {
    title: 'Charging',
    type: 'procedure',
    lang: 'en',
    audience: 'public',
    facets: { region: ['north'] },
    keywords: ['maintenance', 'battery'],
  },
  blocks: [],
};
const WC = '/api/change-sets/cs1/modules/en/charging/working-copy';

function setup() {
  TestBed.configureTestingModule({
    providers: [
      // As in the app: the API layer turns every failed call into an ApiError.
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
    ],
  });
  return {
    creation: TestBed.inject(ModuleCreation),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

const flushAll = () => new Promise((r) => setTimeout(r, 0));

const notFound = () =>
  [
    { errors: [{ status: '404', code: 'not-found' }] },
    { status: 404, statusText: 'Not Found' },
  ] as const;

const summaries = (ids: string[], next: string | null = null) => ({
  data: ids.map((id) => ({ type: 'ModuleSummary', id })),
  links: { next },
});

/** Answers the change set read and the working copy read (none). */
async function start(http: HttpTestingController) {
  await flushAll();
  http
    .expectOne('/api/change-sets/cs1')
    .flush({ data: { attributes: { baseCommit: 'base1' } } });
  await flushAll();
}

/** Answers the ID search (`pages` of other modules first) and the lock. */
async function free(http: HttpTestingController, pages = 1) {
  for (let page = 1; page <= pages; page++) {
    const search = http.expectOne((r) => r.url === '/api/module-summaries');
    expect(search.request.params.get('filter[q]')).toBe('charging');
    expect(search.request.params.get('ref')).toBe('change-sets/cs1');
    expect(search.request.params.get('page[number]')).toBe(String(page));
    search.flush(summaries(['charging-tips'], page < pages ? 'next' : null));
    await flushAll();
  }
  await lock(http);
}

async function lock(http: HttpTestingController) {
  const req = http.expectOne('/api/change-sets/cs1/locks');
  expect(req.request.body).toEqual({
    data: {
      type: 'Lock',
      attributes: {
        subject: { type: 'module', lang: 'en', moduleId: 'charging' },
      },
    },
  });
  req.flush({ data: { id: 'lock1' } }, { status: 201, statusText: 'Created' });
  await flushAll();
}

describe('ModuleCreation', () => {
  it('lists the module at once, then locks, saves and commits it', async () => {
    const { creation, http, toast } = setup();
    const done = creation.create(module, CS);
    expect(creation.pending().map((p) => p.module.id)).toEqual(['charging']);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http, 2);
    const put = http.expectOne(WC);
    expect(put.request.method).toBe('PUT');
    expect(put.request.body).toEqual({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: 0, baseCommit: 'base1' },
    });
    put.flush({ data: {} });
    await flushAll();
    const commit = http.expectOne('/api/change-sets/cs1/commits');
    expect(commit.request.body.data.attributes.subjects).toEqual([
      { type: 'module', lang: 'en', moduleId: 'charging' },
    ]);
    commit.flush({ data: {} }, { status: 201, statusText: 'Created' });
    expect(await done).toBe(true);
    expect(creation.pending()).toEqual([]);
    expect(creation.created()).toBe(1);
    expect(toast.toasts()[0]?.kind).toBe('success');
    http.verify();
  });

  it('copies the blocks of another module, read on the change set’s branch', async () => {
    const { creation, http } = setup();
    void creation.create(
      { ...module, copyFrom: { id: 'other', lang: 'de' } },
      CS,
    );
    await flushAll();
    const read = http.expectOne((r) => r.url === '/api/modules/de/other');
    expect(read.request.params.get('ref')).toBe('change-sets/cs1');
    read.flush({
      data: { attributes: { blocks: [{ type: 'paragraph', id: 'p' }] } },
    });
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    expect(
      http.expectOne(WC).request.body.data.attributes.content.blocks,
    ).toEqual([{ type: 'paragraph', id: 'p' }]);
  });

  it('starts from the blocks it is given, and says when it is created, after a Retry too (#309)', async () => {
    const { creation, http, toast } = setup();
    const created = vi.fn();
    const given = [
      {
        type: 'paragraph' as const,
        id: 'bnew',
        content: [{ type: 'text' as const, text: 'Hot.' }],
      },
    ];
    const done = creation.create({ ...module, blocks: given }, CS, {
      onCreated: created,
    });
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    const put = http.expectOne(WC);
    expect(put.request.body.data.attributes.content.blocks).toEqual(given);
    put.flush({ data: {} });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'branch-moved' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await flushAll();
    http.expectOne(WC).flush(null, { status: 204, statusText: 'No Content' });
    await flushAll();
    http
      .expectOne('/api/locks/lock1')
      .flush(null, { status: 204, statusText: 'No Content' });
    expect(await done).toBe(false);
    expect(created).not.toHaveBeenCalled();
    // The failure toast's Retry goes again, with the same blocks, and says so once created.
    toast.toasts()[0]!.onAction!();
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    const again = http.expectOne(WC);
    expect(again.request.body.data.attributes.content.blocks).toEqual(given);
    again.flush({ data: {} });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush({ data: {} }, { status: 201, statusText: 'Created' });
    await flushAll();
    expect(created).toHaveBeenCalledTimes(1);
    http.verify();
  });

  it('counts an earlier attempt that got through as done, never making two', async () => {
    const { creation, http } = setup();
    const done = creation.create(module, CS);
    await start(http);
    // Committed already (the answer was lost): the same content, in another member order.
    http.expectOne(WC).flush({
      data: {
        attributes: {
          content: { ...content, meta: { ...content.meta }, id: 'charging' },
        },
        meta: { saved: false },
      },
    });
    expect(await done).toBe(true);
    http.verify();
  });

  it('commits a saved working copy of an earlier attempt, after taking the lock', async () => {
    const { creation, http } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: true } },
    });
    await flushAll();
    await lock(http);
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush({ data: {} }, { status: 201, statusText: 'Created' });
    expect(await done).toBe(true);
    http.verify();
  });

  it('refuses a module ID that exists in another language, taking nothing', async () => {
    const { creation, http, toast } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    http
      .expectOne((r) => r.url === '/api/module-summaries')
      .flush(summaries(['charging']));
    expect(await done).toBe(false);
    expect(toast.toasts()[0]?.onAction).toBeUndefined();
    http.verify();
  });

  it('discards the working copy and releases the lock when the commit is refused', async () => {
    const { creation, http, toast } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    http.expectOne(WC).flush({ data: {} });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'branch-moved' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await flushAll();
    const discard = http.expectOne(WC);
    expect(discard.request.method).toBe('DELETE');
    discard.flush(null, { status: 204, statusText: 'No Content' });
    await flushAll();
    const release = http.expectOne('/api/locks/lock1');
    expect(release.request.method).toBe('DELETE');
    release.flush(null, { status: 204, statusText: 'No Content' });
    expect(await done).toBe(false);
    expect(toast.toasts()[0]?.onAction).toBeDefined();
    http.verify();
  });

  it('keeps a resumed working copy and its lock when the commit is refused', async () => {
    const { creation, http } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: true } },
    });
    await flushAll();
    await lock(http);
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'branch-moved' }] },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await done).toBe(false);
    http.verify(); // nothing discarded, nothing released
  });

  it('runs a double submit once', async () => {
    const { creation, http } = setup();
    // The first attempt is left waiting on purpose: only its first request matters here.
    void creation.create(module, CS);
    expect(await creation.create(module, CS)).toBe(false);
    expect(creation.pending()).toHaveLength(1);
    await flushAll();
    http.expectOne('/api/change-sets/cs1');
  });

  it.each([0, 502, 503, 504])(
    'keeps what a retry resumes from when the commit’s outcome is unknown (%i)',
    async (status) => {
      const { creation, http } = setup();
      const done = creation.create(module, CS);
      await start(http);
      http.expectOne(WC).flush(...notFound());
      await flushAll();
      await free(http);
      http.expectOne(WC).flush({ data: {} });
      await flushAll();
      const commit = http.expectOne('/api/change-sets/cs1/commits');
      if (status === 0) commit.error(new ProgressEvent('error'));
      else commit.flush(null, { status, statusText: 'Unknown' });
      expect(await done).toBe(false);
      http.verify(); // nothing discarded, nothing released
    },
  );

  it('rolls back a working copy it kept when the retry’s commit is refused', async () => {
    const { creation, http } = setup();
    const first = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    http.expectOne(WC).flush({ data: {} });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(null, { status: 504, statusText: 'Gateway Timeout' });
    expect(await first).toBe(false);

    const retry = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: true } },
    });
    await flushAll();
    await lock(http);
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'stale-working-copy' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await flushAll();
    const discard = http.expectOne(WC);
    expect(discard.request.method).toBe('DELETE');
    discard.flush(null);
    await flushAll();
    http.expectOne('/api/locks/lock1').flush(null);
    expect(await retry).toBe(false);
    http.verify();
  });

  it('rolls back a copy whose save had an unknown outcome, when the retry’s commit is refused', async () => {
    const { creation, http } = setup();
    const first = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    http
      .expectOne(WC)
      .flush(null, { status: 504, statusText: 'Gateway Timeout' });
    expect(await first).toBe(false);
    http.verify(); // kept: the save may have gone through

    const retry = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: true } },
    });
    await flushAll();
    await lock(http);
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'stale-working-copy' }] },
        { status: 409, statusText: 'Conflict' },
      );
    await flushAll();
    const discard = http.expectOne(WC);
    expect(discard.request.method).toBe('DELETE');
    discard.flush(null);
    await flushAll();
    http.expectOne('/api/locks/lock1').flush(null);
    expect(await retry).toBe(false);
    http.verify();
  });

  it('forgets a kept copy once it is committed', async () => {
    const { creation, http } = setup();
    const first = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    http.expectOne(WC).flush({ data: {} });
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await first).toBe(false);
    // The retry finds it committed: done, and no longer this tab's to remove.
    const retry = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: false } },
    });
    expect(await retry).toBe(true);
    // A later attempt that finds a saved copy (another tab's) must not remove it.
    const later = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: { attributes: { content }, meta: { saved: true } },
    });
    await flushAll();
    await lock(http);
    http
      .expectOne('/api/change-sets/cs1/commits')
      .flush(
        { errors: [{ status: '409', code: 'branch-moved' }] },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await later).toBe(false);
    http.verify();
  });

  it('leaves the lock alone when another attempt saved first', async () => {
    const { creation, http } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush(...notFound());
    await flushAll();
    await free(http);
    http
      .expectOne(WC)
      .flush(
        { errors: [{ status: '409', code: 'version-conflict' }] },
        { status: 409, statusText: 'Conflict' },
      );
    expect(await done).toBe(false);
    http.verify(); // no DELETE of the copy or the lock
  });

  it('refuses a module of that ID that is not ours, without a retry', async () => {
    const { creation, http, toast } = setup();
    const done = creation.create(module, CS);
    await start(http);
    http.expectOne(WC).flush({
      data: {
        attributes: { content: { ...content, blocks: [{ type: 'x' }] } },
        meta: { saved: false },
      },
    });
    expect(await done).toBe(false);
    expect(creation.pending()).toEqual([]);
    expect(toast.toasts()[0]).toMatchObject({ kind: 'error' });
    expect(toast.toasts()[0]?.onAction).toBeUndefined();
    http.verify();
  });

  it('takes the module back on a failure, with a toast that retries', async () => {
    const { creation, http, toast } = setup();
    const done = creation.create(module, CS);
    await flushAll();
    http
      .expectOne('/api/change-sets/cs1')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    expect(await done).toBe(false);
    expect(creation.pending()).toEqual([]);
    const failure = toast.toasts()[0];
    expect(failure?.kind).toBe('error');
    toast.runAction(failure?.id ?? 0);
    expect(creation.pending()).toHaveLength(1);
    await flushAll();
    http.expectOne('/api/change-sets/cs1');
  });
});
