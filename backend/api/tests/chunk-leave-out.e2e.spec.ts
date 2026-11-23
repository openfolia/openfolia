import { execFileSync } from 'node:child_process';
import {
  MAX_EXPANDED_CHARS,
  MAX_EXPANDED_NODES,
  MAX_EXPANDED_TABLE_CELLS,
  MAX_NESTING_DEPTH,
  parseModule,
  printModule,
  type Block,
  type ExpansionLimits,
  type Module,
} from '@openfolia/content-model';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import type { Permission } from '../src/access/core/permissions.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ChangePageDocument } from '../src/changes/api/change.resources.js';
import { CheckPageDocument } from '../src/checks/api/check.resources.js';
import { ChunkPageDocument } from '../src/chunks/api/chunk.resources.js';
import { ReleaseDocument } from '../src/releases/api/release.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * #688: one module past the expansion limits is left out of a commit's chunks, and only it.
 * The app cuts chunks to a hundredth of the limits of #679 (`LIMITS`, #726), so the content
 * crossing them is a hundred times smaller. `wide` refers to `mid` 80 times and `mid` to
 * `leaf` 80 times: `wide` meets 6,400 module references (past `LIMITS.nodes`), `mid` 80.
 * `wide` is for the north only.
 */
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const LIMITS: ExpansionLimits = {
  nodes: MAX_EXPANDED_NODES / 100,
  chars: MAX_EXPANDED_CHARS / 100,
  cells: MAX_EXPANDED_TABLE_CELLS / 100,
  depth: MAX_NESTING_DEPTH,
};
const WIDTH = 80;
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
const refs = (id: string, to: string): Block[] => [
  { type: 'paragraph', id: 'own', content: text(`About ${id}.`) },
  ...Array.from({ length: WIDTH }, (_, i): Block => ({
    type: 'moduleRef',
    id: `to-${to}-${i}`,
    module: to,
  })),
];

const user = (id: string, permissions: Permission[]): Actor => ({
  ...actorWith(permissions),
  id,
});
const author = user('sample-author', ['content.read', 'content.edit']);
const reviewer = user('sample-reviewer', [
  'content.read',
  'content.read.draft',
  'content.review',
]);
const publisher = user('sample-publisher', ['content.read', 'release.publish']);
const consumer = user('rag-consumer', ['content.read']);
const SOUTH = actorWith(['content.read'], { facets: { region: ['south'] } });

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({}, { expansionLimits: LIMITS });
  await new GitWriter(dir()).commit({
    branch: 'main',
    parent: git('rev-parse', 'refs/heads/main'),
    changes: [
      module('leaf', [
        { type: 'paragraph', id: 'own', content: text('A leaf.') },
      ]),
      module('mid', refs('mid', 'leaf')),
      module('wide', refs('wide', 'mid'), true),
    ].map((m) => ({
      path: `modules/en/${m.id}.adoc`,
      content: printModule(m),
    })),
    message: 'A module referring too widely',
    author: { name: 'Someone', email: 'someone@example.com' },
  });
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

type Page = ReturnType<typeof ChunkPageDocument.parse>;

async function chunks(actor: Actor | undefined, query = ''): Promise<Page> {
  t.actAs(actor);
  const path = `/chunks?page[size]=200${query}`;
  const res = await t.get(path);
  expect([path, res.status]).toEqual([path, 200]);
  return ChunkPageDocument.parse(res.body);
}
const ids = (page: Page) => page.data.map((chunk) => chunk.id);

describe('a commit with one module too large to cut (#688)', () => {
  it('serves every other module’s chunks and names the one left out', async () => {
    const page = await chunks(undefined);
    expect(ids(page)).toEqual(
      expect.arrayContaining(['en/charging', 'en/leaf', 'en/mid']),
    );
    expect(ids(page)).not.toContain('en/wide');
    expect(page.meta.leftOut).toEqual([
      { moduleId: 'wide', lang: 'en', reason: 'size' },
    ]);
    // `mid` still holds its 80 leaves.
    expect(WIDTH * WIDTH).toBeGreaterThan(LIMITS.nodes);
    const mid = page.data.find((c) => c.id === 'en/mid');
    expect(mid?.attributes.text.split('A leaf.')).toHaveLength(WIDTH + 1);
  });

  it('names it only for what the request asks for', async () => {
    const one = await chunks(undefined, '&filter[module]=wide');
    expect(one.data).toEqual([]);
    expect(one.meta.page.total).toBe(0);
    expect(one.meta.leftOut).toEqual([
      { moduleId: 'wide', lang: 'en', reason: 'size' },
    ]);
    const other = await chunks(undefined, '&filter[module]=mid');
    expect(ids(other)).toEqual(['en/mid']);
    expect(other.meta.leftOut).toBeUndefined();
    // A variant leaves it out too.
    const variant = await chunks(undefined, '&filter[variant]=model=large');
    expect(ids(variant)).toContain('en/mid');
    expect(variant.meta.leftOut).toEqual([
      { moduleId: 'wide', lang: 'en', reason: 'size' },
    ]);
  });

  it('tells nothing of it to a reader who may not see it', async () => {
    const all = await chunks(undefined);
    const south = await chunks(SOUTH);
    expect(south.meta.leftOut).toBeUndefined();
    expect(JSON.stringify(south)).not.toContain('wide');
    expect(ids(south)).toContain('en/mid');
    // Neither listed nor counted, for either reader.
    expect(south.meta.page.total).toBe(south.data.length);
    expect(all.meta.page.total).toBe(all.data.length);
    expect(ids(south).every((id) => ids(all).includes(id))).toBe(true);
  });

  it('is an expansion-too-large check of the module before it is released', async () => {
    t.actAs(author);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Wider still' } },
      }),
    );
    expect(created.status).toBe(201);
    const { id, attributes } = ChangeSetDocument.parse(created.body).data;
    const wide = parseModule(git('show', 'main:modules/en/wide.adoc'), {
      id: 'wide',
    });
    await new GitWriter(dir()).commit({
      branch: attributes.branch,
      parent: git('rev-parse', `refs/heads/${attributes.branch}`),
      changes: [
        {
          path: 'modules/en/wide.adoc',
          content: printModule({
            ...wide,
            blocks: [
              { type: 'paragraph', id: 'more', content: text('More.') },
              ...wide.blocks,
            ],
          }),
        },
      ],
      message: 'Wider still',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    t.actAs(reviewer);
    const res = await t.get(`/change-sets/${id}/checks`);
    expect(res.status).toBe(200);
    const large = CheckPageDocument.parse(res.body).data.filter(
      (c) => c.attributes.code === 'expansion-too-large',
    );
    expect(large.map((c) => c.attributes)).toEqual([
      expect.objectContaining({
        severity: 'blocking',
        category: 'reference',
        subject: { type: 'module', lang: 'en', moduleId: 'wide' },
        params: { reason: 'size' },
      }),
    ]);
  });

  it('carries the release in the change feed, without the module’s chunks', async () => {
    // Where the consumer starts: before anything is released.
    t.actAs(consumer);
    const before = await t.get('/changes');
    expect(before.status).toBe(200);
    let cursor: string | undefined = ChangePageDocument.parse(before.body).meta
      .page.cursor;
    t.actAs(publisher);
    const cut = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.0' },
        },
      }),
    );
    expect(cut.status).toBe(201);
    const release = ReleaseDocument.parse(cut.body).data;
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
    expect(told).toContain('manual.released');
    expect(told).toEqual(
      expect.arrayContaining([
        'chunk.upserted en/leaf',
        'chunk.upserted en/mid',
      ]),
    );
    expect(told.some((s) => s.includes('en/wide'))).toBe(false);
    const at = await chunks(
      consumer,
      `&ref=${encodeURIComponent(release.attributes.tag)}`,
    );
    expect(at.meta.leftOut).toEqual([
      { moduleId: 'wide', lang: 'en', reason: 'size' },
    ]);

    // `mid` grows too large (80 × `mid2`, each 80 leaves): the next release removes its chunk.
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: git('rev-parse', 'refs/heads/main'),
      changes: [
        module('mid2', refs('mid2', 'leaf')),
        module('mid', refs('mid', 'mid2')),
      ].map((m) => ({
        path: `modules/en/${m.id}.adoc`,
        content: printModule(m),
      })),
      message: 'A module grown too large',
      author: { name: 'Someone', email: 'someone@example.com' },
    });
    t.actAs(publisher);
    const next = await t.post('/releases').send(
      JSON.stringify({
        data: {
          type: 'Release',
          attributes: { product: 'north', revision: '1.1' },
        },
      }),
    );
    expect(next.status).toBe(201);
    const later: string[] = [];
    t.actAs(consumer);
    for (let i = 0; i < 50; i++) {
      const query = new URLSearchParams({ 'page[size]': '200' });
      if (cursor !== undefined) query.set('page[cursor]', cursor);
      const res = await t.get(`/changes?${query.toString()}`);
      expect(res.status).toBe(200);
      const page = ChangePageDocument.parse(res.body);
      for (const e of page.data) {
        if (!e.attributes.event.startsWith('chunk.')) continue;
        later.push(
          `${e.attributes.event} ${String(e.attributes.data['chunkId'])}${e.attributes.data['reason'] ? ` ${String(e.attributes.data['reason'])}` : ''}`,
        );
      }
      cursor = page.meta.page.cursor;
      if (page.meta.upToDate) break;
    }
    expect(later).toContain('chunk.removed en/mid gone');
    expect(later).toContain('chunk.upserted en/mid2');
    expect(later.some((s) => s.includes('en/leaf'))).toBe(false);
  });
});
