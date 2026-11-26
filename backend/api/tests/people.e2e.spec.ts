import { execFileSync } from 'node:child_process';
import { GitWriter } from '@openfolia/content-repo';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { users } from '../src/access/repos/access.tables.js';
import { Seed, seedAccess } from '../src/access/repos/seed.js';
import { People } from '../src/base/api/people.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { NotificationsConsumer } from '../src/notifications/api/notifications-consumer.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/** Whether the people an answer names are deactivated (#928): `meta.people`, by `@NamesPeople()`. */
const READS: Permission[] = ['content.read', 'content.read.draft'];
const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith(permissions),
  id,
});
const author = user('sample-author', [...READS, 'content.edit']);
const reviewer = user('sample-reviewer', [...READS, 'content.review']);
const publisher = user('sample-publisher', [...READS, 'release.publish']);
/** Reads released content, and may list no users. */
const reader = user('sample-reader', ['content.read']);

let t: TestApp;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();

beforeAll(async () => {
  t = await createTestApp();
  await seedAccess(
    t.database,
    Seed.parse({
      roles: [author, reviewer, publisher].flatMap((a) =>
        a.roles.map((r) => ({ ...r, id: `${a.id}-${r.id}` })),
      ),
      users: [author, reviewer, publisher].map((a) => ({
        id: a.id,
        name: a.id,
        roles: a.roles.map((r) => `${a.id}-${r.id}`),
      })),
    }),
  );
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const deactivate = (id: string, at: Date | null = new Date()) =>
  t.database.db
    .update(users)
    .set({ deactivatedAt: at })
    .where(eq(users.id, id));

const peopleOf = (body: unknown) =>
  z.object({ meta: z.object({ people: People }) }).parse(body).meta.people;

/** A change set by `author`, editing `charging` on its branch. */
async function changeSet(): Promise<string> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Clearer charging' } },
    }),
  );
  expect(created.status).toBe(201);
  expect(peopleOf(created.body)).toEqual([
    { id: 'sample-author', deactivated: false },
  ]);
  const { id, attributes } = ChangeSetDocument.parse(created.body).data;
  await new GitWriter(dir()).commit({
    branch: attributes.branch,
    parent: git('rev-parse', `refs/heads/${attributes.branch}`),
    changes: [
      {
        path: 'modules/en/charging.adoc',
        content: git('show', 'main:modules/en/charging.adoc') + `\n// ${id}\n`,
      },
    ],
    message: 'Edit charging',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
  return id;
}

async function step(actor: Actor, id: string, name: string) {
  t.actAs(actor);
  const res = await t.post(`/change-sets/${id}/${name}`).send('');
  expect([name, res.status]).toEqual([name, 200]);
  return res;
}

describe('a deactivated user', () => {
  it('is told apart in history, review and comments, until reactivated', async () => {
    const id = await changeSet();
    t.actAs(reviewer);
    const commented = await t.post(`/change-sets/${id}/comments`).send(
      JSON.stringify({
        data: {
          type: 'Comment',
          attributes: {
            body: 'Is this safe?',
            subject: { type: 'module', lang: 'en', moduleId: 'charging' },
            blockId: 'intro',
          },
        },
      }),
    );
    expect(commented.status).toBe(201);
    await step(author, id, 'submit');
    expect(peopleOf((await step(reviewer, id, 'approve')).body)).toEqual([
      { id: 'sample-author', deactivated: false },
      { id: 'sample-reviewer', deactivated: false },
    ]);
    await step(publisher, id, 'merge');

    const answers = async () => {
      t.actAs(publisher);
      const paths = {
        changeSets: '/change-sets?filter[state]=merged',
        changeSet: `/change-sets/${id}`,
        review: `/change-sets/${id}/review`,
        comments: `/change-sets/${id}/comments?filter[resolved]=any`,
        history: '/modules/en/charging/history',
      };
      const out: Record<string, unknown> = {};
      for (const [name, path] of Object.entries(paths)) {
        const res = await t.get(path);
        expect([name, res.status]).toEqual([name, 200]);
        out[name] = peopleOf(res.body)
          .filter((p) => p.deactivated)
          .map((p) => p.id);
      }
      return out;
    };
    const none = {
      changeSets: [],
      changeSet: [],
      review: [],
      comments: [],
      history: [],
    };
    expect(await answers()).toEqual(none);

    t.actAs(publisher);
    const before = await t.get('/modules/en/charging/history');
    const confirm = () =>
      t
        .get('/modules/en/charging/history')
        .set('If-None-Match', String(before.headers['etag']));
    expect((await confirm()).status).toBe(304);
    await deactivate('sample-author');
    await deactivate('sample-reviewer');
    expect(await answers()).toEqual({
      changeSets: ['sample-author'],
      changeSet: ['sample-author'],
      review: ['sample-author', 'sample-reviewer'],
      comments: ['sample-reviewer'],
      history: ['sample-reviewer'],
    });
    // An answer kept from before is not confirmed by a 304.
    expect((await confirm()).status).toBe(200);

    await deactivate('sample-author', null);
    await deactivate('sample-reviewer', null);
    expect(await answers()).toEqual(none);
  });

  it('is told to a reader who may list no users, of those named only', async () => {
    const id = await changeSet();
    await step(author, id, 'submit');
    await step(reviewer, id, 'approve');
    await step(publisher, id, 'merge');
    await deactivate('sample-reviewer');
    try {
      t.actAs(reader);
      expect((await t.get('/users')).status).toBe(403);
      const res = await t.get('/modules/en/charging/history');
      const named = peopleOf(res.body);
      expect(named).toContainEqual({
        id: 'sample-reviewer',
        deactivated: true,
      });
      // Nothing but the ID and the state, and nobody the document does not name.
      for (const person of named) {
        expect(Object.keys(person)).toEqual(['id', 'deactivated']);
      }
      const { data } = res.body as { data: unknown };
      expect(named.every((p) => JSON.stringify(data).includes(p.id))).toBe(
        true,
      );
    } finally {
      await deactivate('sample-reviewer', null);
    }
  });
});

describe('a notification', () => {
  it('says of who caused it whether they are deactivated, in the inbox and alone', async () => {
    const id = await changeSet();
    await step(author, id, 'submit');
    await step(reviewer, id, 'approve');
    await t.app.get(NotificationsConsumer).runOnce();
    const told = async () => {
      t.actAs(author);
      const list = await t.get('/me/notifications');
      const { data } = z
        .object({ data: z.array(z.object({ id: z.string() })) })
        .parse(list.body);
      const one = await t.get(`/me/notifications/${data[0]?.id}`);
      return [list, one].map(({ body }) =>
        peopleOf(body).filter((p) => p.id === 'sample-reviewer'),
      );
    };
    const reviewerIs = (deactivated: boolean) => {
      const people = [{ id: 'sample-reviewer', deactivated }];
      return [people, people];
    };
    expect(await told()).toEqual(reviewerIs(false));
    await deactivate('sample-reviewer');
    try {
      expect(await told()).toEqual(reviewerIs(true));
    } finally {
      await deactivate('sample-reviewer', null);
    }
    expect(await told()).toEqual(reviewerIs(false));
  });
});

describe('the OpenAPI document', () => {
  type Schema = Record<string, unknown>;
  let doc: {
    paths: Record<string, Record<string, { responses: Schema }>>;
    components: { schemas: Record<string, Schema> };
  };
  beforeAll(async () => {
    doc = (await t.anonymous().get('/openapi.json')).body as typeof doc;
  });

  const resolve = (schema: Schema | undefined): Schema | undefined => {
    const ref = schema?.['$ref'];
    return typeof ref === 'string'
      ? doc.components.schemas[ref.split('/').at(-1) as string]
      : schema;
  };
  /** Whether a schema holds `{ kind: 'user' | 'service', id }`: someone named. */
  const names = (node: unknown, seen = new Set<unknown>()): boolean => {
    if (typeof node !== 'object' || node === null || seen.has(node)) {
      return false;
    }
    seen.add(node);
    const schema = resolve(node as Schema) as Schema;
    const properties = schema['properties'] as
      Record<string, Schema> | undefined;
    const kinds = properties?.['kind']?.['enum'];
    if (
      properties?.['id'] &&
      Array.isArray(kinds) &&
      kinds.includes('user') &&
      kinds.includes('service')
    ) {
      return true;
    }
    return Object.values(schema).some((value) => names(value, seen));
  };

  it('gives every document that names people `meta.people`', () => {
    /** Naming someone in a free-form record (a notification's `payload`), which no schema shows. */
    const FREE_FORM = [/^get \/me\/notifications(\/\{notificationId\})?$/];
    /** Naming someone, but nobody's work: the editor shows them nowhere as a person. */
    const LEFT_OUT = [
      // Who is asking: a deactivated user asks nothing.
      /^get \/me$/,
      // Deactivating a user releases their locks: no holder is deactivated.
      /\/locks(\/|$)/,
      // Who saved a draft or brought a file or an import in, whose webhook it is. A working copy
      // also holds what its author writes.
      /\/working-copy$/,
      /^post \/change-sets\/\{changeSetId\}\/assets$/,
      /\/imports(\/|$)/,
      /\/webhooks(\/|$)/,
    ];
    const missing: string[] = [];
    const needless: string[] = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        for (const [status, response] of Object.entries(operation.responses)) {
          if (!status.startsWith('2')) continue;
          const content = (
            response as { content?: Record<string, { schema?: Schema }> }
          ).content?.['application/vnd.api+json'];
          const schema = resolve(content?.schema);
          if (!schema) continue;
          const properties = schema['properties'] as Record<string, Schema>;
          const meta = resolve(properties?.['meta']);
          const has = 'people' in ((meta?.['properties'] ?? {}) as object);
          const route = `${method} ${path}`;
          const should =
            names(properties?.['data']) ||
            names(meta) ||
            FREE_FORM.some((p) => p.test(route));
          if (has && !should) needless.push(route);
          if (!has && should && !LEFT_OUT.some((p) => p.test(route)))
            missing.push(route);
        }
      }
    }
    expect({ missing: [...new Set(missing)], needless }).toEqual({
      missing: [],
      needless: [],
    });
    expect(JSON.stringify(doc)).not.toContain('x-openfolia-');
  });
});
