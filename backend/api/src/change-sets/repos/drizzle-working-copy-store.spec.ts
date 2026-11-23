import { PGlite } from '@electric-sql/pglite';
import type { Module } from '@openfolia/content-model';
import { sql } from 'drizzle-orm';
import {
  createTestDatabase,
  PGLITE_EXTENSIONS,
  PgliteDatabase,
} from '../../../tests/database.js';
import { manifest, module } from '../../../tests/fakes/fake-content.js';
import { DrizzleUnitOfWork } from '../../database/drizzle-unit-of-work.js';
import {
  type ChangeSet,
  changeSetBranch,
  newChangeSetId,
} from '../core/change-set.js';
import type { LockSubject } from '../core/lock.js';
import type { WorkingCopyWrite } from '../core/working-copy.js';
import { DrizzleChangeSetStore } from './drizzle-change-set-store.js';
import { DrizzleWorkingCopyStore } from './drizzle-working-copy-store.js';

const charging: LockSubject = {
  type: 'module',
  lang: 'en',
  moduleId: 'charging',
};
const operating: LockSubject = { type: 'manual', manualId: 'operating' };
const BASE = 'b'.repeat(40);

function changeSet(): ChangeSet {
  const id = newChangeSetId();
  const now = new Date();
  return {
    id,
    title: 'x',
    description: null,
    author: { kind: 'user', id: 'sample-author' },
    baseRef: 'main',
    baseCommit: 'c'.repeat(40),
    baseReleased: true,
    branch: changeSetBranch(id),
    state: 'draft',
    createdAt: now,
    updatedAt: now,
  };
}

const text = (t: string): Module => module('charging', 'en', t);

describe('DrizzleWorkingCopyStore', () => {
  let database: PgliteDatabase;
  let store: DrizzleWorkingCopyStore;
  let unit: DrizzleUnitOfWork;
  let mine: ChangeSet;
  let theirs: ChangeSet;
  const write = (over: Partial<WorkingCopyWrite> = {}): WorkingCopyWrite => ({
    changeSetId: mine.id,
    subject: charging,
    content: text('a'),
    baseCommit: BASE,
    updatedBy: { kind: 'user', id: 'sample-author' },
    ...over,
  });

  beforeEach(async () => {
    database = await createTestDatabase();
    store = new DrizzleWorkingCopyStore(database);
    unit = new DrizzleUnitOfWork(database);
    const changeSets = new DrizzleChangeSetStore(database);
    mine = changeSet();
    theirs = changeSet();
    await unit.run(async (tx) => {
      await changeSets.insert(tx, mine);
      await changeSets.insert(tx, theirs);
    });
  });
  afterEach(() => database?.close());

  it('saves by compare-and-swap on the version, storing the base each save names', async () => {
    const first = await unit.run((tx) => store.save(tx, write(), 0));
    expect(first).toEqual({
      changeSetId: mine.id,
      subject: charging,
      content: text('a'),
      baseCommit: BASE,
      version: 1,
      updatedBy: { kind: 'user', id: 'sample-author' },
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(await store.find(mine.id, charging)).toEqual(first);

    const second = await unit.run((tx) =>
      store.save(
        tx,
        write({ content: text('b'), baseCommit: 'd'.repeat(40) }),
        1,
      ),
    );
    expect(second).toMatchObject({
      version: 2,
      baseCommit: 'd'.repeat(40),
      content: text('b'),
    });

    // Stale, or created twice: nothing written, the current version back.
    for (const expected of [0, 1, 5]) {
      expect(
        await unit.run((tx) =>
          store.save(tx, write({ content: text('stale') }), expected),
        ),
      ).toEqual({ conflict: 2 });
    }
    expect((await store.find(mine.id, charging))?.content).toEqual(text('b'));
    // None at all.
    expect(
      await unit.run((tx) => store.save(tx, write({ subject: operating }), 3)),
    ).toEqual({ conflict: 0 });
  });

  it('keeps one per change set and subject', async () => {
    await unit.run(async (tx) => {
      await store.save(tx, write(), 0);
      await store.save(tx, write({ changeSetId: theirs.id }), 0);
      await store.save(
        tx,
        write({
          subject: operating,
          content: manifest('operating', ['charging']),
        }),
        0,
      );
    });
    expect((await store.find(theirs.id, charging))?.version).toBe(1);
    expect((await store.find(mine.id, operating))?.content).toEqual(
      manifest('operating', ['charging']),
    );
    expect(
      await store.find(mine.id, { ...charging, lang: 'de' }),
    ).toBeUndefined();
    expect(await store.find('not-a-uuid', charging)).toBeUndefined();

    expect(await unit.run((tx) => store.remove(tx, mine.id, charging))).toBe(
      true,
    );
    expect(await unit.run((tx) => store.remove(tx, mine.id, charging))).toBe(
      false,
    );
    expect(await unit.run((tx) => store.removeAllOf(tx, mine.id))).toBe(1);
    expect(await store.find(mine.id, operating)).toBeUndefined();
    expect(await store.find(theirs.id, charging)).toBeDefined();
  });

  it('lists sizes, reads in a transaction and removes by compare-and-swap', async () => {
    await unit.run(async (tx) => {
      await store.save(tx, write(), 0);
      await store.save(
        tx,
        write({
          subject: operating,
          content: manifest('operating', ['charging']),
        }),
        0,
      );
      await store.save(tx, write({ changeSetId: theirs.id }), 0);
    });
    await unit.run((tx) => store.save(tx, write({ content: text('b') }), 1));
    const sizes = await unit.run((tx) => store.sizesOf(tx, mine.id));
    // Subject-key order: manuals before modules.
    expect(sizes.map((s) => [s.subject, s.version])).toEqual([
      [operating, 1],
      [charging, 2],
    ]);
    for (const size of sizes) {
      expect(size.bytes).toBeGreaterThanOrEqual(
        new TextEncoder().encode(
          JSON.stringify((await store.find(mine.id, size.subject))?.content),
        ).length,
      );
    }
    expect(await unit.run((tx) => store.sizesOf(tx, 'not-a-uuid'))).toEqual([]);
    expect(
      (await unit.run((tx) => store.get(tx, mine.id, charging)))?.content,
    ).toEqual(text('b'));

    // Only at the version given, and the copy first saved then (to the ms).
    const created = sizes.find((x) => x.subject.type === 'module')?.createdAt;
    expect(created).toBeInstanceOf(Date);
    expect(
      await unit.run((tx) => store.removeAt(tx, mine.id, charging, 1)),
    ).toBe(false);
    expect(
      await unit.run((tx) =>
        store.removeAt(
          tx,
          mine.id,
          charging,
          2,
          new Date((created as Date).getTime() - 1),
        ),
      ),
    ).toBe(false);
    expect(await store.find(mine.id, charging)).toBeDefined();
    expect(
      await unit.run((tx) =>
        store.removeAt(tx, mine.id, charging, 2, created as Date),
      ),
    ).toBe(true);
    await unit.run((tx) => store.save(tx, write({ content: text('b') }), 0));
    expect(
      await unit.run((tx) => store.removeAt(tx, mine.id, charging, 1)),
    ).toBe(true);
    await unit.run((tx) => store.save(tx, write({ content: text('b') }), 0));
    await unit.run((tx) => store.save(tx, write({ content: text('b') }), 1));
    expect(await store.find(mine.id, charging)).toBeDefined();
    expect(
      await unit.run((tx) => store.removeAt(tx, mine.id, charging, 2)),
    ).toBe(true);
    expect(await store.find(mine.id, charging)).toBeUndefined();
    expect(await store.find(theirs.id, charging)).toBeDefined();
    expect(await unit.run((tx) => store.countOf(tx, mine.id))).toBe(1);
  });

  it('lists a template file’s text length in UTF-8 bytes, without its content (#803)', async () => {
    const notice: LockSubject = {
      type: 'template',
      templateId: 'house',
      path: 'parts/notice.typ',
    };
    // Two bytes for "ä", one for each quote and newline: escaped in JSON, not in the file.
    const body = 'ä "x"\n';
    await unit.run((tx) =>
      store.save(
        tx,
        write({ subject: notice, content: { schemaVersion: 1, text: body } }),
        0,
      ),
    );
    await unit.run((tx) => store.save(tx, write(), 0));
    const sizes = await unit.run((tx) => store.sizesOf(tx, mine.id));
    expect(sizes.map((s) => [s.subject.type, s.textBytes] as const)).toEqual([
      ['module', undefined],
      ['template', new TextEncoder().encode(body).length],
    ]);
  });

  it('moves a base on only from the base named, one version further', async () => {
    const saved = await unit.run((tx) => store.save(tx, write(), 0));
    const from = (saved as { baseCommit: string }).baseCommit;
    const to = 'e'.repeat(40);
    expect(
      await unit.run((tx) => store.rebase(tx, mine.id, charging, to, from)),
    ).toBe(false);
    expect(
      await unit.run((tx) => store.rebase(tx, mine.id, charging, from, to)),
    ).toBe(true);
    expect(await store.find(mine.id, charging)).toMatchObject({
      baseCommit: to,
      version: 2,
    });
    expect(
      await unit.run((tx) => store.rebase(tx, theirs.id, charging, from, to)),
    ).toBe(false);
  });

  it('rolls a save back with its transaction', async () => {
    await expect(
      unit.run(async (tx) => {
        await store.save(tx, write(), 0);
        throw new Error('later step failed');
      }),
    ).rejects.toThrow('later step failed');
    expect(await store.find(mine.id, charging)).toBeUndefined();
  });

  it('survives a restart of the database and a new adapter', async () => {
    await unit.run((tx) => store.save(tx, write({ content: text('kept') }), 0));
    const dump = await database.client.dumpDataDir('none');
    await database.close();
    database = new PgliteDatabase(
      await PGlite.create({ loadDataDir: dump, extensions: PGLITE_EXTENSIONS }),
    );
    const reopened = new DrizzleWorkingCopyStore(database);
    expect(await reopened.find(mine.id, charging)).toMatchObject({
      version: 1,
      content: text('kept'),
    });
  });

  it('holds its formats in the database too', async () => {
    const insert = (over: Record<string, string>) =>
      database.db.execute(
        sql.raw(
          `insert into working_copies (change_set_id, subject_type, subject_id, schema_version, content, base_commit, version, updated_by_kind, updated_by_id, created_at, updated_at) values (${[
            over['changeSetId'] ?? `'${mine.id}'`,
            over['subjectType'] ?? `'module'`,
            over['subjectId'] ?? `'en/charging'`,
            over['schemaVersion'] ?? '1',
            over['content'] ?? `'{"schemaVersion": 1}'`,
            over['baseCommit'] ?? `'${BASE}'`,
            over['version'] ?? '1',
            `'user'`,
            `'sample-author'`,
            'now()',
            'now()',
          ].join(', ')})`,
        ),
      );
    const bads: Record<string, string>[] = [
      { subjectId: `'en/Bad'` },
      { subjectType: `'role'` },
      { schemaVersion: '0' },
      { content: `'{"schemaVersion": 2}'` },
      { content: `'[1]'` },
      {
        content: `jsonb_build_object('schemaVersion', 1, 'x', repeat('a', 2100000))`,
      },
      { baseCommit: `'main'` },
      { version: '0' },
      { changeSetId: `'${newChangeSetId()}'` },
    ];
    for (const bad of bads) {
      await expect(insert(bad), JSON.stringify(bad)).rejects.toThrow();
    }
    await insert({});
  });
});
