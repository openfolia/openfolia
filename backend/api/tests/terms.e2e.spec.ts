import { execFileSync } from 'node:child_process';
import { addSampleTerms, SAMPLE_TERMS } from '@openfolia/content-repo/testing';
import { GitWriter } from '@openfolia/content-repo';
import type { Actor } from '../src/access/core/actor.js';
import { ErrorDocument, JSON_API } from '../src/base/api/json-api.js';
import { ChangeSetDocument } from '../src/change-sets/api/change-set.resources.js';
import { SearchPageDocument } from '../src/search/api/search.resources.js';
import {
  TermDocument,
  TermPageDocument,
} from '../src/terms/api/term.resources.js';
import { actorWith, READER } from './fakes/actors.js';
import { createTestApp, type TestApp } from './test-app.js';

/**
 * The terms routes over the sample repository with its terms
 * (`addSampleTerms`: battery, charger, housing, power-pack on `main`), and
 * one file that is no term, `terms/broken.yaml`, on top.
 */
let t: TestApp;
let main: string;
const dir = () => process.env['CCMS_CONTENT_DIR'] as string;
const git = (...args: string[]) =>
  execFileSync('git', ['-C', dir(), ...args], { encoding: 'utf8' }).trim();
const errors = (body: unknown) => ErrorDocument.parse(body).errors;

beforeAll(async () => {
  t = await createTestApp();
  const withTerms = await addSampleTerms(dir());
  main = (
    await new GitWriter(dir()).commit({
      branch: 'main',
      parent: withTerms,
      changes: [{ path: 'terms/broken.yaml', content: 'status: [\n' }],
      message: 'A broken term',
      author: { name: 'Someone', email: 'someone@example.com' },
    })
  ).commit;
});
afterAll(() => t?.close());
afterEach(() => t?.actAs(undefined));

async function list(query = '', actor: Actor = READER) {
  t.actAs(actor);
  const res = await t.get(`/terms${query}`);
  expect([query, res.status]).toEqual([query, 200]);
  expect(res.headers['content-type']).toBe(JSON_API);
  return TermPageDocument.parse(res.body);
}

const ids = async (query: string) =>
  (await list(query)).data.map((term) => term.id);

describe('GET /terms', () => {
  it('lists every term by ID, pinned to the commit, a broken file with why', async () => {
    t.actAs(READER);
    const res = await t.get('/terms');
    expect(res.status).toBe(200);
    expect(res.headers['x-ccms-commit']).toBe(main);
    const page = TermPageDocument.parse(res.body);
    expect(page.data.map((term) => term.id)).toEqual([
      'battery',
      'broken',
      'charger',
      'housing',
      'power-pack',
    ]);
    expect(page.meta.page.total).toBe(5);
    expect(page.data[1]).toEqual({
      type: 'Term',
      id: 'broken',
      attributes: {},
      meta: { error: expect.stringContaining('terms/broken.yaml') },
    });
    const charger = page.data[2];
    expect(charger).toMatchObject({
      type: 'Term',
      id: 'charger',
      attributes: {
        schemaVersion: 1,
        status: 'approved',
        domain: 'charging',
        languages: {
          en: {
            preferred: 'charger',
            allowed: [{ term: 'charging unit' }],
            forbidden: [
              {
                term: 'loader',
                note: 'Reads as a machine that loads goods.',
              },
            ],
            definition: [
              { type: 'text', text: 'The device that charges the ' },
              { type: 'text', text: 'battery', marks: [{ type: 'strong' }] },
              { type: 'text', text: '.' },
            ],
            usage: 'Name it in full on first use.',
          },
        },
      },
      meta: { issues: [] },
    });
  });

  it('filters before paging; filter[q] finds a term by a forbidden variant', async () => {
    expect(await ids('?filter[q]=loader')).toEqual(['charger']);
    expect(await ids('?filter[q]=ACCUMULATOR')).toEqual(['battery']);
    expect(await ids('?filter[q]=outer%20shell')).toEqual(['housing']);
    expect(await ids('?filter[status]=deprecated')).toEqual(['power-pack']);
    expect(await ids('?filter[domain]=Power')).toEqual([
      'battery',
      'power-pack',
    ]);
    expect(await ids('?filter[lang]=de')).toEqual(['battery', 'charger']);
    expect(await ids('?filter[lang]=de&filter[q]=loader')).toEqual([]);
    const paged = await list('?filter[lang]=en&page[number]=2&page[size]=2');
    expect(paged.data.map((term) => term.id)).toEqual([
      'housing',
      'power-pack',
    ]);
    expect(paged.meta.page.total).toBe(4);
  });

  it('lets every reader of the ref read them, whatever their scope', async () => {
    const narrow = actorWith(['content.read'], {
      languages: ['de'],
      maxAudience: 'public',
    });
    expect((await list('', narrow)).data).toHaveLength(5);
  });

  it('reads them at ?ref=, like every content route', async () => {
    expect(await ids('?ref=v1')).toEqual([]);
    t.actAs(READER);
    const missing = await t.get('/terms?ref=no-such-ref');
    expect(missing.status).toBe(404);
  });

  it('refuses malformed filters and unsupported parameters', async () => {
    t.actAs(READER);
    for (const query of [
      'filter[status]=old',
      'filter[q]=%20%20',
      `filter[q]=${'a'.repeat(201)}`,
      'filter[lang]=not a tag',
      'filter[colour]=red',
      'sort=id',
    ]) {
      const res = await t.get(`/terms?${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      expect(errors(res.body)[0]?.code).toMatch(
        /^(invalid|unsupported)-parameter$/,
      );
    }
  });
});

describe('GET /terms/:termId', () => {
  it('reads one term', async () => {
    t.actAs(READER);
    const res = await t.get('/terms/power-pack');
    expect(res.status).toBe(200);
    expect(TermDocument.parse(res.body).data).toEqual({
      type: 'Term',
      id: 'power-pack',
      attributes: {
        schemaVersion: 1,
        status: 'deprecated',
        domain: 'power',
        replacedBy: 'battery',
        languages: {
          en: {
            preferred: 'power pack',
            allowed: [],
            forbidden: [],
            definition: [
              { type: 'text', text: 'An older name for the battery.' },
            ],
          },
        },
      },
      meta: { issues: [], usage: { modules: 0 }, linkedIn: [] },
    });
    // The sample's storage module links the charger (#245).
    const charger = TermDocument.parse((await t.get('/terms/charger')).body);
    expect(charger.data.meta).toMatchObject({
      usage: { modules: 1 },
      linkedIn: [{ moduleId: 'storage', lang: 'en', title: 'Storage' }],
    });
  });

  it('is 404 for no term, 422 for a file that is no term, 400 for no term ID', async () => {
    t.actAs(READER);
    const none = await t.get('/terms/nope');
    expect(none.status).toBe(404);
    expect(errors(none.body)[0]?.code).toBe('not-found');
    const broken = await t.get('/terms/broken');
    expect(broken.status).toBe(422);
    expect(errors(broken.body)[0]?.code).toBe('invalid-content');
    const bad = await t.get('/terms/Not_An_Id');
    expect(bad.status).toBe(400);
  });
});

describe('GET /terms/export', () => {
  it('exports TBX-Basic as a download', async () => {
    t.actAs(READER);
    const res = await t
      .get('/terms/export?format=tbx')
      .buffer(true)
      .parse((r, done) => {
        let text = '';
        r.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
        r.on('end', () => done(null, text));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe(
      'application/x-tbx+xml; charset=utf-8',
    );
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="terms.tbx"; filename*=UTF-8''terms.tbx`,
    );
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-ccms-commit']).toBe(main);
    expect(res.headers['x-ccms-terms']).toBe('4');
    const tbx = res.body as string;
    expect(tbx).toMatch(
      /^<\?xml version="1.0" encoding="UTF-8"\?>\n<tbx type="TBX-Basic" style="dca" xml:lang="en"/,
    );
    expect(tbx.match(/<conceptEntry /g)).toHaveLength(4);
    expect(tbx).toContain(
      '<ref type="crossReference" target="term-battery">battery</ref>',
    );
    expect(tbx).toContain(
      '<term>loader</term>\n            <termNote type="administrativeStatus">deprecatedTerm-admn-sts</termNote>',
    );
  });

  it('exports CSV, one row per term and language, one language when asked', async () => {
    t.actAs(READER);
    const csv = await t.get('/terms/export?format=csv');
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toBe(
      'text/csv; charset=utf-8; header=present',
    );
    const rows = csv.text.split('\r\n').filter((row) => row !== '');
    expect(rows[0]).toBe(
      'id,lang,status,domain,replacedBy,preferred,allowed,forbidden,definition,usage',
    );
    const langs = Object.entries(SAMPLE_TERMS).flatMap(([id, text]) =>
      [...text.matchAll(/^ {2}([a-z]{2}):$/gm)].map(
        ([, lang]) => `${id},${lang}`,
      ),
    );
    expect(
      rows.slice(1).map((row) => row.split(',').slice(0, 2).join(',')),
    ).toEqual(langs.sort());
    const german = await t.get('/terms/export?format=csv&lang=de');
    expect(german.headers['content-disposition']).toContain(
      'filename="terms-de.csv"',
    );
    expect(german.headers['x-ccms-terms']).toBe('2');
    expect(german.text.split('\r\n').filter((r) => r !== '')).toHaveLength(3);
  });

  it('refuses no format, an unknown one and unsupported parameters, as JSON:API errors', async () => {
    t.actAs(READER);
    for (const query of [
      '',
      '?format=xlsx',
      '?format=csv&lang=not a tag',
      '?format=csv&page[size]=2',
    ]) {
      const res = await t.get(`/terms/export${query}`);
      expect([query, res.status]).toEqual([query, 400]);
      expect(res.headers['content-type']).toBe(JSON_API);
      expect(errors(res.body)[0]?.code).toMatch(
        /^(invalid|unsupported)-parameter$/,
      );
    }
  });

  it('names an unsupported bracketed parameter in full', async () => {
    t.actAs(READER);
    const res = await t.get('/terms/export?format=csv&filter[lang]=de');
    expect(res.status).toBe(400);
    expect(errors(res.body)).toEqual([
      expect.objectContaining({
        code: 'unsupported-parameter',
        source: { parameter: 'filter[lang]' },
      }),
    ]);
  });
});

describe('GET /search with terms', () => {
  it('finds a term by its definition’s words', async () => {
    t.actAs(READER);
    const res = await t.get(
      `/search?filter[q]=${encodeURIComponent('rechargeable energy')}`,
    );
    expect(res.status).toBe(200);
    const page = SearchPageDocument.parse(res.body);
    expect(page.data).toEqual([
      {
        type: 'SearchResult',
        id: 'term:en/battery',
        attributes: {
          resourceType: 'Term',
          resourceId: 'battery',
          lang: 'en',
          title: 'battery',
        },
        relationships: { resource: { data: { type: 'Term', id: 'battery' } } },
        meta: {
          matchedOn: 'text',
          deprecated: false,
          excerpt: 'The rechargeable energy store that powers the vehicle.',
          matches: [
            { start: 4, end: 16 },
            { start: 17, end: 23 },
          ],
        },
      },
    ]);
  });

  it('filters by resource type Term', async () => {
    t.actAs(READER);
    const res = await t.get(
      '/search?filter[q]=charg&filter[resourceType]=Term',
    );
    expect(res.status).toBe(200);
    const page = SearchPageDocument.parse(res.body);
    // The preferred variants first (charger, chargeur), then a definition (rechargeable).
    expect(page.data.map((hit) => hit.id)).toEqual([
      'term:en/charger',
      'term:fr/charger',
      'term:en/battery',
    ]);
  });
});

describe('terms edited in a change set', () => {
  it('reads the change set’s term at its branch, with its definition', async () => {
    const editor: Actor = {
      ...actorWith(['content.read', 'content.read.draft', 'content.edit']),
      id: 'terms-editor',
    };
    t.actAs(editor);
    const created = await t.post('/change-sets').send(
      JSON.stringify({
        data: { type: 'ChangeSet', attributes: { title: 'Terms' } },
      }),
    );
    expect(created.status).toBe(201);
    const changeSet = ChangeSetDocument.parse(created.body).data;
    const lock = await t.post(`/change-sets/${changeSet.id}/locks`).send(
      JSON.stringify({
        data: {
          type: 'Lock',
          attributes: { subject: { type: 'term', termId: 'cable' } },
        },
      }),
    );
    expect(lock.status).toBe(201);
    const saved = await t
      .put(`/change-sets/${changeSet.id}/terms/cable/working-copy`)
      .send(
        JSON.stringify({
          data: {
            type: 'WorkingCopy',
            attributes: {
              content: {
                schemaVersion: 1,
                id: 'cable',
                status: 'proposed',
                languages: {
                  en: {
                    preferred: 'cable',
                    definition: [
                      { type: 'text', text: 'A ' },
                      {
                        type: 'text',
                        text: 'wire',
                        marks: [{ type: 'emphasis' }],
                      },
                      { type: 'text', text: ' with a plug.' },
                    ],
                  },
                },
              },
            },
          },
          meta: { version: 0, baseCommit: changeSet.attributes.baseCommit },
        }),
      );
    expect(saved.status).toBe(200);
    expect((await t.post(`/change-sets/${changeSet.id}/commits`)).status).toBe(
      201,
    );
    const branch = `change-sets/${changeSet.id}`;
    expect(git('show', `${branch}:terms/cable.yaml`)).toContain(
      'definition: A __wire__ with a plug.',
    );
    const read = await t.get(`/terms/cable?ref=${encodeURIComponent(branch)}`);
    expect(read.status).toBe(200);
    expect(
      TermDocument.parse(read.body).data.attributes.languages['en']?.definition,
    ).toEqual([
      { type: 'text', text: 'A ' },
      { type: 'text', text: 'wire', marks: [{ type: 'emphasis' }] },
      { type: 'text', text: ' with a plug.' },
    ]);
    // Not on main until merged.
    t.actAs(READER);
    expect((await t.get('/terms/cable')).status).toBe(404);
  });
});
