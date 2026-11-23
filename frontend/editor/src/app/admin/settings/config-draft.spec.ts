import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';

import { translated } from '@openfolia/ui/i18n';
import { ToastService } from '@openfolia/ui/toast';

import { apiErrorInterceptor } from '../../api/api-interceptors';
import { MeService } from '../../permissions/me';
import { PermissionService } from '../../permissions/permission.service';
import {
  CONFIG_SAVE_POINT_DELAY_MS,
  ConfigDraft,
  type ConfigChangeSet,
} from './config-draft';
import type { ProjectConfig } from './config-model';
import { CONFIG } from './testing/config-fixture';

const CS: ConfigChangeSet = {
  id: 'cs1',
  branch: 'change-sets/cs1',
  state: 'draft',
  authorId: 'admin',
};
const WC = '/api/change-sets/cs1/config/working-copy';
const LOCKS = '/api/change-sets/cs1/locks';
const COMMITS = '/api/change-sets/cs1/commits';

const copyDoc = (content: ProjectConfig, version: number, base = 'c0') => ({
  data: {
    type: 'WorkingCopy',
    id: 'cs1/config',
    attributes: {
      subject: { type: 'config' },
      content,
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

/** Runs what is due now: on the fake clock in a test that fakes it (#562), else one real turn. */
const flush = () =>
  vi.isFakeTimers()
    ? vi.advanceTimersByTimeAsync(1)
    : new Promise((resolve) => setTimeout(resolve, 0));

function setup(person = 'admin', may = true) {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([apiErrorInterceptor])),
      provideHttpClientTesting(),
      { provide: MeService, useValue: { me: () => ({ id: person }) } },
      {
        provide: PermissionService,
        useValue: { state: () => ({ kind: may ? 'enabled' : 'hidden' }) },
      },
      ConfigDraft,
    ],
  });
  return {
    draft: TestBed.inject(ConfigDraft),
    http: TestBed.inject(HttpTestingController),
    toast: TestBed.inject(ToastService),
  };
}

async function loaded(version = 0, lock: unknown[] = []) {
  const ctx = setup();
  const done = ctx.draft.load(CS);
  ctx.http.expectOne(WC).flush(copyDoc(CONFIG, version));
  ctx.http.expectOne((r) => r.url === '/api/locks').flush(page(lock));
  await done;
  return ctx;
}

const without = (id: string): ProjectConfig => ({
  ...CONFIG,
  audiences: CONFIG.audiences.filter((a) => a.id !== id),
});

describe('ConfigDraft', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('reads the working copy of a draft the person started, to edit', async () => {
    const { draft } = await loaded();
    expect(draft.status()).toBe('ready');
    expect(draft.mode()).toEqual({ kind: 'edit' });
    expect(draft.config()?.audiences.map((a) => a.id)).toEqual([
      'public',
      'service',
    ]);
  });

  it('reads the committed configuration, read-only with the reason, outside a draft of one’s own', async () => {
    const { draft, http } = setup();
    const done = draft.load({ ...CS, authorId: 'someone' });
    const req = http.expectOne((r) => r.url === '/api/config');
    expect(req.request.params.get('ref')).toBe('change-sets/cs1');
    req.flush({
      data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
    });
    await done;
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.settings.blocked.notAuthor',
    });
    const none = draft.load(null);
    http
      .expectOne((r) => r.url === '/api/config')
      .flush({
        data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
      });
    await none;
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.settings.blocked.needsChangeSet',
    });
  });

  it('is read-only without the permissions, and when another change set holds the lock', async () => {
    const { draft, http } = setup('admin', false);
    const done = draft.load(CS);
    http
      .expectOne((r) => r.url === '/api/config')
      .flush({
        data: { type: 'ProjectConfig', id: 'project', attributes: CONFIG },
      });
    await done;
    expect(draft.mode()).toEqual({ kind: 'read', reason: null });
    TestBed.resetTestingModule();
    const locked = await loaded(0, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'other' } },
        },
      },
    ]);
    expect(locked.draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.settings.blocked.locked',
    });
  });

  it('shows a change at once and saves it after taking the lock', async () => {
    const { draft, http } = await loaded();
    expect(draft.change(without('service'), translated('x'))).toBe(true);
    expect(draft.config()?.audiences).toHaveLength(1);
    expect(draft.saveState()).toBe('saving');
    await flush();
    const lock = http.expectOne(LOCKS);
    expect(lock.request.body.data.attributes.subject).toEqual({
      type: 'config',
    });
    lock.flush({});
    await flush();
    const save = http.expectOne(WC);
    expect(save.request.method).toBe('PUT');
    expect(save.request.body.meta).toEqual({ version: 0, baseCommit: 'c0' });
    expect(save.request.body.data.attributes.content.audiences).toHaveLength(1);
    save.flush(copyDoc(without('service'), 1, 'c1'));
    await flush();
    expect(draft.saveState()).toBe('saved');
  });

  it('settles once the queued saves are done: saved, or not when the lock is held elsewhere (#589)', async () => {
    const { draft, http } = await loaded();
    draft.change(without('service'), translated('x'));
    let first: boolean | undefined;
    void draft.settled().then((v) => (first = v));
    await flush();
    http.expectOne(LOCKS).flush({});
    await flush();
    expect(first).toBeUndefined();
    http.expectOne(WC).flush(copyDoc(without('service'), 1, 'c1'));
    await flush();
    expect(first).toBe(true);

    // Another revision takes the lock before the next save (it went with a save point).
    (draft as unknown as { lockHeld: boolean }).lockHeld = false;
    draft.change(CONFIG, translated('x'));
    const second = draft.settled();
    await flush();
    http
      .expectOne(LOCKS)
      .flush(
        { errors: [{ status: '409', code: 'locked' }] },
        { status: 409, statusText: 'x' },
      );
    expect(await second).toBe(false);
    expect(draft.mode()).toEqual({
      kind: 'read',
      reason: 'editor.admin.settings.blocked.locked',
    });
  });

  it('refuses a configuration the content model would not store, without saving', async () => {
    const { draft } = await loaded();
    const show = vi.spyOn(TestBed.inject(ToastService), 'error');
    expect(draft.change({ ...CONFIG, audiences: [] }, translated('x'))).toBe(
      false,
    );
    expect(draft.config()?.audiences).toHaveLength(2);
    expect(show).toHaveBeenCalled();
  });

  it('puts the last saved configuration back when the usage check refuses, and says where', async () => {
    const { draft, http } = await loaded(1, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
        },
      },
    ]);
    const what = translated('editor.admin.settings.changes.remove', {
      label: 'Service',
    });
    draft.change(without('service'), what);
    await flush();
    http.expectOne(WC).flush(
      {
        errors: [
          {
            status: '422',
            code: 'config-in-use',
            meta: {
              subject: { type: 'module', lang: 'en', moduleId: 'charging' },
              issue: 'unknown-audience',
            },
          },
          {
            status: '422',
            code: 'config-in-use',
            meta: {
              subject: { type: 'manual', manualId: 'service' },
              issue: 'unknown-audience',
            },
          },
        ],
      },
      { status: 422, statusText: 'Unprocessable' },
    );
    await flush();
    expect(draft.config()?.audiences).toHaveLength(2);
    const refusal = draft.refusal();
    expect(refusal?.what).toBe(what);
    expect(refusal?.total).toBe(2);
    expect(refusal?.places.map((p) => p.subject.type)).toEqual([
      'module',
      'manual',
    ]);
  });

  it('offers a retry on another refusal, and puts the saved configuration back', async () => {
    const { draft, http, toast } = await loaded(1, [
      {
        type: 'Lock',
        id: 'l1',
        attributes: {},
        relationships: {
          changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
        },
      },
    ]);
    const show = vi.spyOn(toast, 'error');
    draft.change(without('service'), translated('x'));
    await flush();
    http
      .expectOne(WC)
      .flush(
        { errors: [{ status: '422', code: 'too-large' }] },
        { status: 422, statusText: 'x' },
      );
    await flush();
    expect(draft.config()?.audiences).toHaveLength(2);
    expect(draft.saveState()).toBe('not-saved');
    const options = show.mock.calls[0]?.[1];
    expect(options?.actionLabel).toEqual(translated('editor.session.retry'));
    options?.onAction?.();
    expect(draft.config()?.audiences).toHaveLength(1);
    await flush();
    http.expectOne(WC).flush(copyDoc(without('service'), 2));
    await flush();
    expect(draft.saveState()).toBe('saved');
  });

  it('makes a save point after a quiet while', async () => {
    vi.useFakeTimers();
    try {
      const { draft, http } = await loaded(1, [
        {
          type: 'Lock',
          id: 'l1',
          attributes: {},
          relationships: {
            changeSet: { data: { type: 'ChangeSet', id: 'cs1' } },
          },
        },
      ]);
      vi.advanceTimersByTime(CONFIG_SAVE_POINT_DELAY_MS);
      await flush();
      const commit = http.expectOne(COMMITS);
      expect(commit.request.body.data.attributes.subjects).toEqual([
        { type: 'config' },
      ]);
      commit.flush({ meta: { commit: null, head: 'c2', unchanged: [] } });
      await flush();
      expect(draft.commits()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
