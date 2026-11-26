import type { Manifest, Module } from '@openfolia/content-model';
import { GitRepo } from '@openfolia/content-repo';
import { sql } from 'drizzle-orm';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { CommitDocument } from '../src/change-sets/api/commit.resources.js';
import {
  ManualWorkingCopyDocument,
  ModuleWorkingCopyDocument,
} from '../src/change-sets/api/working-copy.resources.js';
import { WorkingCopyStore } from '../src/change-sets/core/working-copy-store.js';
import { OpenSnapshotAction } from '../src/content/core/actions/open-snapshot.action.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * Reads of working copies that overlap a save point (#935): whichever of a read's steps (opening
 * the branch, listing the working copies, reading each) the save point lands before, the answer
 * is the working copy or the commit made from it, never what was there before both.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(async () => {
  vi.restoreAllMocks();
  t?.actAs(undefined);
  await t?.database.db.execute(sql`delete from working_copies`);
});

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'raced-author',
};

const TYPED = 'Typed before the save point.';
const RETITLED = 'Retitled before the save point';

interface Draft {
  readonly id: string;
  readonly ref: string;
}

/** A new change set of `author`'s (every other lock is gone). */
async function draft(subject: unknown): Promise<Draft> {
  t.actAs(author);
  await t.database.db.execute(sql`delete from locks`);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Raced' } },
    }),
  );
  expect(created.status).toBe(201);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  const locked = await t
    .post(`/change-sets/${id}/locks`)
    .send(JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }));
  expect(locked.status).toBe(201);
  return { id, ref: encodeURIComponent(attributes.branch) };
}

async function save(path: string, content: unknown, baseCommit: string) {
  const saved = await t.put(path).send(
    JSON.stringify({
      data: { type: 'WorkingCopy', attributes: { content } },
      meta: { version: 0, baseCommit },
    }),
  );
  expect(saved.status).toBe(200);
}

const moduleCopy = (cs: string, id: string) =>
  `/change-sets/${cs}/modules/en/${id}/working-copy`;
const manualCopy = (cs: string, id: string) =>
  `/change-sets/${cs}/manuals/${id}/working-copy`;

/** A change set with a working copy of the module `id` (`charging` is on the branch already). */
async function moduleDraft(id: string): Promise<Draft> {
  const cs = await draft({ type: 'module', lang: 'en', moduleId: id });
  const { content, baseCommit } = ModuleWorkingCopyDocument.parse(
    (await t.get(moduleCopy(cs.id, 'charging'))).body,
  ).data.attributes;
  const module: Module = {
    ...(content as Module),
    id,
    blocks: [
      {
        type: 'paragraph',
        id: 'typed',
        content: [{ type: 'text', text: TYPED }],
      },
    ],
  };
  await save(moduleCopy(cs.id, id), module, baseCommit);
  return cs;
}

/** A change set with a working copy of the manual `id` (`operating` is on the branch already). */
async function manualDraft(id: string): Promise<Draft> {
  const cs = await draft({ type: 'manual', manualId: id });
  const { content, baseCommit } = ManualWorkingCopyDocument.parse(
    (await t.get(manualCopy(cs.id, 'operating'))).body,
  ).data.attributes;
  const manifest = { ...(content as Manifest), id, title: RETITLED };
  await save(manualCopy(cs.id, id), manifest, baseCommit);
  return cs;
}

async function savePoint(cs: Draft, attributes?: Record<string, unknown>) {
  const request = t.post(`/change-sets/${cs.id}/commits`);
  const made = await (attributes
    ? request.send(JSON.stringify({ data: { type: 'Commit', attributes } }))
    : request);
  expect([made.status, made.text]).toEqual([201, expect.anything()]);
  return CommitDocument.parse(made.body).data.id;
}

/**
 * Runs `during` right before the `step`-th of the steps a read takes (0 is the first): opening
 * the branch, a transaction of the database, reading a working copy. `happened` says whether the
 * read took that many.
 */
function before(step: number, during: () => Promise<unknown>) {
  let seen = 0;
  const done = { happened: false };
  const hook = async () => {
    if (done.happened || seen++ !== step) return;
    done.happened = true;
    await during();
  };
  const hold = <T extends object>(port: T, method: keyof T & string) => {
    const real = (port[method] as (...args: unknown[]) => unknown).bind(port);
    vi.spyOn(port as Record<string, () => unknown>, method).mockImplementation(
      async (...args: unknown[]) => {
        await hook();
        return real(...args);
      },
    );
  };
  hold(t.app.get(OpenSnapshotAction), 'handle');
  hold(t.app.get(UnitOfWork), 'run');
  hold(t.app.get(WorkingCopyStore), 'find');
  return done;
}

/**
 * Reads once per step it takes, each time in a change set of its own, with `during` overlapping
 * it at that step; `check` gets each answer.
 */
async function atEveryStep<T>(request: {
  set: (step: number) => Promise<Draft>;
  during: (cs: Draft, step: number) => Promise<unknown>;
  read: (cs: Draft, step: number) => PromiseLike<T>;
  check: (answer: T) => void;
}): Promise<void> {
  const failed: unknown[] = [];
  let step = 0;
  for (; ; step++) {
    const cs = await request.set(step);
    const overlap = before(step, () => request.during(cs, step));
    const answer = await request.read(cs, step);
    vi.restoreAllMocks();
    if (!overlap.happened) break;
    try {
      request.check(answer);
    } catch (error) {
      failed.push(`Overlapped at step ${step}: ${String(error)}`);
    }
  }
  // At least: opening the branch, listing the working copies, reading one or opening it again.
  expect(step).toBeGreaterThanOrEqual(2);
  expect(failed).toEqual([]);
}

type Answer = Awaited<ReturnType<TestApp['get']>>;

const shows = (text: string) => (answer: Answer) => {
  expect([answer.status, answer.text]).toEqual([
    200,
    expect.stringContaining(text),
  ]);
};

const preview = (cs: Draft, id: string) =>
  t.get(`/modules/en/${id}/preview?ref=${cs.ref}&workingCopy=true`);
const html = (cs: Draft, id: string) =>
  t.get(
    `/manuals/${id}/variants/model=large/en/html?ref=${cs.ref}&workingCopy=true`,
  );
const png = (cs: Draft, id: string) =>
  t
    .get(
      `/manuals/${id}/variants/model=large/en/pdf/pages/1.png?ref=${cs.ref}&workingCopy=true`,
    )
    .buffer(true);

const TIMEOUT = 300_000;

describe('a read of working copies overlapping a save point', () => {
  it(
    'shows a module on the branch as typed, never as it was before',
    () =>
      atEveryStep({
        set: () => moduleDraft('charging'),
        during: (cs) => savePoint(cs),
        read: (cs) => preview(cs, 'charging'),
        check: shows(TYPED),
      }),
    TIMEOUT,
  );

  it(
    'shows a new module',
    () =>
      atEveryStep({
        set: (step) => moduleDraft(`raced-${step}`),
        during: (cs) => savePoint(cs),
        read: (cs, step) => preview(cs, `raced-${step}`),
        check: shows(TYPED),
      }),
    TIMEOUT,
  );

  it(
    'shows a manual on the branch as edited, never as it was before',
    () =>
      atEveryStep({
        set: () => manualDraft('operating'),
        during: (cs) => savePoint(cs),
        read: (cs) => html(cs, 'operating'),
        check: shows(RETITLED),
      }),
    TIMEOUT,
  );

  it(
    'shows a new manual',
    () =>
      atEveryStep({
        set: (step) => manualDraft(`raced-${step}`),
        during: (cs) => savePoint(cs),
        read: (cs, step) => html(cs, `raced-${step}`),
        check: shows(RETITLED),
      }),
    TIMEOUT,
  );

  it(
    'shows a page of a new manual’s PDF',
    () =>
      atEveryStep({
        set: (step) => manualDraft(`raced-${step}`),
        during: (cs) => savePoint(cs),
        read: (cs, step) => png(cs, `raced-${step}`),
        check: (answer) => {
          expect([answer.status, answer.type]).toEqual([200, 'image/png']);
        },
      }),
    TIMEOUT,
  );

  it(
    'shows a manual’s module as typed, whichever of them is read when it lands',
    () =>
      atEveryStep({
        set: () => moduleDraft('charging'),
        during: (cs) => savePoint(cs),
        read: (cs) => html(cs, 'operating'),
        check: shows(TYPED),
      }),
    TIMEOUT,
  );

  it(
    'never shows the committed file of a module the save point deletes',
    () =>
      atEveryStep({
        set: () => moduleDraft('charging'),
        during: (cs) =>
          savePoint(cs, {
            subjects: [],
            deletes: [{ type: 'module', lang: 'en', moduleId: 'charging' }],
          }),
        read: (cs) => preview(cs, 'charging'),
        check: (answer) => {
          if (answer.status !== 404) shows(TYPED)(answer);
        },
      }),
    TIMEOUT,
  );

  it(
    'reads the branch once a working copy is discarded',
    () =>
      atEveryStep({
        set: () => moduleDraft('charging'),
        during: async (cs) => {
          const gone = await t.delete(moduleCopy(cs.id, 'charging'));
          expect(gone.status).toBe(204);
        },
        read: (cs) => preview(cs, 'charging'),
        check: (answer) => expect(answer.status).toBe(200),
      }),
    TIMEOUT,
  );

  it('opens the branch from a ref listing of its own, as another process may have moved it', async () => {
    const cs = await moduleDraft('charging');
    const forgotten = vi.spyOn(GitRepo.prototype, 'forgetListings');
    expect((await preview(cs, 'charging')).status).toBe(200);
    expect(forgotten).toHaveBeenCalledTimes(1);
    expect((await t.get(moduleCopy(cs.id, 'charging'))).status).toBe(200);
    expect(forgotten).toHaveBeenCalledTimes(2);
  });

  it('answers 409 when what it reads is taken away again and again', async () => {
    const cs = await moduleDraft('charging');
    const find = vi
      .spyOn(t.app.get(WorkingCopyStore), 'find')
      .mockResolvedValue(undefined);
    const answer = await preview(cs, 'charging');
    expect(answer.status).toBe(409);
    expect(ErrorDocument.parse(answer.body).errors[0]?.code).toBe(
      'working-copy-changed',
    );
    expect(find).toHaveBeenCalledTimes(4);
  });

  it('names the commit it read in X-Ccms-Commit', async () => {
    const cs = await moduleDraft('charging');
    let head: string | undefined;
    // Before the second step: the branch was opened, no working copy was read.
    const overlap = before(1, async () => {
      head = await savePoint(cs);
    });
    const answer = await preview(cs, 'charging');
    expect(overlap.happened).toBe(true);
    expect(answer.headers['x-ccms-commit']).toBe(head);
  });

  it(
    'gives the editor a module’s working copy or its commit, and the commit’s ID with it',
    () =>
      atEveryStep({
        set: () => moduleDraft('charging'),
        during: (cs) => savePoint(cs),
        read: (cs) => t.get(moduleCopy(cs.id, 'charging')),
        check: (answer) => {
          const { attributes } = ModuleWorkingCopyDocument.parse(
            answer.body,
          ).data;
          expect(JSON.stringify(attributes.content)).toContain(TYPED);
          // As committed: based on the commit that holds it, not on the one before.
          if (attributes.version === 0) {
            expect(attributes.baseCommit).not.toBe(t.commits.main);
          }
        },
      }),
    TIMEOUT,
  );

  it(
    'gives the editor a new manual’s working copy or its commit',
    () =>
      atEveryStep({
        set: (step) => manualDraft(`raced-${step}`),
        during: (cs) => savePoint(cs),
        read: (cs, step) => t.get(manualCopy(cs.id, `raced-${step}`)),
        check: (answer) => {
          expect(answer.status).toBe(200);
          expect(
            ManualWorkingCopyDocument.parse(answer.body).data.attributes.content
              .title,
          ).toBe(RETITLED);
        },
      }),
    TIMEOUT,
  );
});
