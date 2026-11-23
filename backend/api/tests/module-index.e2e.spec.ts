import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument } from '../src/base/api/json-api.js';
import {
  ModuleDocument,
  ModulePageDocument,
} from '../src/modules/api/module.resources.js';
import { ContentRepository } from '../src/content/core/content.repository.js';
import {
  ModuleIndex,
  ModuleIndexStore,
} from '../src/modules/core/module-index.js';
import { moduleIndexCommits } from '../src/modules/repos/module-index.tables.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The module index (#45) over the sample repository: on `main`,
 * `en/charging` (procedure, public) refers to `en/safety-note` (concept,
 * public, region north); `en/internals` is internal; manual `operating`
 * (public) lists charging and internals, `service` (internal) internals and
 * charging. So the safety note is used by charging directly and by both
 * manuals through it.
 */
let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const publicReader: Actor = {
  ...actorWith(['content.read'], { maxAudience: 'public' }),
  id: 'public-reader',
};

async function list(query: string) {
  const res = await t.get(`/modules?filter[lang]=en&${query}`);
  expect(res.status).toBe(200);
  return ModulePageDocument.parse(res.body);
}
const ids = (page: { data: { id: string }[] }) => page.data.map((m) => m.id);

const error = (body: unknown) => ErrorDocument.parse(body).errors[0];

describe('GET /modules on the module index', () => {
  it('says where each module is used', async () => {
    const page = await list('');
    const note = page.data.find((m) => m.id === 'en/safety-note');
    expect(note?.meta).toMatchObject({
      usage: { manuals: 2, modules: 1 },
      usedIn: [
        {
          kind: 'manual',
          id: 'operating',
          title: 'Operating manual',
          direct: false,
        },
        {
          kind: 'manual',
          id: 'service',
          title: 'Service manual',
          direct: false,
        },
        { kind: 'module', id: 'charging', title: 'Charging', direct: true },
      ],
    });
    const charging = page.data.find((m) => m.id === 'en/charging');
    expect(charging?.meta).toMatchObject({
      usage: { manuals: 2, modules: 0 },
    });
  });

  it('names and counts only manuals and modules the reader may see', async () => {
    t.actAs(publicReader);
    const res = await t.get('/modules/en/safety-note');
    expect(res.status).toBe(200);
    const { meta } = ModuleDocument.parse(res.body).data;
    expect(meta.usage).toEqual({ manuals: 1, modules: 1 });
    expect(meta.usedIn.map((u) => u.id)).toEqual(['operating', 'charging']);
    expect(JSON.stringify(res.body)).not.toContain('service');
    expect(ids(await list(''))).not.toContain('en/internals');
  });

  it('filters by type, facet, product and status before paging', async () => {
    const procedures = await list('filter[type]=procedure');
    expect(ids(procedures)).toEqual(['en/charging']);
    expect(procedures.meta.page.total).toBe(1);
    expect(ids(await list('filter[facet]=region:north'))).toEqual([
      'en/safety-note',
    ]);
    // The sample's product facet is its first facet, `region`.
    expect(ids(await list('filter[product]=north'))).toEqual([
      'en/safety-note',
    ]);
    // `v1` holds the safety note and internals as on main; charging changed since.
    expect(ids(await list('filter[status]=changed'))).toEqual(['en/charging']);
    expect(ids(await list('filter[status]=released'))).toEqual([
      'en/internals',
      'en/safety-note',
    ]);
    expect((await list('filter[status]=unreleased')).meta.page.total).toBe(0);
  });

  it('sorts, and pages what it sorted', async () => {
    // The safety note: two manuals and a module; the others two manuals each.
    expect(ids(await list('sort=-usage,title'))).toEqual([
      'en/safety-note',
      'en/charging',
      'en/internals',
    ]);
    const second = await list('sort=-title&page[size]=1&page[number]=2');
    expect(ids(second)).toEqual(['en/internals']);
    expect(second.meta.page.total).toBe(3);
    expect(second.links.next).toContain('sort=-title');
  });

  it('refuses a sort or status it does not know', async () => {
    for (const query of [
      'sort=size',
      'sort=title,-title',
      'sort=',
      'filter[status]=draft',
      'filter[product]=Not_A_Key',
    ]) {
      const res = await t.get(`/modules?${query}`);
      expect(res.status, query).toBe(400);
      expect(error(res.body)?.code, query).toBe('invalid-parameter');
    }
  });

  it('gives the same index after it is dropped and rebuilt', async () => {
    await list('');
    const store = t.app.get(ModuleIndexStore);
    const main = t.commits.main;
    const before = await store.get(main);
    expect(before?.modules.map((m) => `${m.lang}/${m.id}`)).toEqual([
      'de/charging',
      'en/charging',
      'en/internals',
      'en/safety-note',
    ]);
    // The full rebuild (what `index-rebuild` runs) drops it all first.
    await t.database.db
      .insert(moduleIndexCommits)
      .values({ commit: 'f'.repeat(40) });
    const commits = await t.app.get(ModuleIndex).rebuild();
    expect(commits).toEqual(expect.arrayContaining([main, t.commits.v1]));
    expect(await store.get('f'.repeat(40))).toBeUndefined();
    expect(await store.get(main)).toEqual(before);
    // Dropped without a rebuild: built again from Git on the next read, the same.
    await t.database.db.delete(moduleIndexCommits);
    const fresh = new ModuleIndex(store, t.app.get(ContentRepository));
    expect(await fresh.at(main)).toEqual(before);
    expect(await store.get(main)).toEqual(before);
  });
});
