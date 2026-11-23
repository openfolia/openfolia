import { execFileSync } from 'node:child_process';
import {
  CHUNK_SET_MODULES_AT_LIMITS,
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
  printModule,
  type ExpansionLimits,
  type Block,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangePageDocument } from '../src/changes/api/change.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #684: the chunks of a commit share one budget. The app cuts chunks to a hundredth of the
 * limits of #679 (`LIMITS`, #726), so the content crossing them is a hundred times smaller.
 * `mid` refers to `leaf` 40 times, and each of 100 small modules (`r00` … `r99`, for the north
 * only) refers to `mid` 15 times: each expands to about 2,400 content nodes, within the limits
 * of one module (`LIMITS.nodes`), but together far past four times the content plus room for
 * 32 modules at those limits.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LIMITS: ExpansionLimits = {
  nodes: MAX_EXPANDED_NODES / 100,
  chars: MAX_EXPANDED_CHARS / 100,
  cells: MAX_EXPANDED_TABLE_CELLS / 100,
  depth: MAX_NESTING_DEPTH,
};
const COUNT = 100;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const text = (t: string) => [{ type: 'text' as const, text: t }];

const module = (id: string, blocks: Block[], north = false): Module => ({
  schemaVersion: 1,
  id,
  meta: {
    title: id,
    type: 'concept',
    lang: 'en',
    audience: 'public',
    facets: north ? { region: ['north'] } : {},
    keywords: [],
  },
  blocks,
});
const refs = (id: string, to: string, width: number): Block[] => [
  { type: 'paragraph', id: 'own', content: text(`About ${id}.`) },
  ...Array.from({ length: width }, (_, i): Block => ({
    type: 'moduleRef',
    id: `to-${to}-${i}`,
    module: to,
  })),
];
const many = Array.from({ length: COUNT }, (_, i) =>
  module(`r${String(i).padStart(2, '0')}`, refs(`r${i}`, 'mid', 15), true),
);

const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith(permissions),
  id,
});
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const consumer = user('rag-consumer', ['content.read']);
const author = user('sample-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
  'content.review',
]);
const SOUTH = actorWith(['content.read'], { facets: { region: ['south'] } });

async function commit(
  changes: { path: string; content?: string }[],
  message: string,
) {
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: changes.map((c) =>
      c.content === undefined
        ? { path: c.path, delete: true as const }
        : { path: c.path, content: c.content },
    ),
    message,
    author: { name: 'Someone', email: 'someone@example.com' },
  });
}
const file = (m: Module) => ({
  path: `modules/en/${m.id}.adoc`,
  content: printModule(m),
});

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({}, { expansionLimits: LIMITS });
  await commit(
    [
      module('leaf', [
        { type: 'paragraph', id: 'own', content: text('A leaf.') },
      ]),
      module('mid', refs('mid', 'leaf', 40)),
      ...many,
    ].map(file),
    'Many modules each including a lot',
  );
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

async function refused(actor: Actor | undefined, query = '') {
  t.actAs(actor);
  const res = await t.get(`/chunks?page[size]=200${query}`);
  expect(res.status).toBe(422);
  const [error] = ErrorDocument.parse(res.body).errors;
  return error;
}

async function release(revision: string) {
  t.actAs(publisher);
  const cut = await t.post('/releases').send(
    JSON.stringify({
      data: { type: 'Release', attributes: { product: 'north', revision } },
    }),
  );
  expect(cut.status).toBe(201);
}

/** The events the feed tells `consumer` from `cursor` until caught up, and where it ends. */
async function drain(cursor: string | undefined) {
  const told: string[] = [];
  t.actAs(consumer);
  for (let i = 0; i < 50; i++) {
    const query = new URLSearchParams({ 'page[size]': '200' });
    if (cursor !== undefined) query.set('page[cursor]', cursor);
    const res = await t.get(`/changes?${query.toString()}`);
    expect(res.status).toBe(200);
    const page = ChangePageDocument.parse(res.body);
    for (const e of page.data) {
      told.push(
        e.attributes.event.startsWith('chunk.')
          ? `${e.attributes.event} ${String(e.attributes.data['chunkId'])}`
          : e.attributes.event,
      );
    }
    cursor = page.meta.page.cursor;
    if (page.meta.upToDate) break;
  }
  return { told, cursor };
}

describe('a commit whose chunks are too large together (#684)', () => {
  it('is 422 chunk-set-too-large, naming the budget and the modules that expanded the most', async () => {
    const error = await refused(undefined);
    expect(error).toMatchObject({ status: '422', code: 'chunk-set-too-large' });
    const meta = error?.meta as {
      nodes: number;
      chars: number;
      tableCells: number;
      largest: { moduleId: string; lang: string; nodes: number }[];
    };
    expect(meta.nodes).toBeGreaterThanOrEqual(
      CHUNK_SET_MODULES_AT_LIMITS * LIMITS.nodes,
    );
    expect(meta.largest).toHaveLength(5);
    expect(meta.largest.every((m) => /^r\d\d$/.test(m.moduleId))).toBe(true);
    expect(meta.largest[0]?.nodes).toBeGreaterThan(LIMITS.nodes / 3);
    expect(meta.largest[0]?.nodes).toBeLessThan(LIMITS.nodes);
    // Every request for that commit, whatever it filters on.
    expect((await refused(undefined, '&filter[module]=leaf'))?.code).toBe(
      'chunk-set-too-large',
    );
    expect(
      (await refused(undefined, '&filter[variant]=model=large'))?.code,
    ).toBe('chunk-set-too-large');
  });

  it('serves a reader who may not see the modules that multiply', async () => {
    t.actAs(SOUTH);
    const res = await t.get('/chunks?page[size]=200');
    expect(res.status).toBe(200);
    const page = ChunkPageDocument.parse(res.body);
    const ids = page.data.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['en/leaf', 'en/mid']));
    expect(ids.some((id) => /^en\/r\d\d$/.test(id))).toBe(false);
    expect(JSON.stringify(page)).not.toContain('chunk-set-too-large');
  });

  it('is a blocking chunk-set-too-large check of a change set before it is approved (#710)', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'One more' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    await new GitWriter(dir()).commit({
      branch: attributes.branch,
      parent: git('rev-parse', `refs/heads/${attributes.branch}`),
      changes: [
        file(
          module('more', [
            { type: 'paragraph', id: 'own', content: text('More.') },
          ]),
        ),
      ],
      message: 'One more',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    const checksAs = async (actor: Actor) => {
      t.actAs(actor);
      const res = await t.get(`/change-sets/${id}/checks?page[size]=200`);
      expect(res.status).toBe(200);
      return CheckPageDocument.parse(res.body).data.map((c) => c.attributes);
    };
    const large = (await checksAs(reviewer)).filter(
      (c) => c.code === 'chunk-set-too-large',
    );
    expect(large).toHaveLength(5);
    for (const check of large) {
      expect(check).toMatchObject({
        severity: 'blocking',
        category: 'reference',
        subject: { type: 'module', lang: 'en' },
      });
      expect((check.subject as { moduleId: string }).moduleId).toMatch(
        /^r\d\d$/,
      );
    }
    // A reviewer who may not see the modules that multiply: nothing of them.
    const hidden = await checksAs({
      ...actorWith(['content.read', 'content.read.draft'], {
        facets: { region: ['south'] },
      }),
      id: 'sample-reviewer',
    });
    expect(hidden.map((c) => c.code)).not.toContain('chunk-set-too-large');
    expect(JSON.stringify(hidden)).not.toMatch(/"r\d\d"/);
  });

  it('is skipped by the change feed as a release that cannot be read, until one can be', async () => {
    t.actAs(consumer);
    const before = await t.get('/changes');
    expect(before.status).toBe(200);
    const start = ChangePageDocument.parse(before.body).meta.page.cursor;
    await release('1.0');
    const first = await drain(start);
    expect(first.told).toContain('manual.released');
    expect(first.told.some((s) => s.startsWith('chunk.'))).toBe(false);

    // Fewer of them: the next release can be cut, and tells every chunk.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await commit(
      many.slice(4).map((m) => ({ path: `modules/en/${m.id}.adoc` })),
      'Fewer modules including a lot',
    );
    await release('1.1');
    const next = await drain(first.cursor);
    expect(next.told).toEqual(
      expect.arrayContaining([
        'chunk.upserted en/leaf',
        'chunk.upserted en/mid',
        'chunk.upserted en/r00',
      ]),
    );
    expect(next.told).not.toContain('chunk.upserted en/r99');
  });
});
