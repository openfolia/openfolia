import { createHash } from 'node:crypto';
import { PNG, PNG_HASH } from '@openfolia/content-repo/testing';
import type { Module } from '@openfolia/content-model';
import type { Actor } from '../src/access/core/actor.js';
import { AssetPageDocument } from '../src/assets/api/asset.resources.js';
import {
  ErrorDocument,
  JSON_API,
  REQUEST_HEADER,
} from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { ModuleWorkingCopyDocument } from '../src/change-sets/api/working-copy.resources.js';
import { actorWith } from './fakes/actors.js';
import { createTestApp, TOKEN, type TestApp } from './test-app.js';

/** A real 1×1 PNG with bytes of its own after its end, so neither the sample nor another test holds it. */
const UPLOAD = Buffer.concat([PNG, Buffer.from('#asset-list')]);
const UPLOAD_HASH = createHash('sha256').update(UPLOAD).digest('hex');

const author: Actor = {
  ...actorWith(['content.read', 'content.edit']),
  id: 'sample-author',
};
const other: Actor = { ...author, id: 'sample-other' };
const draftReader: Actor = {
  ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
  id: 'sample-reviewer',
};

let t: TestApp;

/** A change set of the author's own, its ID. */
async function newChangeSet(): Promise<string> {
  t.actAs(author);
  const created = await t.post('/change-sets').send(
    JSON.stringify({
      data: { type: 'ChangeSet', attributes: { title: 'Images' } },
    }),
  );
  expect(created.status).toBe(201);
  return ChangeSetDocument.parse(created.body).data.id;
}
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

const list = async (query = '') => {
  const res = await t.get(`/assets${query}`);
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe(JSON_API);
  return AssetPageDocument.parse(res.body);
};

const only = (body: unknown) => {
  const [first, ...rest] = ErrorDocument.parse(body).errors;
  expect(rest).toEqual([]);
  return first;
};

describe('GET /assets', () => {
  it('lists the images readable modules show, paged, with their uses', async () => {
    const doc = await list();
    const png = doc.data.find((a) => a.id === PNG_HASH);
    expect(png).toEqual({
      type: 'Asset',
      id: PNG_HASH,
      attributes: {
        reference: `sha256:${PNG_HASH}`,
        fileName: null,
        contentType: 'image/png',
        size: PNG.byteLength,
        width: 480,
        height: 300,
        font: null,
      },
      meta: {
        usedIn: expect.arrayContaining([
          { moduleId: 'charging', lang: 'en', title: 'Charging' },
        ]),
        usedInCount: expect.any(Number),
        usedInManuals: [],
        languages: ['de', 'en'],
        usedAs: ['image'],
        uploaded: false,
        missing: false,
      },
    });
    expect(doc.meta.page).toEqual({
      currentPage: 1,
      lastPage: 1,
      perPage: 50,
      total: doc.data.length,
    });
    expect(doc.links.self).toContain('/assets?');
  });

  it('pages and filters by type before paging', async () => {
    const all = await list();
    const first = await list('?page[size]=1');
    expect(first.data).toHaveLength(Math.min(1, all.data.length));
    expect(first.meta.page.total).toBe(all.meta.page.total);
    const pngs = await list('?filter[type]=image/png');
    expect(pngs.data.map((a) => a.attributes.contentType)).toEqual(
      pngs.data.map(() => 'image/png'),
    );
    expect(pngs.data.map((a) => a.id)).toContain(PNG_HASH);
    expect((await list('?filter[type]=image')).meta.page.total).toBe(
      all.meta.page.total,
    );
    const none = await list('?filter[type]=application/pdf');
    expect(none.data).toEqual([]);
    expect(none.meta.page.total).toBe(0);
  });

  it('never lists or counts an image only modules outside the scope show', async () => {
    t.actAs(actorWith(['content.read'], { moduleTypes: ['concept'] }));
    const scoped = await list();
    expect(scoped.data.map((a) => a.id)).not.toContain(PNG_HASH);
    expect(scoped.meta.page.total).toBe(scoped.data.length);
    t.actAs(actorWith(['content.read'], { languages: ['xx'] }));
    const nothing = await list();
    expect(nothing.data).toEqual([]);
    expect(nothing.meta.page.total).toBe(0);
  });

  it('finds images by alt text and by the modules showing them', async () => {
    for (const query of ['THE CHARGER', 'charging', 'Charg']) {
      const found = await list(`?filter[q]=${encodeURIComponent(query)}`);
      expect(found.data.map((a) => a.id)).toContain(PNG_HASH);
      expect(found.meta.page.total).toBe(found.data.length);
    }
    const none = await list('?filter[q]=no%20such%20picture');
    expect(none.data).toEqual([]);
    expect(none.meta.page.total).toBe(0);
    const jpegs = await list('?filter[q]=charger&filter[type]=image/jpeg');
    expect(jpegs.data).toEqual([]);
  });

  it('never finds or counts an image through a module the reader may not see', async () => {
    // On a change set's branch, the English module describes the image in
    // words of its own; the German one (title "Laden") shows it too.
    const cs = await newChangeSet();
    t.actAs(author);
    const subject = { type: 'module', lang: 'en', moduleId: 'charging' };
    const locked = await t
      .post(`/change-sets/${cs}/locks`)
      .send(
        JSON.stringify({ data: { type: 'Lock', attributes: { subject } } }),
      );
    expect(locked.status).toBe(201);
    const path = `/change-sets/${cs}/modules/en/charging/working-copy`;
    const read = await t.get(path);
    expect(read.status).toBe(200);
    const at = ModuleWorkingCopyDocument.parse(read.body).data.attributes;
    const content = at.content as Module;
    const saved = await t.put(path).send(
      JSON.stringify({
        data: {
          type: 'WorkingCopy',
          attributes: {
            content: {
              ...content,
              blocks: content.blocks.map((block) =>
                block.type === 'image'
                  ? { ...block, alt: 'Zebra crossing marker' }
                  : block,
              ),
            },
          },
        },
        meta: { version: at.version, baseCommit: at.baseCommit },
      }),
    );
    expect(saved.status).toBe(200);
    expect((await t.post(`/change-sets/${cs}/commits`)).status).toBe(201);
    const ref = encodeURIComponent(`change-sets/${cs}`);

    // A reader of every draft finds it by the English alt text.
    t.actAs(draftReader);
    const wide = await list(`?ref=${ref}&filter[q]=zebra`);
    expect(wide.data.map((a) => a.id)).toEqual([PNG_HASH]);

    // A reader of German only sees the image, through "Laden", but never
    // finds it through the English module's words, nor counts it.
    t.actAs(
      actorWith(['content.read', 'content.read.draft'], { languages: ['de'] }),
    );
    const hidden = await list(`?ref=${ref}&filter[q]=zebra`);
    expect(hidden.data).toEqual([]);
    expect(hidden.meta.page.total).toBe(0);
    const seen = await list(`?ref=${ref}&filter[q]=laden`);
    expect(seen.data.map((a) => [a.id, a.meta.usedInCount])).toEqual([
      [PNG_HASH, 1],
    ]);
  });

  it('pages the matches, and folds whitespace and marks as the texts', async () => {
    const all = await list('?filter[q]=charger');
    const second = await list('?filter[q]=charger&page[size]=1&page[number]=2');
    expect(second.meta.page.total).toBe(all.meta.page.total);
    expect(
      (await list('?filter[q]=the%20%20%20CHARGER')).data.map((a) => a.id),
    ).toContain(PNG_HASH);
    // Only a combining mark: folds to nothing, so finds nothing.
    const marks = await list('?filter[q]=%CC%81');
    expect(marks.data).toEqual([]);
    // 200 characters are taken.
    expect((await list(`?filter[q]=${'x'.repeat(200)}`)).data).toEqual([]);
  });

  it('never sends what is only kept for searching', async () => {
    const res = await t.get('/assets?filter[q]=charger');
    const raw = res.body as { data: { meta: { usedIn: object[] } }[] };
    for (const use of raw.data.flatMap((a) => a.meta.usedIn)) {
      expect(Object.keys(use).sort()).toEqual(['lang', 'moduleId', 'title']);
    }
    expect(raw.data.length).toBeGreaterThan(0);
  });

  it('refuses a malformed filter and a parameter it does not support', async () => {
    for (const [query, parameter] of [
      ['?filter[q]=', 'filter[q]'],
      ['?filter[q]=%20%20', 'filter[q]'],
      [`?filter[q]=${'x'.repeat(201)}`, 'filter[q]'],
      ['?filter[type]=Image', 'filter[type]'],
      ['?filter[type]=image/', 'filter[type]'],
      ['?sort=size', 'sort'],
    ] as const) {
      const res = await t.get(`/assets${query}`);
      expect(res.status).toBe(400);
      expect(only(res.body)?.source?.parameter).toBe(parameter);
    }
  });

  it('revalidates with an ETag of the answer, never immutable', async () => {
    const res = await t.get(`/assets?ref=${t.commits.main}`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const again = await t
      .get(`/assets?ref=${t.commits.main}`)
      .set('If-None-Match', res.headers['etag'] as string);
    expect(again.status).toBe(304);
  });

  describe('with filter[changeSet]', () => {
    let cs: string;
    beforeAll(async () => {
      t.actAs(author);
      const created = await t.post('/change-sets').send(
        JSON.stringify({
          data: { type: 'ChangeSet', attributes: { title: 'Images' } },
        }),
      );
      expect(created.status).toBe(201);
      cs = ChangeSetDocument.parse(created.body).data.id;
      const uploaded = await t
        .anonymous()
        .post(`/change-sets/${cs}/assets`)
        .set('Authorization', `Bearer ${TOKEN}`)
        .set(REQUEST_HEADER, '1')
        .attach('file', UPLOAD, {
          filename: 'a.png',
          contentType: 'image/png',
        });
      expect(uploaded.status).toBe(201);
      t.actAs(undefined);
    });

    it('lists the author’s uploads first, before a module shows them', async () => {
      t.actAs(author);
      const ref = encodeURIComponent(`change-sets/${cs}`);
      const doc = await list(`?ref=${ref}&filter[changeSet]=${cs}`);
      expect(doc.data[0]).toEqual({
        type: 'Asset',
        id: UPLOAD_HASH,
        attributes: {
          reference: `sha256:${UPLOAD_HASH}`,
          fileName: 'a.png',
          contentType: 'image/png',
          size: UPLOAD.byteLength,
          width: 480,
          height: 300,
          font: null,
        },
        meta: {
          usedIn: [],
          usedInCount: 0,
          usedInManuals: [],
          languages: [],
          usedAs: [],
          uploaded: true,
          missing: false,
        },
      });
      expect(doc.data.map((a) => a.id)).toContain(PNG_HASH);
      expect(doc.meta.page.total).toBe((await list()).meta.page.total + 1);
      // Without it, the upload is not listed.
      expect((await list(`?ref=${ref}`)).data.map((a) => a.id)).not.toContain(
        UPLOAD_HASH,
      );
    });

    it('is the author’s only: 403 for a reader of drafts, 404 for anyone else', async () => {
      t.actAs(draftReader);
      const forbidden = await t.get(`/assets?filter[changeSet]=${cs}`);
      expect(forbidden.status).toBe(403);
      expect(only(forbidden.body)?.code).toBe('forbidden');
      t.actAs(other);
      for (const id of [cs, '0198a3c4-0000-7000-8000-000000000000', 'nope']) {
        const res = await t.get(`/assets?filter[changeSet]=${id}`);
        expect(res.status).toBe(404);
        expect(only(res.body)?.code).toBe('not-found');
      }
    });
  });
});
